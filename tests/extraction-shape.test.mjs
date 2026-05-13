import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExtractedPolicyShapes } from "../dist/src/discovery/engine.js";
import { validatePolicyObject } from "../dist/src/policy/validator.js";

function policyWithLegacyStringArrays() {
  return {
    constitution: {
      $schema: "https://aegis.dev/schema/constitution.schema.json",
      version: "0.3.0",
      project: {
        name: "speckitty",
        purpose: "Governed SpecKitty development.",
        architecture: "monolith",
        module_map: ["src"],
        required_artifacts: ["README.md", "LICENSE"],
      },
      tech_stack: {
        languages: ["python"],
        key_libraries: ["uv", "pytest", "ruff"],
      },
      principles: ["Reliability first"],
      build_commands: {
        test: "pytest",
        custom: ["uv run ruff check ."],
      },
    },
    governance: {
      $schema: "https://aegis.dev/schema/governance.schema.json",
      version: "0.3.0",
      autonomy: { default_level: "advisory" },
      permissions: {
        boundaries: {
          writable: ["src/**"],
          read_only: [],
          forbidden: [],
        },
        sensitive_patterns: ["API_KEY"],
      },
      quality_gate: {
        pre_commit: {
          must_pass_tests: true,
          custom_checks: ["uv run pytest"],
        },
      },
      conventions: ["Use typed path helpers"],
    },
    roles: {
      default: {
        $schema: "https://aegis.dev/schema/role.schema.json",
        version: "0.3.0",
        role: {
          name: "default",
          purpose: "General project development.",
        },
        scope: {
          primary_paths: ["src/**"],
        },
        convention_overrides: ["Use pytest for tests"],
        collaboration: {
          shared_resources: ["src/shared"],
        },
      },
    },
    ledger: {
      $schema: "https://aegis.dev/schema/ledger.schema.json",
      version: "0.3.0",
      sequence: 0,
      tasks: ["Initial policy setup"],
      locks: ["src/shared"],
      write_protocol: {
        procedure: ["Read current ledger", "Write changes"],
      },
    },
    deployment_intent: "govern",
    handoff_prompt: "Call aegis_policy_summary now.",
  };
}

test("extraction normalization repairs typed-object string arrays before validation", () => {
  const policy = policyWithLegacyStringArrays();

  normalizeExtractedPolicyShapes(policy);

  assert.deepEqual(policy.constitution.project.module_map[0], {
    path: "src",
    purpose: "Project module identified during discovery.",
  });
  assert.deepEqual(policy.constitution.project.required_artifacts[1], {
    path: "LICENSE",
    purpose: "Required project artifact identified during discovery.",
  });
  assert.deepEqual(policy.constitution.tech_stack.key_libraries[0], {
    name: "uv",
    purpose: "Important library identified during discovery.",
  });
  assert.equal(policy.constitution.principles[0].statement, "Reliability first");
  assert.equal(policy.constitution.build_commands.custom[0].command, "uv run ruff check .");
  assert.equal(policy.governance.permissions.sensitive_patterns[0].pattern, "API_KEY");
  assert.equal(policy.governance.quality_gate.pre_commit.custom_checks[0].command, "uv run pytest");
  assert.equal(policy.governance.conventions[0].enforcement, "preferred");
  assert.equal(policy.roles.default.convention_overrides[0].convention_id, "use_pytest_for_tests");
  assert.equal(policy.roles.default.collaboration.shared_resources[0].protocol, "coordinate");
  assert.equal(policy.ledger.write_protocol.procedure[0].step, 1);
  assert.equal(policy.ledger.tasks[0].status, "pending");
  assert.equal(policy.ledger.locks[0].resource, "src/shared");

  const failures = validatePolicyObject(policy).filter((result) => !result.valid);
  assert.deepEqual(failures, []);
});
