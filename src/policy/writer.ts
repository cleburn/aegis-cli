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
  // aegis init will pick up the reconciliation. Every skipped decision
  // still produces a WriteOutcome so the audit trail is complete.
  const canReconcile = writtenCanonical.size === newRoleFilenames.size;
  if (canReconcile) {
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

      if (resolved && writtenCanonical.has(resolved)) continue;

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

  // Build a path the ignore library can match against. For directory
  // wanted-patterns, use a stub descendant so parent-dir and ** globs
  // count as coverage. The sentinel basename is distinctive so it
  // does not accidentally match user-authored leaf patterns.
  const probePath = wanted.endsWith("/")
    ? `${wanted}__aegis_coverage_probe__`
    : wanted.replace(/^\.\//, "").replace(/^\/+/, "");

  try {
    const ig = ignoreLib().add(existing);
    return ig.ignores(probePath);
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
