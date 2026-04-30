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
import {
  POLICY_FLOOR,
  ROLES_DIR_RELATIVE,
  ROLE_SCHEMA,
  ROLE_NAME_PATTERN,
  isReservedRoleName,
} from "./manifest.js";

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

/**
 * Re-export role-naming rules from the manifest so existing
 * imports of these names from validator.ts (e.g. writer.ts) keep
 * working. The canonical definitions live in manifest.ts; this
 * file is a façade for the role-name surface.
 */
export { ROLE_NAME_PATTERN, isReservedRoleName };

function loadSchema(name: string): object {
  const schemaPath = path.join(SCHEMA_DIR, `${name}.schema.json`);
  return JSON.parse(fs.readFileSync(schemaPath, "utf-8"));
}

/**
 * Validate an in-memory object against a bundled schema.
 * Used both for validating files read from disk and for validating
 * extracted policy before it touches the filesystem. Exported so
 * the scanner can reuse the same validation when deciding whether
 * an on-disk policy file is usable as a return-visit baseline (the
 * write side and the read side share the same schema check rather
 * than each having its own surface).
 */
export function validateAgainstSchema(
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

  // Floor schemas (constitution + governance + ledger). The
  // PolicyObject field name maps directly to the manifest entry's
  // `name`, which is also the schema name and the basename of the
  // file under .agentpolicy/. One source of truth for the
  // [field, schema, path] triple instead of three places repeating
  // the same string.
  for (const entry of POLICY_FLOOR) {
    // Cast through `unknown` because PolicyObject doesn't carry an
    // index signature — the field names match the manifest entry's
    // `name` literal type by construction (constitution, governance,
    // ledger), and a typo would surface as a runtime undefined that
    // ajv would reject.
    const data = (policy as unknown as Record<string, unknown>)[entry.name];
    results.push(
      validateAgainstSchema(data, entry.schema, entry.relativePath)
    );
  }

  if (!policy.roles || Object.keys(policy.roles).length === 0) {
    results.push({
      file: `${ROLES_DIR_RELATIVE}/`,
      valid: false,
      // Floor is "at least one role" — naming default.json as
      // "expected" overclaims (the spec accepts any role name) and
      // contradicts the rule that default.json is deletable like
      // any other role on return visits. Plain message instead.
      errors: ["At least one role is required"],
    });
  } else {
    for (const [roleName, roleData] of Object.entries(policy.roles)) {
      const displayPath = `${ROLES_DIR_RELATIVE}/${roleName}.json`;
      if (!ROLE_NAME_PATTERN.test(roleName)) {
        results.push({
          file: displayPath,
          valid: false,
          errors: [
            `Role name "${roleName}" does not match ${ROLE_NAME_PATTERN} — role names must be lowercase alphanumeric with _ or -.`,
          ],
        });
        continue;
      }
      if (isReservedRoleName(roleName)) {
        results.push({
          file: displayPath,
          valid: false,
          errors: [
            `Role name "${roleName}" is reserved on Windows and cannot be used as a filename on every platform.`,
          ],
        });
        continue;
      }
      const result = validateAgainstSchema(
        roleData,
        ROLE_SCHEMA,
        displayPath
      );

      // Cross-check: the outer object key (which the writer uses to
      // choose the on-disk filename) must match the inner role.name
      // (which agents see at runtime and which deleted_role_names
      // matches against). Schema validation alone does NOT enforce
      // this — the role schema validates the inner shape in
      // isolation, with no knowledge of the outer key chosen by
      // extraction. Without the check, schema-valid output like
      //   roles.frontend = { role: { name: "backend", ... }, ... }
      // would land on disk as roles/frontend.json with an inner
      // role.name of "backend", silently splitting the role's
      // identity across the filename, the deletion vocabulary, and
      // the human-facing label. Run this only when schema validation
      // passed (otherwise role.name's type isn't guaranteed) — and
      // append the mismatch onto the same ValidationResult so a
      // single file produces a single failure entry rather than two.
      if (result.valid) {
        const declaredName = (
          roleData as { role?: { name?: unknown } }
        ).role?.name;
        if (
          typeof declaredName === "string" &&
          declaredName !== roleName
        ) {
          result.valid = false;
          result.errors.push(
            `Role identity mismatch: the outer key "${roleName}" does not equal the inner role.name "${declaredName}". The writer uses the outer key to choose the filename; agents and deleted_role_names use role.name. They must match.`
          );
        }
      }
      results.push(result);
    }
  }

  return results;
}

/**
 * Validate the entire .agentpolicy/ directory on disk. Returns an
 * empty array when the directory is absent so the CLI can distinguish
 * "no policy here" from "policy exists but is invalid."
 *
 * Walks the spec floor from the centralized manifest. Constitution,
 * governance, and ledger come from POLICY_FLOOR; the roles/
 * directory is walked separately because role count is variable.
 * Result file paths are project-relative (.agentpolicy/...) rather
 * than absolute so `aegis validate` output can be pasted into bug
 * reports / screenshots without leaking the user's home directory.
 */
export function validatePolicy(projectRoot: string): ValidationResult[] {
  const policyDir = path.join(projectRoot, ".agentpolicy");
  if (!fs.existsSync(policyDir)) {
    return [];
  }

  const results: ValidationResult[] = [];

  // Floor files (constitution + governance + ledger). Walk the
  // manifest so a future spec addition adds one entry to manifest.ts
  // and this loop covers it without code change here.
  for (const entry of POLICY_FLOOR) {
    const filePath = path.join(policyDir, entry.relativePath);
    const displayPath = `.agentpolicy/${entry.relativePath}`;
    if (fs.existsSync(filePath)) {
      const result = validateFile(filePath, entry.schema);
      result.file = displayPath;
      results.push(result);
    } else {
      results.push({
        file: displayPath,
        valid: false,
        errors: ["File not found (required)"],
      });
    }
  }

  // Roles — at least one required, must match schema pattern
  const rolesDir = path.join(policyDir, ROLES_DIR_RELATIVE);
  const rolesDisplay = `.agentpolicy/${ROLES_DIR_RELATIVE}/`;
  if (!fs.existsSync(rolesDir)) {
    results.push({
      file: rolesDisplay,
      valid: false,
      errors: ["Directory not found (required)"],
    });
  } else {
    const roleFiles = fs
      .readdirSync(rolesDir)
      .filter((f) => f.endsWith(".json"));
    if (roleFiles.length === 0) {
      results.push({
        file: rolesDisplay,
        valid: false,
        errors: ["No role files found (at least one required)"],
      });
    } else {
      for (const roleFile of roleFiles) {
        const bareName = roleFile.replace(/\.json$/, "");
        const displayPath = `.agentpolicy/${ROLES_DIR_RELATIVE}/${roleFile}`;
        if (!ROLE_NAME_PATTERN.test(bareName)) {
          results.push({
            file: displayPath,
            valid: false,
            errors: [
              `Role filename "${roleFile}" does not match ${ROLE_NAME_PATTERN}.`,
            ],
          });
          continue;
        }
        if (isReservedRoleName(bareName)) {
          results.push({
            file: displayPath,
            valid: false,
            errors: [
              `Role filename "${roleFile}" uses a Windows-reserved name.`,
            ],
          });
          continue;
        }
        const result = validateFile(
          path.join(rolesDir, roleFile),
          ROLE_SCHEMA
        );
        result.file = displayPath;
        results.push(result);
      }
    }
  }

  return results;
}
