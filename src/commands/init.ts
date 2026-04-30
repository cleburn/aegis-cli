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
import {
  writePolicy,
  writeTranscript,
  updateGitignoreEntries,
  type WriteOutcome,
} from "../policy/writer.js";
import {
  acquireLock,
  releaseLock,
  registerExitCleanup,
  registerCleanupCallback,
  LockConflictError,
} from "../policy/lock.js";
import { AegisExit } from "../abort.js";
import { TerminalUI } from "../ui/terminal.js";
import type { DiscoveryResult } from "../discovery/engine.js";

// Read version from package.json so the banner stays in sync with
// publishes. In production (`aegis` from a global install) this
// file is at `<install>/dist/src/commands/init.js`, three levels up
// from package.json. In dev (`tsx bin/aegis.ts` exercising the
// uncompiled source) it's at `<repo>/src/commands/init.ts`, two
// levels up. Try the production path first, then fall back to the
// dev path. A read failure here is non-fatal — the banner shows
// "unknown" rather than blocking init — so any I/O or parse error
// is silently swallowed.
function readVersion(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "..", "..", "package.json"),
    join(here, "..", "..", "package.json"),
  ];
  for (const pkgPath of candidates) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg && typeof pkg.version === "string") return pkg.version;
    } catch {
      // Try next candidate
    }
  }
  return "unknown";
}

export async function initCommand(): Promise<void> {
  const ui = new TerminalUI();
  const version = readVersion();
  const cwd = process.cwd();

  // State referenced from the finally block AND from the SIGINT
  // cleanup callback registered with lock.ts. Both paths converge on
  // writeFinalTranscript via a once-guard so the audit record is
  // preserved exactly once regardless of which exit path fires.
  //
  // policyWriteSucceeded gates the closing-entry shape: result.policy
  // is set as soon as engine.run() returns, but the success branch
  // still has to call writePolicy + side effects. If anything in
  // that branch throws (PolicyValidationError, fs error, gitignore
  // failure surfaced as throw), the transcript must NOT record the
  // session as a successful write — buildTranscriptEntries falls
  // back to a "write_failed" closing shape that names the actual
  // failure instead of falsely reporting success.
  let lockPath: string | null = null;
  let engine: DiscoveryEngine | null = null;
  let result: DiscoveryResult | null = null;
  let fileOutcomes: WriteOutcome[] = [];
  let extractionFailed = false;
  let policyWriteSucceeded = false;
  let policyWriteError: Error | null = null;
  let transcriptWritten = false;

  // Persist the session transcript wherever we are when this fires.
  // Callable from three points:
  //   1. The end of the success path (now triggered via finally).
  //   2. The SIGINT / SIGTERM / 'exit' cleanup chain in lock.ts,
  //      which would otherwise bypass initCommand's own finally
  //      (the signal handler calls process.exit synchronously, so
  //      the awaited code never resumes).
  //   3. Any caught exception path that flows through finally.
  // First call wins; later calls no-op via the once-guard. That
  // means a Ctrl+C mid-conversation captures the partial transcript
  // before initCommand's finally block has any chance to run, and
  // a normal completion captures the full transcript through the
  // finally path while the cleanup callback later no-ops.
  const writeFinalTranscript = (): void => {
    if (transcriptWritten || !engine) return;
    transcriptWritten = true;
    try {
      const entries = buildTranscriptEntries(
        engine,
        result,
        fileOutcomes,
        policyWriteSucceeded,
        policyWriteError
      );
      const transcriptPath = writeTranscript(cwd, entries);
      try {
        ui.showNote(`Session transcript saved: ${transcriptPath}`);
      } catch {
        // UI may already be torn down (signal-handler path) — the
        // file write itself is the load-bearing part.
      }
    } catch {
      // Best-effort. A failed transcript write must not strand the
      // lock or mask the original exit reason; downstream forensic
      // passes lose this session but the next run still works.
    }
  };

  // Acquire the per-project lock before any interactive work, so a
  // user who fires a second aegis init in the same repo sees a clear
  // conflict message rather than two scans clobbering each other.
  // Register the exit-cleanup hook immediately so a deep process.exit
  // from another module cannot strand the lock on disk. The
  // transcript cleanup is registered AFTER the engine is constructed
  // (writeFinalTranscript no-ops on engine === null until then).
  try {
    lockPath = acquireLock(cwd);
    registerExitCleanup(lockPath);
    registerCleanupCallback(writeFinalTranscript);
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

    // Validate API key quietly. The provider distinguishes auth
    // failure (the API rejected the key) from transport failure
    // (network unreachable, 5xx, rate limit, timeout) so the
    // user-facing error names the actual cause: a rejected key
    // sends them back to re-enter, a transport failure tells them
    // it's likely not their key. The previous code conflated the
    // two and always blamed the key, which was wrong about half
    // the time.
    const validation = await provider.validate();
    if (!validation.ok) {
      if (validation.reason === "auth") {
        throw new AegisExit(
          1,
          "Anthropic rejected that API key as invalid. Check that you copied it correctly and try again."
        );
      }
      throw new AegisExit(
        1,
        `Couldn't reach the Anthropic API to verify your key${
          validation.detail ? ` (${validation.detail})` : ""
        }. This is likely a network issue, not your key — try again in a minute.`
      );
    }

    // Scan the repo quietly — Aegis does his homework before the meeting
    const scan = await scanRepo(cwd);

    // First-time init: play the full intro sequence
    // Return visit (usable baseline on disk): quiet welcome
    //
    // Gate on hasUsableBaseline rather than hasExistingPolicy so a
    // stray empty `.agentpolicy/` directory (left by a Ctrl+C during
    // API-key resolution on a prior aborted init, or by a mid-write
    // failure of writePolicy) does not greet the user as a return
    // visitor. The full intro plays whenever the on-disk state is
    // not actually a usable starting point — partial baselines, empty
    // dirs, malformed JSON all route through here instead of the
    // return-visit welcome.
    if (scan.hasUsableBaseline) {
      ui.showWelcome(version);
    } else {
      await ui.playIntro(version);
    }

    // Run the conversation — this is the whole thing
    engine = new DiscoveryEngine(provider, scan, ui);

    result = await engine.run();

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
    if (result.status === "completed" && result.policy) {
      // Capture writePolicy failure so the closing transcript entry
      // reports write_failed instead of falsely claiming success.
      // Re-throw so the outer catch surfaces the user-facing error
      // message and sets process.exitCode — the flag exists only to
      // gate the audit-trail shape, not to swallow the exception.
      try {
        fileOutcomes = writePolicy(cwd, result.policy);
        policyWriteSucceeded = true;
      } catch (err) {
        policyWriteError =
          err instanceof Error ? err : new Error(String(err));
        throw err;
      }

      // Apply the .gitignore side effect ONLY if the engine recorded
      // an affirmed [GITIGNORE_CONSENT] marker during discovery. The
      // paths themselves are hardcoded to the Aegis-sanctioned set —
      // the LLM cannot influence which paths get written, only
      // whether anything gets written at all (and that decision is
      // cross-checked against the user's conversation turns by the
      // engine's affirmation gate, not taken on faith from the
      // extraction output).
      if (engine.getGitignoreConsent()) {
        const outcome = updateGitignoreEntries(cwd, [
          ".agentpolicy/sessions/",
          ".agentpolicy/state/overrides.jsonl",
        ]);
        if (outcome) fileOutcomes.push(outcome);
      }

      ui.showFilesCreated(formatOutcomes(fileOutcomes));
      ui.showNote(`Policy in place at ${cwd}/.agentpolicy/`);
      showNextSteps(ui, result.policy, fileOutcomes);
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
    // Persist the transcript FIRST so an exception during writePolicy,
    // a Ctrl+C during the post-completion loop, or any caught error
    // above does not lose the audit record. The cleanup callback
    // registered with lock.ts will fire on the SIGINT / SIGTERM /
    // 'exit' paths that bypass this finally block; the once-guard
    // makes the second call a no-op so the transcript is written
    // exactly once. Lock release happens AFTER the transcript write
    // so the rmdir-on-release of .agentpolicy/ correctly fails with
    // ENOTEMPTY (sessions/ now holds the new transcript) and leaves
    // the directory in place.
    writeFinalTranscript();
    if (lockPath) releaseLock(lockPath);
    await ui.destroy();
  }
}

/**
 * Build the array of transcript entries to persist for the session.
 * The base is the engine's live conversation (every user/assistant
 * turn captured during discovery and post-completion). On top of
 * that, append a closing-system entry whose shape reflects how the
 * session actually ended — successful policy write, no-change
 * confirmation, extraction failure, write failure, or incomplete
 * (the engine never reached a terminal status, typically a Ctrl+C
 * or an exception during discovery).
 *
 * The closing entry exists so a forensic pass can read a transcript
 * standalone and tell what happened without re-running the session.
 * For successful sessions it carries the handoff prompt and
 * deployment_intent the writer used; for failures it carries the
 * specific failure category; for incomplete sessions it just marks
 * that the session did not conclude normally — the conversation
 * itself is the record.
 *
 * The success entry is gated on policyWriteSucceeded, not just
 * result.policy: result.policy is set as soon as engine.run() emits
 * a valid policy, but the success branch in initCommand still has
 * to call writePolicy + side effects after that, and any throw
 * along the way must NOT result in a closing entry that claims the
 * session succeeded. policyWriteSucceeded flips to true only after
 * writePolicy returns; any earlier exit through this function on a
 * result with policy assigned routes through the write_failed shape
 * and carries the captured error message for forensic context.
 */
function buildTranscriptEntries(
  engine: DiscoveryEngine,
  result: DiscoveryResult | null,
  fileOutcomes: WriteOutcome[],
  policyWriteSucceeded: boolean,
  policyWriteError: Error | null
): Array<{ role: string; content: string }> {
  const entries: Array<{ role: string; content: string }> = [
    ...engine.getTranscript(),
  ];

  if (result?.policy && policyWriteSucceeded) {
    entries.push({
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
  } else if (result?.policy) {
    // Extraction emitted a valid policy, but writePolicy threw or
    // the success branch did not reach the policyWriteSucceeded
    // flip. Capture the error message (bounded to keep the
    // transcript compact) so the audit record names what actually
    // failed instead of falsely claiming success. handoff_prompt
    // and deployment_intent are intentionally omitted — they
    // describe a state that did not land on disk.
    entries.push({
      role: "system",
      content: JSON.stringify({
        type: "session_closing",
        outcome: "write_failed",
        write_error: policyWriteError
          ? policyWriteError.message.slice(0, 500)
          : "writePolicy did not complete; specific error not captured",
      }, null, 2),
    });
  } else if (result?.extractionFailure) {
    // Failed-extraction sessions get a parallel closing entry so
    // the saved transcript carries the specific failure category
    // and detail. Without this, the next forensic pass would have
    // to reproduce the failure to learn what went wrong — and the
    // failure is by definition non-deterministic in some cases
    // (transport errors, model output drift). Capturing it here
    // makes "what failed" answerable from the transcript alone.
    // Mutually exclusive with the result.policy branch above:
    // extractionFailure is only populated when policy is null.
    entries.push({
      role: "system",
      content: JSON.stringify({
        type: "session_closing",
        extraction_failure: result.extractionFailure,
      }, null, 2),
    });
  } else if (result?.status === "no_changes") {
    // No-change sessions wrote no policy; the closing entry just
    // notes the outcome so a forensic pass can distinguish a
    // legitimate no-change conclusion from an incomplete session.
    entries.push({
      role: "system",
      content: JSON.stringify({
        type: "session_closing",
        outcome: "no_changes",
      }, null, 2),
    });
  } else {
    // Engine never reached a terminal status — Ctrl+C
    // mid-conversation, exception during discovery or
    // post-completion, error before result was assigned. The
    // transcript itself is the audit record; the closing entry
    // marks "did not conclude normally" so future inspection
    // doesn't mistake an aborted session for a missing closing.
    entries.push({
      role: "system",
      content: JSON.stringify({
        type: "session_closing",
        outcome: "incomplete",
      }, null, 2),
    });
  }

  return entries;
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
  policy: NonNullable<import("../discovery/engine.js").DiscoveryResult["policy"]>,
  outcomes: WriteOutcome[]
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
  //
  // Branch on the actual .mcp.json write outcome so the user-facing
  // copy matches what landed (or didn't) on disk:
  //
  //   created   — fresh .mcp.json, aegis-mcp connection set up.
  //   updated   — existing .mcp.json had other servers; the aegis-mcp
  //               entry was merged in alongside them.
  //   unchanged — existing .mcp.json already had an aegis entry; left
  //               in place to preserve any user customization.
  //   skipped   — existing .mcp.json was malformed or unexpectedly
  //               shaped; refused to clobber. Show the snippet the
  //               user needs to paste under their mcpServers key.
  //
  // The npm package name (`aegis-mcp-server`) is the registry target;
  // the bin command it provides is `aegis-mcp`, which is also the
  // mcpServers key in the generated config. Lean on `aegis-mcp` in
  // prose so the relationship between the package and the runtime
  // command is visible — the install command itself stays
  // `aegis-mcp-server`.
  ui.showHeading(`── MCP ──`);

  const mcpOutcome = outcomes.find((o) => o.path === ".mcp.json");
  switch (mcpOutcome?.status) {
    case "created":
      ui.showNote(
        `.mcp.json was created with the aegis-mcp connection. Install the aegis-mcp server if you haven't:`
      );
      break;
    case "updated":
      ui.showNote(
        `aegis-mcp connection merged into your existing .mcp.json. Install the aegis-mcp server if you haven't:`
      );
      break;
    case "unchanged":
      ui.showNote(
        `.mcp.json already had the aegis-mcp connection — no change needed. Install the aegis-mcp server if you haven't:`
      );
      break;
    case "skipped":
      // Generic prefix that fits all skip reasons — parse failure,
      // unexpected top-level shape, unexpected mcpServers value,
      // and the non-canonical-command case (where the user's setup
      // may already be working). The reason text carries the
      // specific situation; the snippet is shown as a reference,
      // not an instruction to overwrite a working entry.
      ui.showNote(
        `Aegis didn't update your existing .mcp.json — ${mcpOutcome.reason ?? "unknown reason"}. Standard entry to paste under "mcpServers" if you need it:`
      );
      ui.showHighlight(
        `"aegis": { "command": "aegis-mcp", "args": ["--project", "."] }`
      );
      ui.showNote(`Then install the aegis-mcp server if you haven't:`);
      break;
    default:
      // Fallback when no .mcp.json outcome reached this point —
      // shouldn't happen on a successful write but keeps the
      // closing functional rather than rendering nothing.
      ui.showNote(`Install the aegis-mcp server if you haven't:`);
  }

  ui.showCommand(`npm install -g aegis-mcp-server`);

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
