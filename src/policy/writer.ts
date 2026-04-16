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
import { validatePolicyObject, ROLE_NAME_PATTERN } from "./validator.js";

export interface PolicyFiles {
  constitution: Record<string, unknown>;
  governance: Record<string, unknown>;
  roles: Record<string, Record<string, unknown>>;
  ledger: Record<string, unknown>;
}

/**
 * Structured record of what writePolicy did to each path. Used by the
 * init command for the on-screen summary, and serialized into the
 * session transcript so the audit record is accurate about which files
 * were new vs overwritten vs removed.
 */
export type WriteStatus =
  | "created"
  | "updated"
  | "deleted"
  | "unchanged"
  | "skipped";

export interface WriteOutcome {
  path: string;
  status: WriteStatus;
  /** Populated when status is "skipped" — explains why the operation didn't complete. */
  reason?: string;
}

/**
 * Error thrown when extracted policy fails schema validation. The
 * message includes each failing file with its first validation error,
 * so the caller can surface a specific reason rather than "something
 * went wrong."
 */
export class PolicyValidationError extends Error {
  readonly failures: Array<{ file: string; errors: string[] }>;
  constructor(failures: Array<{ file: string; errors: string[] }>) {
    const summary = failures
      .map((f) => `${f.file}: ${f.errors[0] ?? "invalid"}`)
      .join("; ");
    super(`Policy validation failed: ${summary}`);
    this.name = "PolicyValidationError";
    this.failures = failures;
  }
}

/**
 * Sanitize a role name before using it as a filename. The extraction
 * LLM is instructed to produce schema-compliant role names, but this
 * is the last line of defense against a response that slipped through
 * — a name like "../../etc/passwd" would escape roles/ entirely. Any
 * input that does not match ROLE_NAME_PATTERN throws rather than being
 * silently rewritten, so the caller knows extraction drifted.
 */
function sanitizedRoleFilename(roleName: string): string {
  const base = path.basename(roleName).replace(/\.json$/i, "");
  if (!ROLE_NAME_PATTERN.test(base)) {
    throw new Error(
      `Invalid role name "${roleName}" — must match ${ROLE_NAME_PATTERN}`
    );
  }
  return `${base}.json`;
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
): WriteOutcome[] {
  // Hard gate — refuse to write anything if the extracted policy
  // fails schema validation or sanity checks. Throws PolicyValidationError
  // so the caller can retry extraction or surface a specific message.
  const validationResults = validatePolicyObject(policy);
  const failures = validationResults.filter((r) => !r.valid);
  if (failures.length > 0) {
    throw new PolicyValidationError(
      failures.map((f) => ({ file: f.file, errors: f.errors }))
    );
  }

  const policyDir = path.join(projectRoot, ".agentpolicy");
  const rolesDir = path.join(policyDir, "roles");
  const stateDir = path.join(policyDir, "state");
  const sessionsDir = path.join(policyDir, "sessions");

  // Create directories
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  const outcomes: WriteOutcome[] = [];

  // Constitution
  const constitutionPath = path.join(policyDir, "constitution.json");
  const constitutionStatus: WriteStatus = fs.existsSync(constitutionPath) ? "updated" : "created";
  writeJSON(constitutionPath, policy.constitution);
  outcomes.push({ path: ".agentpolicy/constitution.json", status: constitutionStatus });

  // Governance
  const governancePath = path.join(policyDir, "governance.json");
  const governanceStatus: WriteStatus = fs.existsSync(governancePath) ? "updated" : "created";
  writeJSON(governancePath, policy.governance);
  outcomes.push({ path: ".agentpolicy/governance.json", status: governanceStatus });

  // Roles — write new/updated, then reconcile by deleting any prior
  // role file that is no longer in the extracted policy. On return
  // visits where the user removed a role, this converges the on-disk
  // state with the compiled policy instead of leaving orphan files.
  //
  // Reconciliation compares by canonical path (fs.realpathSync) rather
  // than raw filename so case-insensitive filesystems (APFS, NTFS)
  // don't delete the role we just wrote. Example: Default.json exists
  // on disk, LLM emits role "default". Our write lands on the same
  // inode (macOS keeps the stored case "Default.json") — the deletion
  // pass must recognize the two names as the same file, not two
  // different ones. Canonical-path comparison handles that correctly
  // on every platform and also collapses symlinks cleanly.
  const existingRoleFiles = fs.existsSync(rolesDir)
    ? fs.readdirSync(rolesDir).filter((f) => f.endsWith(".json"))
    : [];

  const newRoleFilenames = new Set<string>();
  const writtenCanonical = new Set<string>();
  for (const [roleName, roleData] of Object.entries(policy.roles)) {
    const filename = sanitizedRoleFilename(roleName);
    newRoleFilenames.add(filename);
    const rolePath = path.join(rolesDir, filename);
    const status: WriteStatus = fs.existsSync(rolePath) ? "updated" : "created";
    writeJSON(rolePath, roleData);
    outcomes.push({ path: `.agentpolicy/roles/${filename}`, status });
    try {
      writtenCanonical.add(fs.realpathSync.native(rolePath));
    } catch {
      // If realpath fails right after write, something's wrong with
      // the filesystem and we shouldn't risk deletions based on
      // incomplete data. Skip the whole reconciliation loop below.
    }
  }

  // Only reconcile if we successfully canonicalized every write. A
  // partial realpath view could misidentify a just-written file as
  // stale and unlink it. Fail-safe: skip cleanup this run; the next
  // aegis init will pick up the reconciliation.
  const canReconcile = writtenCanonical.size === newRoleFilenames.size;
  if (canReconcile) {
    for (const existing of existingRoleFiles) {
      const existingPath = path.join(rolesDir, existing);
      let resolved: string | null = null;
      try {
        resolved = fs.realpathSync.native(existingPath);
      } catch (err: unknown) {
        const fsErr = err as NodeJS.ErrnoException;
        if (fsErr?.code === "ENOENT") continue;
        outcomes.push({
          path: `.agentpolicy/roles/${existing}`,
          status: "skipped",
          reason: `could not resolve: ${fsErr?.message ?? "unknown"}`,
        });
        continue;
      }

      if (resolved && writtenCanonical.has(resolved)) continue;

      try {
        fs.unlinkSync(existingPath);
        outcomes.push({
          path: `.agentpolicy/roles/${existing}`,
          status: "deleted",
        });
      } catch (err: unknown) {
        const fsErr = err as NodeJS.ErrnoException;
        if (fsErr?.code === "ENOENT") continue;
        outcomes.push({
          path: `.agentpolicy/roles/${existing}`,
          status: "skipped",
          reason: `could not remove: ${fsErr?.message ?? "unknown"}`,
        });
      }
    }
  }

  // Ledger
  const ledgerPath = path.join(stateDir, "ledger.json");
  const ledgerStatus: WriteStatus = fs.existsSync(ledgerPath) ? "updated" : "created";
  writeJSON(ledgerPath, policy.ledger);
  outcomes.push({ path: ".agentpolicy/state/ledger.json", status: ledgerStatus });

  // overrides.jsonl — append-only at runtime. Created empty on first
  // visit, left untouched on subsequent runs so the runtime log is
  // preserved across aegis init invocations.
  const overridesPath = path.join(stateDir, "overrides.jsonl");
  if (fs.existsSync(overridesPath)) {
    outcomes.push({
      path: ".agentpolicy/state/overrides.jsonl",
      status: "unchanged",
    });
  } else {
    writeFileAtomic(overridesPath, "");
    outcomes.push({
      path: ".agentpolicy/state/overrides.jsonl",
      status: "created",
    });
  }

  // .mcp.json — never overwrite. If the user already has one, leave
  // it alone and report unchanged so the CLI doesn't pretend it wrote
  // a fresh file.
  const mcpConfigPath = path.join(projectRoot, ".mcp.json");
  if (fs.existsSync(mcpConfigPath)) {
    outcomes.push({ path: ".mcp.json", status: "unchanged" });
  } else {
    writeFileAtomic(mcpConfigPath, JSON.stringify(MCP_CONFIG, null, 2) + "\n");
    outcomes.push({ path: ".mcp.json", status: "created" });
  }

  return outcomes;
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

  writeFileAtomic(filePath, JSON.stringify(session, null, 2) + "\n");

  return `.agentpolicy/sessions/${filename}`;
}

/**
 * Write a file atomically via a per-process temp file and rename.
 * fs.renameSync is atomic on POSIX for same-filesystem targets, so a
 * crash between the write and the rename leaves either the old
 * contents or nothing visible under the target name — never a
 * half-written file readable by the next aegis run.
 *
 * The temp filename combines pid + high-resolution timestamp so stale
 * artifacts from a prior crashed run cannot collide with ours, and
 * the temp is opened with `wx` (exclusive create) so a symlink or
 * leftover directory at the temp path fails the write loudly instead
 * of letting the write be silently redirected. Cleanup on any error
 * removes the temp file so we don't leak artifacts across runs.
 */
function writeFileAtomic(filePath: string, data: string): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.tmp.${process.pid}.${Date.now()}`
  );
  try {
    fs.writeFileSync(tmpPath, data, { encoding: "utf-8", flag: "wx" });
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup — original error is what matters
    }
    throw err;
  }
}

function writeJSON(filePath: string, data: Record<string, unknown>): void {
  writeFileAtomic(filePath, JSON.stringify(data, null, 2) + "\n");
}
