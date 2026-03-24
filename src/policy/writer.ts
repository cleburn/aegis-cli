/**
 * Policy Writer
 *
 * Takes the compiled policy from the extraction step and writes
 * it to disk as the .agentpolicy/ directory structure.
 *
 * Also writes .mcp.json to the project root (if it doesn't already exist)
 * for automatic MCP connection when the user opens an agent in the project.
 * Uses universal mode (no --role flag) so the agent selects its role at runtime.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export interface PolicyFiles {
  constitution: Record<string, unknown>;
  governance: Record<string, unknown>;
  roles: Record<string, Record<string, unknown>>;
  ledger: Record<string, unknown>;
}

/**
 * The universal MCP config. No --role flag — the MCP presents
 * available roles at runtime and the user picks.
 */
const MCP_CONFIG = {
  mcpServers: {
    aegis: {
      command: "aegis-mcp",
      args: ["--project", "."],
    },
  },
};

/**
 * Write the complete .agentpolicy/ directory to disk.
 * Also writes .mcp.json to the project root for MCP auto-connection.
 * Returns the list of files created.
 */
export function writePolicy(
  projectRoot: string,
  policy: PolicyFiles
): string[] {
  const policyDir = path.join(projectRoot, ".agentpolicy");
  const rolesDir = path.join(policyDir, "roles");
  const stateDir = path.join(policyDir, "state");
  const sessionsDir = path.join(policyDir, "sessions");

  // Create directories
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  const written: string[] = [];

  // Write constitution
  const constitutionPath = path.join(policyDir, "constitution.json");
  writeJSON(constitutionPath, policy.constitution);
  written.push(".agentpolicy/constitution.json");

  // Write governance
  const governancePath = path.join(policyDir, "governance.json");
  writeJSON(governancePath, policy.governance);
  written.push(".agentpolicy/governance.json");

  // Write roles
  for (const [roleName, roleData] of Object.entries(policy.roles)) {
    const rolePath = path.join(rolesDir, `${roleName}.json`);
    writeJSON(rolePath, roleData);
    written.push(`.agentpolicy/roles/${roleName}.json`);
  }

  // Write ledger
  const ledgerPath = path.join(stateDir, "ledger.json");
  writeJSON(ledgerPath, policy.ledger);
  written.push(".agentpolicy/state/ledger.json");

  // Create empty overrides log (append-only, populated at runtime)
  const overridesPath = path.join(stateDir, "overrides.jsonl");
  if (!fs.existsSync(overridesPath)) {
    fs.writeFileSync(overridesPath, "", "utf-8");
  }
  written.push(".agentpolicy/state/overrides.jsonl");

  // Write .mcp.json to project root (only if it doesn't already exist)
  const mcpConfigPath = path.join(projectRoot, ".mcp.json");
  if (!fs.existsSync(mcpConfigPath)) {
    fs.writeFileSync(
      mcpConfigPath,
      JSON.stringify(MCP_CONFIG, null, 2) + "\n",
      "utf-8"
    );
    written.push(".mcp.json");
  }

  return written;
}

/**
 * Write the discovery session transcript to .agentpolicy/sessions/.
 *
 * Each session gets a timestamped file. Transcripts are append-only —
 * prior sessions are never modified. On return visits, Aegis reads
 * all prior transcripts to understand the history of governance decisions.
 *
 * Returns the relative path of the written transcript file.
 */
export function writeTranscript(
  projectRoot: string,
  transcript: Array<{ role: string; content: string }>
): string {
  const sessionsDir = path.join(projectRoot, ".agentpolicy", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const filename = `${timestamp}.json`;
  const filePath = path.join(sessionsDir, filename);

  const session = {
    timestamp: now.toISOString(),
    messages: transcript.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  };

  fs.writeFileSync(filePath, JSON.stringify(session, null, 2) + "\n", "utf-8");

  return `.agentpolicy/sessions/${filename}`;
}

function writeJSON(filePath: string, data: Record<string, unknown>): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}
