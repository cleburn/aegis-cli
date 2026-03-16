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

import { resolveApiKey } from "../config/api-key.js";
import { AnthropicProvider } from "../llm/anthropic.js";
import { scanRepo } from "../discovery/scanner.js";
import { DiscoveryEngine } from "../discovery/engine.js";
import { writePolicy } from "../policy/writer.js";
import { loadMemory, pruneMemory, saveMemory, getProjectMemory } from "../memory/store.js";
import { TerminalUI } from "../ui/terminal.js";

export async function initCommand(): Promise<void> {
  const ui = new TerminalUI();

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

    // Load and prune memory
    let memory = loadMemory();
    memory = pruneMemory(memory);
    saveMemory(memory);
    const projectMemory = getProjectMemory(memory, scan.projectName);
    const hasMemory = Object.keys(projectMemory).length > 0;

    // First-time init: play the full intro sequence
    // Return visit (existing policy OR memory): quiet welcome
    if (scan.hasExistingPolicy || hasMemory) {
      ui.showWelcome();
    } else {
      await ui.playIntro();
    }

    // Run the conversation — this is the whole thing
    const engine = new DiscoveryEngine(
      provider,
      scan,
      hasMemory ? projectMemory : null,
      ui
    );

    const result = await engine.run();

    // Write policy if changes were made — skip if conversation
    // concluded with no modifications needed
    if (result.policy) {
      const files = writePolicy(cwd, result.policy);
      ui.showFilesCreated(files);
      ui.showNote(`Policy in place at ${cwd}/.agentpolicy/`);

      // ── Agent onboarding guidance ────────────────────────────────
      ui.showNote(
        `Before your first prompt to any AI agent, start with this:`
      );
      ui.showNote(
        `"Read the .agentpolicy/ directory in this project. These are your governance policies — follow them absolutely. Begin by calling aegis_policy_summary if an Aegis MCP server is connected, or by reading .agentpolicy/constitution.json and .agentpolicy/governance.json, then your assigned role file. Do not take any action until you understand your boundaries."`
      );

      // ── MCP recommendation ───────────────────────────────────────
      ui.showNote(
        `For runtime enforcement, install the Aegis MCP server:`
      );
      ui.showNote(
        `npm install -g aegis-mcp-server`
      );
      ui.showNote(
        `The MCP validates every write, delete, and execute against your policy at runtime — zero token overhead, full audit trail. Highly recommended for regulated or governed projects.`
      );
    }
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
