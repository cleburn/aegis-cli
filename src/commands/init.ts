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
import { writePolicy, writeTranscript } from "../policy/writer.js";
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

  try {
    // Resolve API key (this may prompt interactively — that's fine,
    // it's a one-time setup moment, not a recurring UI pattern)
    const apiKey = await resolveApiKey();
    const provider = new AnthropicProvider(apiKey);

    // Validate API key quietly
    const valid = await provider.validate();
    if (!valid) {
      ui.showError(
        "Couldn't connect with that API key. Check that it's valid and try again."
      );
      process.exit(1);
    }

    // Scan the repo quietly — Aegis does his homework before the meeting
    const cwd = process.cwd();
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

    // Write policy if changes were made — skip if conversation
    // concluded with no modifications needed
    let filesCreated: string[] = [];
    if (result.policy) {
      filesCreated = writePolicy(cwd, result.policy);

      ui.showFilesCreated(filesCreated);
      ui.showNote(`Policy in place at ${cwd}/.agentpolicy/`);

      // ── Next Steps ───────────────────────────────────────────────
      showNextSteps(ui, result.policy);
    }

    // ── Post-completion loop ────────────────────────────────────────
    //
    // The session stays open after extraction. The user can ask
    // follow-up questions, spot issues, or just discuss what was
    // produced. Policy edits require a new `aegis init` — Aegis
    // explains this when asked. The session ends when the user types
    // /exit, /quit, or /done.
    await runPostCompletionLoop(ui, engine);

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
          files_created: filesCreated,
          policy_path: `${cwd}/.agentpolicy/`,
          handoff_prompt: result.policy.handoff_prompt,
          deployment_intent: result.policy.deployment_intent,
          mcp_install: "npm install -g aegis-mcp-server",
          future_session_prompt: "Call aegis_policy_summary now. This is your governance contract — it defines your role, your boundaries, and which tools to use. Do not take any action until you have called this tool and received confirmation from the user to proceed.",
        }, null, 2),
      });
    }

    const transcriptPath = writeTranscript(cwd, transcriptEntries);
    ui.showNote(`Session transcript saved: ${transcriptPath}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes("SIGINT")) {
      console.log("\n");
      ui.showNote("Interrupted. Run aegis init again anytime.");
      process.exit(0);
    }
    ui.showError(
      error instanceof Error ? error.message : "Something went wrong."
    );
    process.exit(1);
  } finally {
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
  engine: DiscoveryEngine
): Promise<void> {
  ui.showNote(
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

    await engine.continueConversation(input);
  }
}
