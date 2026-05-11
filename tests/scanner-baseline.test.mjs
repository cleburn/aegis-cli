import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { scanRepo } from "../dist/src/discovery/scanner.js";
import { buildDiscoverySystemPrompt } from "../dist/src/discovery/system-prompt.js";

test("transcript-only .agentpolicy is treated as fresh-project context", async () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-scan-test-"));
  try {
    const sessionsDir = path.join(projectRoot, ".agentpolicy", "sessions");
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, "01-initial-setup.json"),
      JSON.stringify({
        timestamp: new Date(0).toISOString(),
        messages: [
          { role: "user", content: "aegis init" },
          { role: "assistant", content: "Started discovery." },
        ],
      })
    );

    const scan = await scanRepo(projectRoot);
    assert.equal(scan.hasExistingPolicy, true);
    assert.equal(scan.hasAuthoredPolicy, false);
    assert.equal(scan.hasUsableBaseline, false);
    assert.equal(scan.existingSessionTranscripts.length, 1);

    const prompt = buildDiscoverySystemPrompt(scan);
    assert.doesNotMatch(prompt, /contents could not be loaded/);
    assert.doesNotMatch(prompt, /rebuild the policy from scratch/);
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
