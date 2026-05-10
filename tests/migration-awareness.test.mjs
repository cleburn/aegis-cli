import assert from "node:assert/strict";
import test from "node:test";
import { detectPolicyDeprecations } from "../dist/src/policy/deprecations.js";
import { formatScanBriefing } from "../dist/src/discovery/scanner.js";
import { buildDiscoverySystemPrompt } from "../dist/src/discovery/system-prompt.js";

function baseScan(migrationFindings = []) {
  return {
    root: "/tmp/project",
    scanTier: "normal",
    scanFileCount: 1,
    scanByteSize: 1,
    projectName: "project",
    projectDescription: "",
    languages: [],
    frameworks: [],
    packageManagers: [],
    infrastructure: [],
    topLevelDirs: [],
    directoryTree: {},
    configFiles: [],
    hasExistingPolicy: true,
    hasUsableBaseline: true,
    existingPolicyFiles: ["constitution.json", "governance.json", "roles/default.json", "state/ledger.json"],
    existingPolicyContents: [],
    policyMigrationFindings: migrationFindings,
    existingSessionTranscripts: [],
    packageJson: undefined,
    scripts: {},
    fileCounts: {},
    fileContents: [],
    skippedSensitiveFiles: [],
  };
}

test("empty deprecation registry is a no-op", () => {
  const findings = detectPolicyDeprecations([
    { path: ".agentpolicy/constitution.json", content: JSON.stringify({ old: true }), truncated: false },
  ]);
  assert.deepEqual(findings, []);
  assert.doesNotMatch(formatScanBriefing(baseScan()), /POLICY MIGRATION FINDINGS/);
  assert.doesNotMatch(buildDiscoverySystemPrompt(baseScan()), /POLICY MIGRATION AWARENESS/);
});

test("planted deprecation entry is detected and surfaced", () => {
  const registry = [
    {
      id: "test.old-field",
      since: "v0.test",
      file: "constitution.json",
      path: ["old_field"],
      summary: "old_field was renamed",
      guidance: "Ask whether to migrate old_field to new_field.",
    },
  ];
  const findings = detectPolicyDeprecations([
    { path: ".agentpolicy/constitution.json", content: JSON.stringify({ old_field: "value" }), truncated: false },
  ], registry);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].location, ".agentpolicy/constitution.json#/old_field");
  const prompt = buildDiscoverySystemPrompt(baseScan(findings));
  assert.match(prompt, /POLICY MIGRATION AWARENESS/);
  assert.match(prompt, /Do not silently rewrite/);
  assert.match(prompt, /session transcript records what changed and why/);
});
