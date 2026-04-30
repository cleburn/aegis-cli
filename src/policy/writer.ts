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
import ignoreLib from "ignore";
import { validatePolicyObject } from "./validator.js";
import { ROLE_NAME_PATTERN } from "./manifest.js";

export interface PolicyFiles {
  constitution: Record<string, unknown>;
  governance: Record<string, unknown>;
  roles: Record<string, Record<string, unknown>>;
  ledger: Record<string, unknown>;
  /**
   * Explicit list of role names to delete from .agentpolicy/roles/
   * during reconciliation. Retires the prior delete-by-omission
   * semantics — a role file on disk that is in neither `roles` nor
   * `deleted_role_names` is preserved (with a warning) rather than
   * unlinked. The default role has no special protection and is
   * deletable by listing its name here like any other.
   */
  deleted_role_names?: string[];
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
  /**
   * Structured list of file basenames the outcome refers to. Used by
   * the reconciliation-aborted summary so the audit trail retains the
   * full candidate set without inlining it into the human-readable
   * `reason` string (which would bloat the terminal line and the
   * transcript payload when the list is long). Consumers that want
   * the full list read from here; display code reads `reason`.
   */
  candidates?: string[];
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
 * Classify an existing entry under .mcp.json's mcpServers.aegis.
 * Three outcomes that downstream code branches on for both
 * write-side behavior and user-facing message wording:
 *
 *   - "usable" — plain object with command === "aegis-mcp". The
 *     canonical shape; preserve any user customization to args
 *     and other fields. Maps to status: unchanged.
 *
 *   - "non-canonical-command" — plain object with a string command
 *     field that isn't "aegis-mcp". May still be a working setup
 *     (e.g. absolute path "/usr/local/bin/aegis-mcp", or a wrapper
 *     that ultimately launches aegis-mcp). The user knows whether
 *     their setup works; we refuse to clobber and tell them they
 *     can keep their custom command or replace with the standard.
 *     Maps to status: skipped with the soft "if your setup works"
 *     reason.
 *
 *   - "malformed" — null, primitives, arrays, objects without a
 *     command field, objects with a non-string command. Cannot be
 *     a working MCP server config under any reading of the spec.
 *     Maps to status: skipped with a hard "is malformed" reason.
 *     Still no clobber — the user authored that value, even if it
 *     was a typo, and we surface the problem rather than silently
 *     destroying it.
 *
 * Args are not validated for the usable case — users may legitimately
 * customize them (e.g. --project pointing at a sub-project). Other
 * fields beyond command/args (type, env, future MCP-spec additions)
 * are tolerated.
 */
type AegisEntryStatus =
  | "usable"
  | "non-canonical-command"
  | "malformed";

function classifyAegisEntry(entry: unknown): AegisEntryStatus {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return "malformed";
  }
  const e = entry as { command?: unknown };
  if (typeof e.command !== "string") {
    return "malformed";
  }
  if (e.command === "aegis-mcp") {
    return "usable";
  }
  return "non-canonical-command";
}

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

  // Roles — write new/updated role files. Role-file reconciliation
  // (executing explicit deletions from policy.deleted_role_names and
  // preserving everything else as a safety measure) is sequenced
  // AFTER all other writes — see the "Role reconciliation" block at
  // the end of this function.
  //
  // What the sequencing guarantees: reconciliation deletes never
  // run unless every preceding write returned without throwing. A
  // write failure between here and the reconciliation block aborts
  // before any delete, so role files on disk stay where they are
  // for the next aegis init to handle.
  //
  // What it does NOT guarantee: whole-policy transactional
  // atomicity. writeFileAtomic uses tmp + rename so individual file
  // writes are atomic, but a mid-sequence throw still leaves a
  // mixed state on disk — e.g. new constitution.json (already
  // landed) + old governance.json (write threw) + old roles + old
  // ledger. The sequencing eliminates only the specific worst case
  // where reconciliation ran before a later write threw, leaving
  // role files unlinked AND new policy content not fully on disk.
  // Recovery from a partial-write failure is "re-run aegis init";
  // the surviving prior content + landed new content converges
  // through the next successful run.
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

  // .mcp.json — three real cases plus a skip path:
  //
  //   - File doesn't exist: write a fresh MCP_CONFIG. status=created.
  //   - File exists, valid JSON object, has the aegis entry under
  //     mcpServers: leave it alone (user may have customized args).
  //     status=unchanged.
  //   - File exists, valid JSON object, no aegis entry: merge the
  //     aegis entry alongside whatever else is there, preserving
  //     every other top-level key and every other server entry.
  //     status=updated.
  //   - File exists but is not valid JSON (or not a JSON object):
  //     refuse to clobber. The user has SOMETHING there — possibly
  //     a half-finished hand-edit, possibly an unrelated tool's
  //     config under the same filename. Overwriting would silently
  //     destroy whatever they had. Surface as skipped with a
  //     reason; the closing UI shows the snippet they need to
  //     paste under mcpServers manually.
  //
  // Detection key is the "aegis" name under mcpServers. That matches
  // MCP_CONFIG above and the aegis-mcp bin command. Anyone who has
  // a legitimately-named-aegis entry from a prior init (or who
  // edited the file by hand) sees the unchanged path and keeps
  // their config. Anyone with a different MCP server (e.g. a
  // shared-team config with notion / linear / etc. servers) gets
  // the merge path and keeps their other entries.
  const mcpConfigPath = path.join(projectRoot, ".mcp.json");
  const mcpServerKey = "aegis";

  if (!fs.existsSync(mcpConfigPath)) {
    writeFileAtomic(
      mcpConfigPath,
      JSON.stringify(MCP_CONFIG, null, 2) + "\n"
    );
    outcomes.push({ path: ".mcp.json", status: "created" });
  } else {
    let existing: Record<string, unknown> | null = null;
    let parseError: Error | null = null;
    try {
      const raw = fs.readFileSync(mcpConfigPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch (err) {
      parseError = err instanceof Error ? err : new Error(String(err));
    }

    if (!existing) {
      const reason = parseError
        ? `the file is not valid JSON (${parseError.message.slice(0, 200)})`
        : "the file has an unexpected shape (not a JSON object)";
      outcomes.push({
        path: ".mcp.json",
        status: "skipped",
        reason,
      });
    } else if (existing.mcpServers === undefined) {
      // Top-level object exists, no mcpServers key yet — add the
      // section with our entry. Preserves any other top-level keys
      // the user has (mcpRoots, comments, future MCP extensions).
      const merged = {
        ...existing,
        mcpServers: {
          [mcpServerKey]: MCP_CONFIG.mcpServers.aegis,
        },
      };
      writeFileAtomic(
        mcpConfigPath,
        JSON.stringify(merged, null, 2) + "\n"
      );
      outcomes.push({ path: ".mcp.json", status: "updated" });
    } else if (
      existing.mcpServers === null ||
      typeof existing.mcpServers !== "object" ||
      Array.isArray(existing.mcpServers)
    ) {
      // mcpServers is present but unusable shape (string, number,
      // null, array, etc.). Refuse to clobber — silently coercing
      // to {} and re-serializing would discard whatever the user
      // had at that key. Surface as skipped with a reason naming
      // the shape problem; the closing UX shows the snippet to
      // paste manually after they fix or remove the bad value.
      outcomes.push({
        path: ".mcp.json",
        status: "skipped",
        reason: `mcpServers has an unexpected value (not a JSON object)`,
      });
    } else {
      const servers = existing.mcpServers as Record<string, unknown>;
      if (mcpServerKey in servers) {
        // Aegis key exists. Three sub-cases via classifyAegisEntry:
        //   (a) "usable" — canonical shape with command "aegis-mcp".
        //       Leave alone, preserve user customization to args.
        //   (b) "non-canonical-command" — plain object, string
        //       command, but not the canonical "aegis-mcp" value.
        //       May be a working custom install (absolute path,
        //       wrapper script). User knows whether it works;
        //       refuse to clobber, surface with soft framing.
        //   (c) "malformed" — null, primitives, arrays, objects
        //       without a string command field. Cannot plausibly
        //       work as an MCP entry. Refuse to clobber (the user
        //       authored that value, possibly via typo), surface
        //       with hard framing pointing at replacement.
        const entryStatus = classifyAegisEntry(servers[mcpServerKey]);
        if (entryStatus === "usable") {
          outcomes.push({ path: ".mcp.json", status: "unchanged" });
        } else if (entryStatus === "non-canonical-command") {
          outcomes.push({
            path: ".mcp.json",
            status: "skipped",
            reason: `the existing "aegis" entry under mcpServers has a non-standard command field — if your setup works, keep it; otherwise replace with the standard entry`,
          });
        } else {
          outcomes.push({
            path: ".mcp.json",
            status: "skipped",
            reason: `the existing "aegis" entry under mcpServers is malformed (must be an object with a string command field) — replace it with the standard entry`,
          });
        }
      } else {
        const merged = {
          ...existing,
          mcpServers: {
            ...servers,
            [mcpServerKey]: MCP_CONFIG.mcpServers.aegis,
          },
        };
        writeFileAtomic(
          mcpConfigPath,
          JSON.stringify(merged, null, 2) + "\n"
        );
        outcomes.push({ path: ".mcp.json", status: "updated" });
      }
    }
  }

  // === Role reconciliation (sequenced last) ===
  //
  // Reaching this point means every preceding write returned without
  // throwing. Reconciliation walks every role file on disk and sorts
  // each into one of three categories:
  //
  //   A. Just-written role (canonical-path matches a write we made
  //      this run) — never delete. Same file under a different name
  //      on case-insensitive filesystems counts here too.
  //
  //   B. Explicit deletion (filename matches a sanitized name from
  //      policy.deleted_role_names) — unlink. This is the ONLY path
  //      that produces a deletion. Delete-by-omission is
  //      intentionally retired: an extraction that silently drops a
  //      role from policy.roles cannot cause data loss because the
  //      omitted role does NOT match any explicit deletion entry
  //      and falls through to category C.
  //
  //   C. Neither just-written nor explicitly deleted — preserve the
  //      file and emit a "skipped" WriteOutcome plus a stderr
  //      warning. The user sees both signals and can address the
  //      orphan via a follow-up aegis init that lists it in
  //      deleted_role_names. Silent extraction drift is no longer a
  //      data-loss vector.
  //
  // Reconciliation compares by canonical path (fs.realpathSync) for
  // category A so case-insensitive filesystems (APFS, NTFS) don't
  // delete the role we just wrote. Example: Default.json exists on
  // disk, LLM emits role "default". Our write lands on the same
  // inode (macOS keeps the stored case "Default.json") — category A
  // recognizes the two names as the same file via canonical path,
  // not raw filename.
  //
  // Only reconcile if we successfully canonicalized every write. A
  // partial realpath view could misidentify a just-written file as
  // stale and unlink it. Fail-safe: skip cleanup this run; the next
  // aegis init will pick up the reconciliation. Every skipped
  // decision still produces a WriteOutcome so the audit trail is
  // complete.
  const canReconcile = writtenCanonical.size === newRoleFilenames.size;
  if (canReconcile) {
    // Build the explicit-deletion set from policy.deleted_role_names.
    // Each name passes through sanitizedRoleFilename so a malformed
    // emission (e.g. "../etc/passwd") cannot escape rolesDir; bad
    // names are surfaced to stderr and skipped, while valid names
    // proceed to the delete pass below. Empty/absent
    // deleted_role_names is normal — most return visits don't delete
    // roles.
    const deletedRoleFilenames = new Set<string>();
    for (const roleName of policy.deleted_role_names ?? []) {
      try {
        deletedRoleFilenames.add(sanitizedRoleFilename(roleName));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "unknown";
        process.stderr.write(
          `[aegis] ignored deleted_role_names entry "${roleName}" — ${msg}\n`
        );
      }
    }

    // Surface contradictions: a role appearing in BOTH policy.roles
    // and deleted_role_names is internally inconsistent. The writer
    // resolves it as "keep" (the role-write happened, category A
    // protects it from category B), but extraction drift this
    // serious should be visible. Stderr warning, no behavior change.
    for (const sanitized of deletedRoleFilenames) {
      if (newRoleFilenames.has(sanitized)) {
        process.stderr.write(
          `[aegis] role "${sanitized.replace(/\.json$/, "")}" appears in both policy.roles and deleted_role_names — keeping the role (the write wins). This is likely extraction drift; consider re-running aegis init if you actually wanted it deleted.\n`
        );
      }
    }

    // Pre-canonicalize each explicit-deletion target so category B
    // matching uses the same canonical-path semantics as category A.
    // On case-insensitive filesystems (APFS, NTFS), this resolves
    // "default.json" to the canonical path of an on-disk
    // "Default.json" — letting the user delete a legacy mixed-case
    // role file via the canonical lowercase name. ENOENT is
    // expected when no file matches the requested name (the deletion
    // entry was a no-op or referred to a name nothing claims) and
    // is silently ignored. Any other error gets a stderr note but
    // doesn't abort reconciliation.
    const deletedCanonical = new Set<string>();
    for (const sanitized of deletedRoleFilenames) {
      const candidatePath = path.join(rolesDir, sanitized);
      try {
        deletedCanonical.add(fs.realpathSync.native(candidatePath));
      } catch (err: unknown) {
        const fsErr = err as NodeJS.ErrnoException;
        if (fsErr?.code === "ENOENT") continue;
        process.stderr.write(
          `[aegis] could not canonicalize deletion target "${sanitized}" — ${fsErr?.message ?? "unknown"}\n`
        );
      }
    }

    for (const existing of existingRoleFiles) {
      const existingPath = path.join(rolesDir, existing);
      let resolved: string | null = null;
      try {
        resolved = fs.realpathSync.native(existingPath);
      } catch (err: unknown) {
        const fsErr = err as NodeJS.ErrnoException;
        if (fsErr?.code === "ENOENT") {
          outcomes.push({
            path: `.agentpolicy/roles/${existing}`,
            status: "skipped",
            reason: "entry vanished before reconciliation",
          });
          continue;
        }
        outcomes.push({
          path: `.agentpolicy/roles/${existing}`,
          status: "skipped",
          reason: `could not resolve: ${fsErr?.message ?? "unknown"}`,
        });
        continue;
      }

      // Category A — just-written role: never delete. Canonical-path
      // match handles case-insensitive aliasing on APFS/NTFS.
      if (resolved && writtenCanonical.has(resolved)) continue;

      // Category B — explicit deletion: the user asked for this role
      // to go. Match either by canonical path (handles case-
      // insensitive aliasing — "default" deletes "Default.json" on
      // APFS) or by exact filename (defensive fallback when
      // canonicalization of the deletion target failed but the raw
      // name still matches).
      const matchedByCanonical = resolved !== null && deletedCanonical.has(resolved);
      const matchedByName = deletedRoleFilenames.has(existing);
      if (matchedByCanonical || matchedByName) {
        try {
          fs.unlinkSync(existingPath);
          outcomes.push({
            path: `.agentpolicy/roles/${existing}`,
            status: "deleted",
          });
        } catch (err: unknown) {
          const fsErr = err as NodeJS.ErrnoException;
          if (fsErr?.code === "ENOENT") {
            outcomes.push({
              path: `.agentpolicy/roles/${existing}`,
              status: "skipped",
              reason: "entry vanished before deletion",
            });
            continue;
          }
          outcomes.push({
            path: `.agentpolicy/roles/${existing}`,
            status: "skipped",
            reason: `could not remove: ${fsErr?.message ?? "unknown"}`,
          });
        }
        continue;
      }

      // Category C — neither just-written nor explicitly deleted.
      // Preserve as a safety measure: silent extraction drift cannot
      // cause role-file data loss this way, because the only path
      // to deletion is an explicit deletion request. The user sees
      // the preserved file in the outcomes summary and a stderr
      // warning so they can address intentionally-orphaned roles
      // via a follow-up aegis init that names them.
      outcomes.push({
        path: `.agentpolicy/roles/${existing}`,
        status: "skipped",
        reason: "extraction omitted this role without asking to delete it — preserved as a safety measure. To remove it, run aegis init again and tell Aegis you want this role deleted.",
      });
      process.stderr.write(
        `[aegis] preserved orphan role file ".agentpolicy/roles/${existing}" — extraction omitted it without explicitly asking to delete it\n`
      );
    }
  } else {
    // Reconciliation aborted because at least one write could not be
    // canonicalized. Emit a single summary outcome rather than one
    // per candidate. Without canonical paths we cannot distinguish a
    // genuine stale entry from an alias of a file we just wrote on a
    // case-insensitive filesystem (Default.json ≡ default.json on
    // APFS/NTFS), so per-entry skipped rows would make speculative
    // "stale" claims that could mislead the audit trail.
    //
    // The candidate filenames are still captured in the reason so a
    // post-incident reader can see which entries were left untouched,
    // just without the summary labeling any individual name as stale.
    const candidates = existingRoleFiles.filter(
      (f) => !newRoleFilenames.has(f)
    );
    if (candidates.length > 0) {
      outcomes.push({
        path: ".agentpolicy/roles/",
        status: "skipped",
        reason: `reconciliation aborted — could not canonicalize newly written roles; ${candidates.length} role file(s) left untouched`,
        candidates,
      });
    }
  }

  return outcomes;
}

/**
 * Pick the next filename for a new transcript in .agentpolicy/sessions/.
 *
 * Scheme: `NN-initial-setup.json` for the very first session in an
 * empty directory, `NN-session.json` for every subsequent one. NN is
 * a zero-padded two-digit prefix that increments from the highest
 * existing numeric prefix, so new transcripts sort after prior ones
 * lexicographically and collisions at second-level resolution are
 * impossible regardless of clock skew.
 *
 * Legacy transcripts written by earlier aegis versions used ISO
 * timestamps as filenames (e.g. 2024-03-15_10-30-45.json). Those do
 * not match the NN- prefix, so they do not feed the max-prefix
 * calculation — new transcripts start numbering from 01 even if ISO
 * transcripts already exist. The "initial-setup" label is reserved
 * for genuinely empty sessions/ directories; when any transcript
 * (new or legacy) exists, the label becomes "session".
 */
function nextSessionFilename(sessionsDir: string): string {
  let existing: string[] = [];
  try {
    if (fs.existsSync(sessionsDir)) {
      existing = fs
        .readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".json"));
    }
  } catch {
    // Unreadable — treat as empty
  }

  const isFirst = existing.length === 0;

  let maxPrefix = 0;
  for (const file of existing) {
    const match = file.match(/^(\d+)-/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (Number.isFinite(n) && n > maxPrefix) maxPrefix = n;
    }
  }

  const nextNum = maxPrefix + 1;
  const prefix = String(nextNum).padStart(2, "0");
  const label = isFirst ? "initial-setup" : "session";
  return `${prefix}-${label}.json`;
}

/**
 * Write the discovery session transcript to .agentpolicy/sessions/.
 *
 * Filenames use the NN-initial-setup / NN-session scheme (see
 * nextSessionFilename). The full timestamp lives inside the JSON as
 * `timestamp` so the audit record is complete without cluttering the
 * filename. Transcripts are append-only — prior sessions are never
 * modified. On return visits, Aegis reads every prior transcript to
 * understand the history of governance decisions.
 */
export function writeTranscript(
  projectRoot: string,
  transcript: Array<{ role: string; content: string }>
): string {
  const sessionsDir = path.join(projectRoot, ".agentpolicy", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });

  const now = new Date();
  const session = {
    timestamp: now.toISOString(),
    messages: transcript.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  };
  const payload = JSON.stringify(session, null, 2) + "\n";

  // Allocate a unique filename via exclusive-create retry. The outer
  // per-project lock already prevents concurrent aegis init runs, but
  // the transcript writer should not depend on that invariant alone:
  // if the lock were ever bypassed or this helper reused by future
  // code, link + EEXIST retry ensures we never silently overwrite a
  // prior session's audit record.
  const MAX_ATTEMPTS = 50;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const filename = nextSessionFilename(sessionsDir);
    const filePath = path.join(sessionsDir, filename);
    try {
      writeFileAtomic(filePath, payload, { exclusive: true });
      return `.agentpolicy/sessions/${filename}`;
    } catch (err: unknown) {
      const fsErr = err as NodeJS.ErrnoException;
      if (fsErr?.code === "EEXIST") {
        // Another writer took that slot between our lookup and link.
        // Recompute next prefix and try again. Bounded by MAX_ATTEMPTS
        // to prevent a runaway loop if something else is consistently
        // claiming slots faster than we can reserve one.
        continue;
      }
      throw err;
    }
  }
  throw new Error(
    `writeTranscript could not allocate a unique filename in ${sessionsDir} after ${MAX_ATTEMPTS} attempts`
  );
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
 *
 * `opts.exclusive` swaps renameSync for linkSync, which fails with
 * EEXIST if the target already exists rather than overwriting it.
 * Used for session transcripts where filename reuse implies a race
 * we want to surface loudly instead of silently clobbering a prior
 * session's record.
 */
function writeFileAtomic(
  filePath: string,
  data: string,
  opts: { exclusive?: boolean } = {}
): void {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.tmp.${process.pid}.${Date.now()}`
  );
  try {
    fs.writeFileSync(tmpPath, data, { encoding: "utf-8", flag: "wx" });
    if (opts.exclusive) {
      // link + unlink achieves atomic exclusive placement: link fails
      // with EEXIST if the target already exists, so we never silently
      // overwrite. Unlink removes the now-redundant temp entry after
      // the hard link makes the content visible under the real name.
      fs.linkSync(tmpPath, filePath);
      fs.unlinkSync(tmpPath);
    } else {
      fs.renameSync(tmpPath, filePath);
    }
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

/**
 * Marker line prefix used to delineate the block of entries Aegis
 * adds to .gitignore. Exposed as a constant so future Aegis runs can
 * detect their own block and update it in place rather than appending
 * a new duplicate section every time.
 */
const AEGIS_GITIGNORE_HEADER = "# Aegis CLI — sensitive session output";

/**
 * Hard allowlist of paths Aegis is ever permitted to add to a user's
 * .gitignore. The LLM populates pending_actions.add_to_gitignore at
 * extraction time but we treat that field as untrusted: a drifted or
 * hallucinated extraction could ask us to append "src/" or "*" and
 * silently neuter the user's repo. updateGitignoreEntries rejects
 * anything outside this set and emits a warning to stderr when it
 * sees drift. These are the only two Aegis-produced files that need
 * to stay out of source control — if the product contract ever grows
 * to include more, they must be added here explicitly, not inferred
 * from extraction output.
 */
const AEGIS_SANCTIONED_GITIGNORE_PATHS = new Set<string>([
  ".agentpolicy/sessions/",
  ".agentpolicy/state/overrides.jsonl",
]);

/**
 * True iff an existing .gitignore line already covers the ignore our
 * caller wants to add. Delegates the real work to the `ignore`
 * library — the same spec-compliant parser we use to filter the
 * scan — so gitignore semantics match what git actually does:
 *
 *   - exact-match (".agentpolicy/sessions/" covers itself)
 *   - leading "/" anchor ("/.agentpolicy/sessions/" covers the same)
 *   - ancestor directory (".agentpolicy/" covers every descendant)
 *   - glob "**" expansion (".agentpolicy/**" covers every descendant)
 *   - filename glob (".agentpolicy/state/*.jsonl" covers overrides.jsonl)
 *   - double-star at repo root ("**\/overrides.jsonl" matches)
 *
 * Directory vs file asymmetry is also handled correctly:
 * "overrides.jsonl/" is a directory-only pattern and will NOT claim
 * coverage of the FILE overrides.jsonl — the library enforces that
 * trailing-slash semantics.
 *
 * We test coverage by asking the library "does this pattern ignore
 * this concrete path." For directory wanted-patterns (trailing "/")
 * we probe a sentinel descendant file so that a pattern matching the
 * directory as a whole also matches. Exact-file wanted-patterns are
 * tested verbatim.
 */
function existingCoversWanted(
  existingLine: string,
  wantedPattern: string
): boolean {
  const existing = existingLine.trim();
  const wanted = wantedPattern.trim();
  if (existing.length === 0) return false;

  // Build paths the ignore library can match against. For directory
  // wanted-patterns, two distinct descendant probes are used — the
  // existing pattern has to cover BOTH to claim coverage. A single
  // probe basename could theoretically be matched by a user-authored
  // literal or glob that happens to spell the same string; requiring
  // two disjoint probes makes that collision vanishingly unlikely
  // while still letting real parent-dir and ** globs cover both.
  // Exact-file wanted-patterns are tested verbatim (one path).
  let probePaths: string[];
  if (wanted.endsWith("/")) {
    probePaths = [
      `${wanted}__aegis_probe_alpha__.dat`,
      `${wanted}__aegis_probe_bravo__.dat`,
    ];
  } else {
    probePaths = [wanted.replace(/^\.\//, "").replace(/^\/+/, "")];
  }

  try {
    const ig = ignoreLib().add(existing);
    return probePaths.every((p) => ig.ignores(p));
  } catch {
    return false;
  }
}

/**
 * Normalize a full .gitignore file for the concurrent-edit race
 * check. Collapses formatting-only differences — CRLF to LF, stripped
 * trailing whitespace per line, stripped trailing blank lines — so a
 * benign editor save (e.g. a linter adding a final newline) does not
 * falsely trigger the "modified during update window" skip. Semantic
 * ignore content is preserved: line order, non-blank content, and
 * comment lines all stay comparable.
 */
function normalizeGitignoreForRaceCheck(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      // Preserve escaped trailing whitespace ("\ " or "\\t") because
      // in gitignore an escaped space/tab is a semantically significant
      // part of the pattern. The (?<!\\) lookbehind asserts "not
      // preceded by a backslash" so "foo\ " keeps its trailing space
      // while ordinary "foo   " loses its trailing indentation.
      return line.replace(/(?<!\\)[ \t]+$/, "");
    })
    .join("\n")
    .replace(/\n+$/, "");
}

/**
 * Append the given entries to the repo's .gitignore if they are not
 * already present. Called by the init command when the human opted
 * into Aegis managing .gitignore during discovery (pending_actions.
 * add_to_gitignore populated).
 *
 * Entries are trimmed to non-empty unique strings before processing.
 * If every requested entry is already in the file (in any section),
 * nothing is written and a WriteOutcome with "unchanged" status is
 * returned. Otherwise the missing entries are appended under a named
 * header block, the file is written atomically, and the outcome
 * reports which entries were newly added.
 *
 * The function creates .gitignore if it doesn't exist; callers can
 * infer whether the file was created or updated from the returned
 * WriteOutcome.status.
 */
export function updateGitignoreEntries(
  projectRoot: string,
  entriesToEnsure: string[]
): WriteOutcome | null {
  const gitignorePath = path.join(projectRoot, ".gitignore");

  // Allowlist gate — the LLM populates this list at extraction time
  // and a drifted or hallucinated value could neuter the user's repo.
  // Filter to the Aegis-sanctioned paths before touching the file,
  // and surface any unsanctioned entries to stderr so prompt drift
  // becomes visible rather than silent.
  const requested = Array.from(
    new Set(entriesToEnsure.map((e) => e.trim()).filter((e) => e.length > 0))
  );
  if (requested.length === 0) return null;

  const wanted: string[] = [];
  const rejected: string[] = [];
  for (const entry of requested) {
    if (AEGIS_SANCTIONED_GITIGNORE_PATHS.has(entry)) {
      wanted.push(entry);
    } else {
      rejected.push(entry);
    }
  }
  if (rejected.length > 0) {
    process.stderr.write(
      `[aegis] refused to add unsanctioned .gitignore entries from extraction: ${rejected.join(", ")}\n`
    );
  }
  if (wanted.length === 0) return null;

  let existing = "";
  let existed = false;
  try {
    if (fs.existsSync(gitignorePath)) {
      existing = fs.readFileSync(gitignorePath, "utf-8");
      existed = true;
    }
  } catch (err) {
    return {
      path: ".gitignore",
      status: "skipped",
      reason: `could not read existing .gitignore: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }

  // Collect non-comment lines from existing .gitignore, then for each
  // wanted entry check via existingCoversWanted — which is directional
  // about trailing-slash semantics so a directory-only "foo/" never
  // falsely claims coverage of a file "foo".
  const existingLines = existing
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));

  const missing = wanted.filter(
    (w) => !existingLines.some((e) => existingCoversWanted(e, w))
  );
  if (missing.length === 0) {
    return { path: ".gitignore", status: "unchanged" };
  }

  const separator =
    existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  const block = `${separator}\n${AEGIS_GITIGNORE_HEADER}\n${missing.join("\n")}\n`;
  const updated = existing + block;

  // Re-read immediately before the atomic rename to detect concurrent
  // writes (a git hook, a concurrent editor, another aegis run if the
  // lock was bypassed). If the file changed meaningfully since our
  // initial read, refuse to clobber — skipped is safer than silent
  // loss of unrelated edits. Comparison is on a normalized form so
  // a harmless formatting-only change (trailing newline added by a
  // linter, CRLF→LF conversion) does not trigger a spurious skip.
  // Not a perfect race closer; the window between this re-read and
  // the rename shrinks from tens of ms to microseconds but is not
  // zero.
  let current = "";
  try {
    if (fs.existsSync(gitignorePath)) {
      current = fs.readFileSync(gitignorePath, "utf-8");
    }
  } catch {
    // Treat as missing — we'll create from scratch on rename
  }
  if (
    normalizeGitignoreForRaceCheck(current) !==
    normalizeGitignoreForRaceCheck(existing)
  ) {
    return {
      path: ".gitignore",
      status: "skipped",
      reason: ".gitignore was modified during the update window — re-run aegis init to retry",
    };
  }

  try {
    writeFileAtomic(gitignorePath, updated);
    return {
      path: ".gitignore",
      status: existed ? "updated" : "created",
    };
  } catch (err) {
    return {
      path: ".gitignore",
      status: "skipped",
      reason: `could not write .gitignore: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
}
