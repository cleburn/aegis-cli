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

      // ── Next Steps ───────────────────────────────────────────────
      showNextSteps(ui, result.policy);
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

/**
 * Display context-aware next steps based on deployment intent.
 *
 * The deployment_intent was determined by Aegis during the discovery
 * conversation — either from explicit user statement, Aegis's recommendation,
 * or inference from the project state and roles defined.
 *
 * Shows the recommended prompt first, then alternatives, then the MCP block.
 */
function showNextSteps(
  ui: TerminalUI,
  policy: NonNullable<import("../discovery/engine.js").DiscoveryResult["policy"]>
): void {
  const intent = policy.deployment_intent;
  const roleNames = Object.keys(policy.roles).filter(r => r !== "default");

  ui.showNote(`── Next Steps ──`);

  // ── Recommended prompt based on deployment intent ─────────────
  if (intent === "build_multi") {
    ui.showNote(
      `Your project has ${roleNames.length} specialist roles (${roleNames.join(", ")}). To build the full project with a governed agent team, start your agent session with this prompt:`
    );
    ui.showNote(
      `"Read the .agentpolicy/ directory — constitution, governance, all role files, and the ledger. You are managing a full agent team: ${roleNames.join(", ")}. Deploy them according to their role definitions. The goal is to implement the full project from the existing skeleton. Each agent works within its scope, follows the governance rules, logs to the ledger, and coordinates through the ledger as the handoff protocol. Start with the roles whose output other roles depend on."`
    );
  } else if (intent === "build_single") {
    ui.showNote(
      `To build the project with a governed agent, start your agent session with this prompt:`
    );
    ui.showNote(
      `"Read the .agentpolicy/ directory and any project documentation. Build the complete project according to the governance policy. Every decision you make should come from the policy files. When you're done, make sure everything passes the quality gate defined in governance.json."`
    );
  } else {
    // "govern" — existing project getting governance added
    ui.showNote(
      `To work on this project with a governed agent, start your agent session with this prompt:`
    );
    ui.showNote(
      `"Read .agentpolicy/constitution.json, .agentpolicy/governance.json, and your assigned role file in .agentpolicy/roles/. These are your governance policies — follow them absolutely. Do not take any action until you understand your boundaries."`
    );
  }

  // ── Alternative prompts ──────────────────────────────────────────
  ui.showNote(`── Alternative Approaches ──`);

  if (intent !== "govern") {
    ui.showNote(
      `If your project is already built and you just need governed agents working within it:`
    );
    ui.showNote(
      `"Read .agentpolicy/constitution.json, .agentpolicy/governance.json, and your assigned role file in .agentpolicy/roles/. These are your governance policies — follow them absolutely. Do not take any action until you understand your boundaries."`
    );
  }

  if (intent !== "build_single" && roleNames.length === 0) {
    ui.showNote(
      `If you want a single agent to build the project from scratch:`
    );
    ui.showNote(
      `"Read the .agentpolicy/ directory and any project documentation. Build the complete project according to the governance policy. Every decision you make should come from the policy files. When you're done, make sure everything passes the quality gate defined in governance.json."`
    );
  }

  if (intent !== "build_multi" && roleNames.length > 0) {
    ui.showNote(
      `If you want to deploy your ${roleNames.length} specialist roles (${roleNames.join(", ")}) as a full agent team:`
    );
    ui.showNote(
      `"Read the .agentpolicy/ directory — constitution, governance, all role files, and the ledger. You are managing a full agent team: ${roleNames.join(", ")}. Deploy them according to their role definitions. Each agent works within its scope, follows the governance rules, logs to the ledger, and coordinates through the ledger as the handoff protocol."`
    );
  }

  // ── MCP recommendation ───────────────────────────────────────────
  ui.showNote(`── Runtime Enforcement ──`);
  ui.showNote(
    `For runtime enforcement, install the Aegis MCP server:`
  );
  ui.showNote(
    `npm install -g aegis-mcp-server`
  );
  ui.showNote(
    `The MCP validates every write, delete, and execute against your policy at runtime — zero token overhead, full audit trail. The connection config (.mcp.json) is already in place — just install and go.`
  );
  ui.showNote(
    `If you use the MCP, start with this prompt instead of any of the above:`
  );
  ui.showNote(
    `"Call aegis_policy_summary now. This is your governance contract — it defines your role, your boundaries, and which tools to use. Do not read files, do not take any action, and do not assume your role until you have called this tool."`
  );
}
