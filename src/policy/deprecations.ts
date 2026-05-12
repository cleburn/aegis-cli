import type { FileContent } from "../discovery/scanner.js";
import type { ValidationResult } from "./validator.js";

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
  source?: "registry" | "schema_validation";
  errors?: string[];
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
        source: "registry",
      });
    }
  }

  return findings;
}

export function detectSchemaValidationDrift(
  filePath: string,
  validation: ValidationResult,
  parsedJson: unknown
): PolicyMigrationFinding[] {
  if (validation.valid) return [];

  const findings: PolicyMigrationFinding[] = validation.errors.map((error, index) => {
    const { location, message } = parseValidationError(filePath, error);
    return {
      id: `schema.${sanitizeId(filePath)}.${index + 1}`,
      since: "current schema",
      location,
      summary: message,
      guidance:
        "Ask whether to migrate this field to the current Aegis schema. Preserve the user's intent while correcting only the schema drift and any changes the conversation explicitly confirms.",
      source: "schema_validation" as const,
      errors: [error],
    };
  });

  findings.push(...detectLegacyContext(filePath, parsedJson));
  return findings;
}

function parseValidationError(
  filePath: string,
  error: string
): { location: string; message: string } {
  const separator = error.indexOf(": ");
  const instancePath = separator === -1 ? "/" : error.slice(0, separator);
  const message = separator === -1 ? error : error.slice(separator + 2);
  return {
    location:
      instancePath === "/"
        ? filePath
        : `${filePath}#${instancePath}`,
    message,
  };
}

function detectLegacyContext(
  filePath: string,
  parsedJson: unknown
): PolicyMigrationFinding[] {
  if (!isRecord(parsedJson)) return [];
  if (filePath.endsWith("constitution.json")) {
    return detectConstitutionLegacyContext(filePath, parsedJson);
  }
  if (filePath.endsWith("state/ledger.json")) {
    return detectLedgerLegacyContext(filePath, parsedJson);
  }
  return [];
}

function detectConstitutionLegacyContext(
  filePath: string,
  parsedJson: Record<string, unknown>
): PolicyMigrationFinding[] {
  const findings: PolicyMigrationFinding[] = [];
  const project = asRecord(parsedJson.project);
  const moduleMap = Array.isArray(project?.module_map)
    ? project.module_map
    : [];
  moduleMap.forEach((entry, index) => {
    if (isRecord(entry) && entry.owner === null) {
      findings.push({
        id: `schema.${sanitizeId(filePath)}.module-owner-${index + 1}`,
        since: "current schema",
        location: `${filePath}#/project/module_map/${index}/owner`,
        summary:
          "module_map owner is null; current schema expects a role name string or the owner field omitted when unset.",
        guidance:
          "Ask whether this module should be assigned to a role. If it is intentionally unset, migrate by omitting owner rather than preserving null.",
        source: "schema_validation",
      });
    }
  });

  const techStack = asRecord(parsedJson.tech_stack);
  const keyLibraries = Array.isArray(techStack?.key_libraries)
    ? techStack.key_libraries
    : [];
  keyLibraries.forEach((entry, index) => {
    if (typeof entry === "string") {
      findings.push({
        id: `schema.${sanitizeId(filePath)}.key-library-${index + 1}`,
        since: "current schema",
        location: `${filePath}#/tech_stack/key_libraries/${index}`,
        summary:
          "key_libraries entry is a string; current schema expects an object with name and purpose.",
        guidance:
          "Ask whether to preserve this library by migrating it to { name, purpose } using the user's intended purpose.",
        source: "schema_validation",
      });
    }
  });

  return findings;
}

function detectLedgerLegacyContext(
  filePath: string,
  parsedJson: Record<string, unknown>
): PolicyMigrationFinding[] {
  if (!Array.isArray(parsedJson.tasks)) return [];

  const legacyFields: Array<{
    oldKey: string;
    summary: string;
    guidance: string;
  }> = [
    {
      oldKey: "agent_role",
      summary:
        "legacy task field agent_role is present; current schema uses assigned_role.",
      guidance:
        "Ask whether to migrate agent_role to assigned_role for this task.",
    },
    {
      oldKey: "description",
      summary:
        "legacy task field description is present; current schema uses summary.",
      guidance:
        "Ask whether to migrate description to summary while preserving the task's meaning.",
    },
    {
      oldKey: "timestamp",
      summary:
        "legacy task field timestamp is present; current schema uses created_at.",
      guidance:
        "Ask whether to migrate timestamp to created_at for this task.",
    },
    {
      oldKey: "affected_paths",
      summary:
        "legacy task field affected_paths is present; current schema uses files_touched.",
      guidance:
        "Ask whether to migrate affected_paths to files_touched for this task.",
    },
    {
      oldKey: "action",
      summary:
        "legacy task field action is present; current schema uses status as a state enum instead of an action verb.",
      guidance:
        "Ask how this action should map to the current status values: pending, in_progress, blocked, completed, failed, or abandoned.",
    },
  ];

  const findings: PolicyMigrationFinding[] = [];
  parsedJson.tasks.forEach((task, index) => {
    if (!isRecord(task)) return;
    for (const field of legacyFields) {
      if (!(field.oldKey in task)) continue;
      findings.push({
        id: `schema.${sanitizeId(filePath)}.task-${index + 1}-${field.oldKey}`,
        since: "current schema",
        location: `${filePath}#/tasks/${index}/${field.oldKey}`,
        summary: field.summary,
        guidance: field.guidance,
        source: "schema_validation",
      });
    }
  });

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

function sanitizeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9]+/g, ".").replace(/^\.+|\.+$/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
