import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { DiscoveryEngine } from "../dist/src/discovery/engine.js";
import { scanRepo } from "../dist/src/discovery/scanner.js";
import {
  buildDiscoverySystemPrompt,
  buildExtractionSystemPrompt,
} from "../dist/src/discovery/system-prompt.js";

test("scanner surfaces constitution schema drift without stderr noise", async () => {
  const projectRoot = createPolicyProject({
    constitution: driftedConstitution(),
  });
  const stderr = captureStderr();
  try {
    const scan = await scanRepo(projectRoot);
    assert.equal(stderr.output(), "");
    assert.equal(scan.hasUsableBaseline, true);
    assert.equal(scan.existingPolicyContents.length, 4);

    const text = findingText(scan);
    assert.match(text, /module_map\/0\/owner/);
    assert.match(text, /owner is null/);
    assert.match(text, /key_libraries\/0/);
    assert.match(text, /key_libraries\/1/);
    assert.match(text, /expects an object with name and purpose/);
  } finally {
    stderr.restore();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("scanner surfaces ledger rename and status drift", async () => {
  const projectRoot = createPolicyProject({
    ledger: driftedLedger(),
  });
  try {
    const scan = await scanRepo(projectRoot);
    const text = findingText(scan);

    assert.equal(scan.hasUsableBaseline, true);
    assert.match(text, /tasks\/0\/agent_role/);
    assert.match(text, /assigned_role/);
    assert.match(text, /tasks\/0\/description/);
    assert.match(text, /summary/);
    assert.match(text, /tasks\/0\/timestamp/);
    assert.match(text, /created_at/);
    assert.match(text, /tasks\/0\/action/);
    assert.match(text, /status as a state enum/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("clean baseline has no migration findings", async () => {
  const projectRoot = createPolicyProject();
  try {
    const scan = await scanRepo(projectRoot);
    assert.equal(scan.hasUsableBaseline, true);
    assert.deepEqual(scan.policyMigrationFindings, []);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("discovery and extraction prompts carry drift migration context", async () => {
  const projectRoot = createPolicyProject({
    constitution: driftedConstitution(),
  });
  try {
    const scan = await scanRepo(projectRoot);
    const discoveryPrompt = buildDiscoverySystemPrompt(scan);
    assert.match(discoveryPrompt, /POLICY MIGRATION AWARENESS/);
    assert.match(discoveryPrompt, /module_map\/0\/owner/);
    assert.match(discoveryPrompt, /Do not silently rewrite/);

    const extractionPrompt = buildExtractionSystemPrompt(
      scan.existingPolicyContents
        .map((file) => `--- ${file.path} ---\n${file.content}`)
        .join("\n\n"),
      scan.policyMigrationFindings
    );
    assert.match(extractionPrompt, /POLICY MIGRATION CONTEXT/);
    assert.match(extractionPrompt, /Migration is an explicit exception/);
    assert.match(extractionPrompt, /key_libraries/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("extraction receives migration context and can emit schema-valid migrated policy", async () => {
  const projectRoot = createPolicyProject({
    constitution: driftedConstitution(),
  });
  try {
    const scan = await scanRepo(projectRoot);
    const provider = new CapturingProvider(validMigratedPolicy());
    const ui = new FakeUI(["yes"]);
    const engine = new DiscoveryEngine(provider, scan, ui);

    const result = await engine.run();

    assert.equal(result.status, "completed");
    assert.equal(result.policy?.constitution.tech_stack.key_libraries[0].name, "Zod");
    assert.match(provider.extractionSystemPrompt, /POLICY MIGRATION CONTEXT/);
    assert.match(provider.extractionSystemPrompt, /module_map\/0\/owner/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

function createPolicyProject(overrides = {}) {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-drift-"));
  const policyDir = path.join(projectRoot, ".agentpolicy");
  fs.mkdirSync(path.join(policyDir, "roles"), { recursive: true });
  fs.mkdirSync(path.join(policyDir, "state"), { recursive: true });
  writeJson(
    path.join(policyDir, "constitution.json"),
    overrides.constitution ?? validConstitution()
  );
  writeJson(
    path.join(policyDir, "governance.json"),
    overrides.governance ?? validGovernance()
  );
  writeJson(path.join(policyDir, "roles", "default.json"), validRole());
  writeJson(
    path.join(policyDir, "state", "ledger.json"),
    overrides.ledger ?? validLedger()
  );
  return projectRoot;
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function validConstitution() {
  return {
    version: "0.3.0",
    project: {
      name: "clearhealth",
      purpose: "Govern a healthcare platform.",
      architecture: "monolith",
      module_map: [{ path: "src", purpose: "Application code", owner: "default" }],
    },
    tech_stack: {
      languages: ["typescript"],
      key_libraries: [{ name: "Zod", purpose: "Runtime validation" }],
    },
    principles: [
      {
        name: "safety",
        statement: "Protect sensitive health data in every workflow.",
      },
    ],
  };
}

function driftedConstitution() {
  return {
    ...validConstitution(),
    project: {
      ...validConstitution().project,
      module_map: [{ path: "src", purpose: "Application code", owner: null }],
    },
    tech_stack: {
      languages: ["typescript"],
      key_libraries: ["Zod", "React"],
    },
  };
}

function validGovernance() {
  return {
    version: "0.3.0",
    autonomy: { default_level: "advisory" },
    permissions: {
      boundaries: {
        writable: ["src/**"],
        read_only: [],
        forbidden: [],
      },
    },
    quality_gate: {
      pre_commit: {
        must_pass_tests: true,
      },
    },
  };
}

function validRole() {
  return {
    version: "0.3.0",
    role: {
      name: "default",
      purpose: "General project stewardship.",
    },
    scope: {
      primary_paths: ["**/*"],
    },
  };
}

function validLedger() {
  return {
    version: "0.3.0",
    sequence: 0,
    tasks: [],
  };
}

function driftedLedger() {
  return {
    version: "0.3.0",
    sequence: 1,
    tasks: [
      {
        id: 1,
        action: "created",
        description: "Initial policy setup",
        agent_role: "default",
        timestamp: "2026-05-12T00:00:00.000Z",
        affected_paths: [".agentpolicy/constitution.json"],
      },
    ],
  };
}

function validMigratedPolicy() {
  return {
    constitution: validConstitution(),
    governance: validGovernance(),
    roles: {
      default: validRole(),
    },
    ledger: validLedger(),
    deployment_intent: "govern",
    handoff_prompt: "Read .agentpolicy/ before making changes.",
  };
}

function findingText(scan) {
  return scan.policyMigrationFindings
    .map((finding) => `${finding.location} ${finding.summary} ${finding.guidance}`)
    .join("\n");
}

function captureStderr() {
  const originalWrite = process.stderr.write;
  let captured = "";
  process.stderr.write = (chunk, ...args) => {
    captured += String(chunk);
    return true;
  };
  return {
    output: () => captured,
    restore: () => {
      process.stderr.write = originalWrite;
    },
  };
}

class CapturingProvider {
  constructor(policy) {
    this.policy = policy;
    this.streamCalls = 0;
    this.extractionSystemPrompt = "";
  }

  async validate() {
    return { ok: true };
  }

  async chat() {
    return "";
  }

  async chatStream(_messages, _systemPrompt, onToken) {
    const response =
      this.streamCalls === 0
        ? "I noticed a few older policy fields. Want me to migrate them?"
        : "Got it — drafting those now. [DISCOVERY_COMPLETE]";
    this.streamCalls += 1;
    onToken(response);
    return response;
  }

  async chatJSON(_messages, systemPrompt) {
    this.extractionSystemPrompt = systemPrompt;
    return this.policy;
  }
}

class FakeUI {
  constructor(inputs) {
    this.inputs = inputs;
  }

  async getUserInput() {
    return this.inputs.shift() ?? "";
  }

  startThinking() {}
  stopThinking() {}
  startAegisResponse() {}
  streamToken() {}
  endAegisResponse() {}
  showNote() {}
  showError() {}
  showAegisMessage() {}
  async selectFromMenu() {
    return { canceled: true };
  }
}
