/**
 * Single source of truth for the .agentpolicy/ contract surface.
 *
 * Multiple consumers across the CLI need to agree on what files
 * constitute the spec floor, where they live under .agentpolicy/,
 * which schema validates each, and how role names are constrained:
 *
 *   - src/discovery/scanner.ts: enumerates the floor files for the
 *     existing-policy load, computes hasUsableBaseline, formats
 *     the briefing.
 *   - src/policy/validator.ts: walks the floor for `aegis validate`
 *     and validates each compiled policy file against its schema.
 *   - src/policy/writer.ts: writes the floor on disk and validates
 *     role names against ROLE_NAME_PATTERN.
 *   - src/discovery/engine.ts: builds POLICY_READ_RE from the floor
 *     file names so policy-file reads emitted via [READ_FILE] are
 *     elided from the extraction transcript.
 *
 * Previously each consumer carried its own copy of these names. A
 * spec change to the floor (renamed file, added file, new role-
 * naming rule) required updating each site by hand, with the silent
 * failure mode of one site missing the update and drifting from the
 * others. Centralizing here means the contract surface lives in one
 * file; consumers import what they need.
 */

/**
 * One entry in the spec floor — a file every conforming
 * .agentpolicy/ must provide.
 */
export interface PolicyFloorEntry {
  /** Short identifier used in error messages and code references. */
  readonly name: "constitution" | "governance" | "ledger";
  /** Path relative to .agentpolicy/. */
  readonly relativePath: string;
  /**
   * Bundled schema that validates this file's content. The string
   * matches the schema filename minus the `.schema.json` suffix —
   * loaded from src/schemas/<schema>.schema.json.
   */
  readonly schema: "constitution" | "governance" | "ledger";
}

/**
 * The fixed policy floor. Order is meaningful for downstream
 * consumers that present the files in a stable sequence (briefing
 * formatter, validation report ordering).
 */
export const POLICY_FLOOR: readonly PolicyFloorEntry[] = [
  {
    name: "constitution",
    relativePath: "constitution.json",
    schema: "constitution",
  },
  {
    name: "governance",
    relativePath: "governance.json",
    schema: "governance",
  },
  { name: "ledger", relativePath: "state/ledger.json", schema: "ledger" },
];

/**
 * Convenience: the same floor as a flat array of relative paths.
 * Useful for consumers building globs, regexes, or `in`-checks
 * against `.agentpolicy/<path>` strings.
 */
export const POLICY_FLOOR_PATHS: readonly string[] = POLICY_FLOOR.map(
  (entry) => entry.relativePath
);

/** Role files live under this directory (relative to .agentpolicy/). */
export const ROLES_DIR_RELATIVE = "roles";

/** Glob pattern for role-file enumeration relative to .agentpolicy/. */
export const ROLES_GLOB = "roles/*.json";

/** Bundled schema name for role-file content validation. */
export const ROLE_SCHEMA = "role";

/**
 * Schema-defined role name pattern. Any role file or in-memory
 * role-object key must match — lowercase ASCII alphanumeric with
 * optional `_` or `-`, starting with a letter. Mirrors the pattern
 * declared in role.schema.json so the writer's filename
 * sanitization and the validator's name-shape check agree on the
 * same surface.
 */
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

/**
 * Reserved Windows basenames that pass ROLE_NAME_PATTERN but cannot
 * exist as files on NTFS regardless of extension. The CLI is built
 * with POSIX as the primary dev target, but role names need to stay
 * portable to Windows users.
 */
const WINDOWS_RESERVED_BASENAMES = new Set<string>([
  "con",
  "prn",
  "nul",
  "aux",
  "com0",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt0",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

/** True iff the name is reserved on Windows and unsafe as a filename. */
export function isReservedRoleName(name: string): boolean {
  return WINDOWS_RESERVED_BASENAMES.has(name.toLowerCase());
}

/**
 * Regex alternation fragment matching every relative path under
 * `.agentpolicy/` that the spec floor + roles glob covers. The
 * trailing `.json:` and surrounding regex shape are the caller's
 * responsibility — this helper just emits the inner alternation
 * group's body so engine.ts can build POLICY_READ_RE from a single
 * source instead of duplicating the floor names by hand.
 *
 * Assumes floor paths contain no regex-special characters beyond
 * `.` and `/`. Current manifest entries (constitution.json,
 * governance.json, state/ledger.json) satisfy that. The `.json`
 * extension is stripped before joining because the caller appends
 * it after the alternation group.
 */
export function policyReadRegexAlternatives(): string {
  const floor = POLICY_FLOOR_PATHS.map((p) => p.replace(/\.json$/, ""));
  return [...floor, `${ROLES_DIR_RELATIVE}/[^/:]+`].join("|");
}
