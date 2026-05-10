import type { FileContent } from "../discovery/scanner.js";

export interface UserContentDeprecation {
  id: string;
  since: string;
  file: "constitution.json" | "governance.json" | "state/ledger.json" | "roles/*.json";
  path: string[];
  summary: string;
  guidance: string;
  match?: { exists?: true; equals?: unknown };
}

export interface PolicyMigrationFinding {
  id: string;
  since: string;
  location: string;
  summary: string;
  guidance: string;
}

export const USER_CONTENT_DEPRECATIONS: readonly UserContentDeprecation[] = [];

export function detectPolicyDeprecations(
  contents: FileContent[],
  registry: readonly UserContentDeprecation[] = USER_CONTENT_DEPRECATIONS
): PolicyMigrationFinding[] {
  if (registry.length === 0) return [];

  const findings: PolicyMigrationFinding[] = [];
  for (const file of contents) {
    const policyPath = file.path.replace(/^\.agentpolicy\//, "");
    const parsed = parseJson(file.content);
    if (parsed === null) continue;

    for (const rule of registry) {
      if (!ruleMatchesFile(rule, policyPath)) continue;
      const value = valueAtPath(parsed, rule.path);
      if (!matches(value, rule.match)) continue;

      findings.push({
        id: rule.id,
        since: rule.since,
        location: `${file.path}${rule.path.length > 0 ? `#/${rule.path.join("/")}` : ""}`,
        summary: rule.summary,
        guidance: rule.guidance,
      });
    }
  }

  return findings;
}

function ruleMatchesFile(rule: UserContentDeprecation, policyPath: string): boolean {
  if (rule.file === "roles/*.json") {
    return policyPath.startsWith("roles/") && policyPath.endsWith(".json");
  }
  return policyPath === rule.file;
}

function matches(value: unknown, match: UserContentDeprecation["match"]): boolean {
  if (!match || match.exists) return value !== undefined;
  if ("equals" in match) return deepEqual(value, match.equals);
  return false;
}

function valueAtPath(value: unknown, segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function parseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
