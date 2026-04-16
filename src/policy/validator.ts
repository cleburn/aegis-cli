/**
 * Policy Validator
 *
 * Validates .agentpolicy/ files against the bundled JSON schemas.
 * Used by `aegis validate` and internally after policy generation.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Ajv = require("ajv").default;
const addFormats = require("ajv-formats");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DIR = path.join(__dirname, "..", "schemas");

export interface ValidationResult {
  file: string;
  valid: boolean;
  errors: string[];
}

/**
 * Structural shape of a compiled policy, used by validatePolicyObject.
 * Structural match intentional — no import cycle with writer.ts.
 */
export interface PolicyObject {
  constitution: Record<string, unknown>;
  governance: Record<string, unknown>;
  roles: Record<string, Record<string, unknown>>;
  ledger: Record<string, unknown>;
}

/** Schema-defined role-name pattern. Any role file or object must match. */
export const ROLE_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/;

function loadSchema(name: string): object {
  const schemaPath = path.join(SCHEMA_DIR, `${name}.schema.json`);
  return JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
}

/**
 * Validate an in-memory object against a bundled schema.
 * Used both for validating files read from disk and for validating
 * extracted policy before it touches the filesystem.
 */
function validateAgainstSchema(
  data: unknown,
  schemaName: string,
  label: string
): ValidationResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ajv = new Ajv({ allErrors: true, strict: false }) as any;
  addFormats(ajv);
  const schema = loadSchema(schemaName);
  const validate = ajv.compile(schema);
  const valid = validate(data);
  return {
    file: label,
    valid: valid === true,
    errors: valid
      ? []
      : ((validate.errors || []) as Array<{ instancePath?: string; message?: string }>).map(
          (e) => `${e.instancePath || "/"}: ${e.message}`
        ),
  };
}

/**
 * Validate a single policy file against its schema.
 */
export function validateFile(
  filePath: string,
  schemaName: string
): ValidationResult {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return validateAgainstSchema(data, schemaName, filePath);
  } catch (err) {
    return {
      file: filePath,
      valid: false,
      errors: [
        err instanceof Error ? err.message : "Failed to read or parse file",
      ],
    };
  }
}

/**
 * Validate a policy object in memory — used by writePolicy as a gate
 * before any files touch the filesystem. Checks schema conformance for
 * every piece, enforces the required file set (constitution, governance,
 * at least one role, ledger), and sanity-checks role names against the
 * schema pattern so role filenames can never escape roles/.
 *
 * Returns a list of results; an empty failures subset means it is safe
 * to proceed with the write.
 */
export function validatePolicyObject(policy: PolicyObject): ValidationResult[] {
  const results: ValidationResult[] = [];

  results.push(validateAgainstSchema(policy.constitution, "constitution", "constitution.json"));
  results.push(validateAgainstSchema(policy.governance, "governance", "governance.json"));

  if (!policy.roles || Object.keys(policy.roles).length === 0) {
    results.push({
      file: "roles/",
      valid: false,
      errors: ["At least one role is required (expected default.json)"],
    });
  } else {
    for (const [roleName, roleData] of Object.entries(policy.roles)) {
      if (!ROLE_NAME_PATTERN.test(roleName)) {
        results.push({
          file: `roles/${roleName}.json`,
          valid: false,
          errors: [
            `Role name "${roleName}" does not match ${ROLE_NAME_PATTERN} — role names must be lowercase alphanumeric with _ or -.`,
          ],
        });
        continue;
      }
      results.push(validateAgainstSchema(roleData, "role", `roles/${roleName}.json`));
    }
  }

  results.push(validateAgainstSchema(policy.ledger, "ledger", "state/ledger.json"));

  return results;
}

/**
 * Validate the entire .agentpolicy/ directory on disk. Returns an
 * empty array when the directory is absent so the CLI can distinguish
 * "no policy here" from "policy exists but is invalid."
 */
export function validatePolicy(projectRoot: string): ValidationResult[] {
  const policyDir = path.join(projectRoot, ".agentpolicy");
  if (!fs.existsSync(policyDir)) {
    return [];
  }

  const results: ValidationResult[] = [];

  // Constitution — required
  const constitutionPath = path.join(policyDir, "constitution.json");
  if (fs.existsSync(constitutionPath)) {
    results.push(validateFile(constitutionPath, "constitution"));
  } else {
    results.push({
      file: constitutionPath,
      valid: false,
      errors: ["File not found (required)"],
    });
  }

  // Governance — required
  const governancePath = path.join(policyDir, "governance.json");
  if (fs.existsSync(governancePath)) {
    results.push(validateFile(governancePath, "governance"));
  } else {
    results.push({
      file: governancePath,
      valid: false,
      errors: ["File not found (required)"],
    });
  }

  // Roles — at least one required, must match schema pattern
  const rolesDir = path.join(policyDir, "roles");
  if (!fs.existsSync(rolesDir)) {
    results.push({
      file: rolesDir,
      valid: false,
      errors: ["Directory not found (required)"],
    });
  } else {
    const roleFiles = fs
      .readdirSync(rolesDir)
      .filter((f) => f.endsWith(".json"));
    if (roleFiles.length === 0) {
      results.push({
        file: rolesDir,
        valid: false,
        errors: ["No role files found (at least one required, typically default.json)"],
      });
    } else {
      for (const roleFile of roleFiles) {
        const bareName = roleFile.replace(/\.json$/, "");
        if (!ROLE_NAME_PATTERN.test(bareName)) {
          results.push({
            file: path.join(rolesDir, roleFile),
            valid: false,
            errors: [
              `Role filename "${roleFile}" does not match ${ROLE_NAME_PATTERN}.`,
            ],
          });
          continue;
        }
        results.push(validateFile(path.join(rolesDir, roleFile), "role"));
      }
    }
  }

  // Ledger — required
  const ledgerPath = path.join(policyDir, "state", "ledger.json");
  if (fs.existsSync(ledgerPath)) {
    results.push(validateFile(ledgerPath, "ledger"));
  } else {
    results.push({
      file: ledgerPath,
      valid: false,
      errors: ["File not found (required)"],
    });
  }

  return results;
}
