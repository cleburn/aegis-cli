/**
 * aegis init
 *
 * The main event. Scans the repo, starts a discovery conversation
 * with the human, and produces the .agentpolicy/ directory.
 *
 * First-time: Logo wordmark → conversation → files appear.
 * Return visit: Short opener → conversation → files updated (or unchanged).
 *
 * The scan happens quietly before the first message. The policy
 * gets written quietly after the last one. In between, it's
 * Aegis at work.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { resolveApiKey } from "../config/api-key.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { scanRepo } from "../discovery/scanner.js";
import { DiscoveryEngine } from "../discovery/engine.js";
import { writePolicy, writeTranscript, type WriteOutcome } from "../policy/writer.js";
import {
  acquireLock,
  releaseLock,
  registerExitCleanup,
  LockConflictError,
} from "../policy/lock.js";
import { AegisExit } from "../abort.js";
import { TerminalUI } from "../ui/terminal.js";

// Read version from package.json so the banner stays in sync with publishes.
function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/src/commands/init.js → walk up to package.json
    const pkgPath = join(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

export async function initCommand(): Promise<void> {
  const ui = new TerminalUI();
  const version = readVersion();
  const cwd = process.cwd();

  // Acquire the per-project lock before any interactive work, so a
  // user who fires a second aegis init in the same repo sees a clear
  // conflict message rather than two scans clobbering each other.
  // Register the exit-cleanup hook immediately so a deep process.exit
  // from another module cannot strand the lock on disk.
  let lockPath: string | null = null;
  try {
    lockPath = acquireLock(cwd);
    registerExitCleanup(lockPath);
  } catch (err) {
    if (err instanceof LockConflictError) {
      throw new AegisExit(1, err.message);
    }
    throw err;
  }

  try {
    // Resolve API key (this may prompt interactively — that's fine,
    // it's a one-time setup moment, not a recurring UI pattern)
    const apiKey = await resolveApiKey();
    const provider = new AnthropicProvider(apiKey);

    // Validate API key quietly
    const valid = await provider.validate();
    if (!valid) {
      throw new AegisExit(
        1,
        "Couldn't connect with that API key. Check that it's valid and try again."
      );
    }

    // Scan the repo quietly — Aegis does his homework before the meeting
    const scan = await scanRepo(cwd);

    // First-time init: play the full intro sequence
    // Return visit (existing policy or prior sessions): quiet welcome
    if (scan.hasExistingPolicy) {
      ui.showWelcome(version);
    } else {
      await ui.playIntro(version);
    }

    // Run the conversation — this is the whole thing
    const engine = new DiscoveryEngine(provider, scan, ui);

    const result = await engine.run();

    // Branch on how discovery concluded:
    //
    // - "completed": user affirmed changes AND extraction produced a
    //   valid policy. Write files, show handoff, enter post-completion.
    // - "no_changes": user affirmed nothing needs to change. No files
    //   written. Post-completion runs with a different system prompt
    //   so Aegis doesn't claim files were written that weren't.
    // - "extraction_failed": user affirmed changes but extraction
    //   returned null after retries. Do NOT enter post-completion —
    //   its prompt would tell Aegis "extraction has just completed"
    //   and the user would get a session that lies about what
    //   happened. Surface the error and fall through to transcript
    //   write + non-zero exit.
    let fileOutcomes: WriteOutcome[] = [];
    let extractionFailed = false;

    if (result.status === "completed" && result.policy) {
      fileOutcomes = writePolicy(cwd, result.policy);
      ui.showFilesCreated(formatOutcomes(fileOutcomes));
      ui.showNote(`Policy in place at ${cwd}/.agentpolicy/`);
      showNextSteps(ui, result.policy);
      await runPostCompletionLoop(ui, engine, "completed");
    } else if (result.status === "no_changes") {
      await runPostCompletionLoop(ui, engine, "no_changes");
    } else {
      // status === "extraction_failed" — error was already surfaced by
      // extractPolicy via ui.showError. Skip post-completion entirely;
      // the session is not a success and should not pretend to be one.
      extractionFailed = true;
      ui.showNote(
        "Session transcript will still be saved for reference. Run aegis init again when you're ready to retry."
      );
    }

    // ── Final transcript write ──────────────────────────────────────
    //
    // One file per session, written at session end so it captures
    // the full conversation including post-completion turns.
    const finalTranscript = engine.getTranscript();
    const transcriptEntries: Array<{ role: string; content: string }> = [
      ...finalTranscript,
    ];

    if (result.policy) {
      transcriptEntries.push({
        role: "system",
        content: JSON.stringify({
          type: "session_closing",
          files: fileOutcomes,
          // Use the project-relative path so the absolute filesystem
          // location — which embeds the user's home directory — never
          // lands in the transcript (which gets re-read into the
          // discovery prompt on return visits).
          policy_path: ".agentpolicy/",
          handoff_prompt: result.policy.handoff_prompt,
          deployment_intent: result.policy.deployment_intent,
          mcp_install: "npm install -g aegis-mcp-server",
          future_session_prompt: "Call aegis_policy_summary now. This is your governance contract — it defines your role, your boundaries, and which tools to use. Do not take any action until you have called this tool and received confirmation from the user to proceed.",
        }, null, 2),
      });
    }

    const transcriptPath = writeTranscript(cwd, transcriptEntries);
    ui.showNote(`Session transcript saved: ${transcriptPath}`);

    // Extraction failure surfaces as a non-zero exit after the
    // transcript is preserved, so shell callers (CI, scripts, the
    // user's shell status) see that the session didn't succeed even
    // though the audit record was captured. Use process.exitCode so
    // the finally block runs fully before the process exits — a
    // direct process.exit here would cut ui.destroy's async flush
    // short.
    if (extractionFailed) {
      process.exitCode = 1;
    }
  } catch (error) {
    // AegisExit is the typed-abort path: deep code throws it with a
    // user-facing message and an exit code, and the outer handler is
    // the single place that knows how to surface the message and
    // run cleanup. Every fatal message goes to stderr first (works
    // before Ink mounts and when Ink fails to mount) and then to
    // ui.showError as a best-effort second layer.
    if (error instanceof AegisExit) {
      if (error.userMessage) {
        process.stderr.write(`${error.userMessage}\n`);
        try {
          ui.showError(error.userMessage);
        } catch {
          // UI couldn't render — stderr already carried the message
        }
      }
      process.exitCode = error.code;
    } else if (error instanceof Error && error.message.includes("SIGINT")) {
      // Legacy SIGINT detection retained as a defensive catch for
      // libraries that throw errors with this shape. The primary
      // signal path is lock.ts's signal handlers.
      process.stderr.write("\nInterrupted. Run aegis init again anytime.\n");
      try {
        ui.showNote("Interrupted. Run aegis init again anytime.");
      } catch {
        // UI couldn't render — stderr already carried the message
      }
      process.exitCode = 0;
    } else {
      const msg = error instanceof Error ? error.message : "Something went wrong.";
      process.stderr.write(`${msg}\n`);
      try {
        ui.showError(msg);
      } catch {
        // UI couldn't render — stderr already carried the message
      }
      process.exitCode = 1;
    }
  } finally {
    // Release the lock synchronously first so it happens even if
    // ui.destroy() is cut short. Node exits with process.exitCode
    // after the event loop drains; Ink's waitUntilExit hook in
    // terminal.tsx respects process.exitCode rather than hardcoding 0.
    if (lockPath) releaseLock(lockPath);
    await ui.destroy();
  }
}

/**
 * Display context-aware next steps after policy generation.
 *
 * Three colorized blocks:
 * 1. Custom handoff prompt — blue heading, white prompt text
 * 2. MCP note — blue heading, gold install command
 * 3. Future session prompt — blue heading, white prompt text
 */
function showNextSteps(
  ui: TerminalUI,
  policy: NonNullable<import("../discovery/engine.js").DiscoveryResult["policy"]>
): void {
  // ── Custom handoff prompt ────────────────────────────────────────
  ui.showHeading(`── Your Handoff Prompt ──`);
  ui.showNote(
    `Copy this into your next agent session to get started:`
  );
  ui.showHighlight(
    `"${policy.handoff_prompt}"`
  );

  // ── MCP note ─────────────────────────────────────────────────────
  ui.showHeading(`── MCP ──`);
  ui.showNote(
    `The Aegis MCP connection (.mcp.json) is already configured. Install the server if you haven't:`
  );
  ui.showCommand(
    `npm install -g aegis-mcp-server`
  );

  // ── Future session prompt ────────────────────────────────────────
  ui.showHeading(`── For All Future Sessions ──`);
  ui.showNote(
    `Once the project is live, start every agent session with this prompt:`
  );
  ui.showHighlight(
    `"Call aegis_policy_summary now. This is your governance contract — it defines your role, your boundaries, and which tools to use. Do not take any action until you have called this tool and received confirmation from the user to proceed."`
  );
}

/**
 * After files are written (or after NO_CHANGES), keep the session open
 * so the user can ask follow-up questions or verify the output. Exits
 * when the user types /exit, /quit, or /done. Every exchange is
 * captured in the engine's transcript so the session file reflects
 * the full conversation.
 */
async function runPostCompletionLoop(
  ui: TerminalUI,
  engine: DiscoveryEngine,
  mode: "completed" | "no_changes"
): Promise<void> {
  ui.showAegisMessage(
    "If there are no more questions, type /exit to end this session. Otherwise, let me know what's on your mind."
  );

  while (true) {
    const input = await ui.getUserInput();
    const normalized = input.trim().toLowerCase();

    if (
      normalized === "/exit" ||
      normalized === "/quit" ||
      normalized === "/done"
    ) {
      ui.showNote("Session closed. See you next time.");
      return;
    }

    if (normalized === "") {
      continue;
    }

    await engine.continueConversation(input, mode);
  }
}

/**
 * Render the write outcomes as labeled display strings for the files
 * summary. Column-aligned so the path list reads cleanly regardless of
 * mix of statuses. "unchanged" rows (e.g. a pre-existing .mcp.json)
 * are shown so the user has a complete picture of what Aegis did and
 * did not touch.
 */
function formatOutcomes(outcomes: WriteOutcome[]): string[] {
  const label = (status: WriteOutcome["status"]): string => {
    switch (status) {
      case "created":
        return "created  ";
      case "updated":
        return "updated  ";
      case "deleted":
        return "deleted  ";
      case "unchanged":
        return "unchanged";
      case "skipped":
        return "skipped  ";
    }
  };
  return outcomes.map((o) => {
    const base = `${label(o.status)}  ${o.path}`;
    return o.reason ? `${base} — ${o.reason}` : base;
  });
}
