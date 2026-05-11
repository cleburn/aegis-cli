import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { shouldWriteRepoTranscript } from "../dist/src/commands/init.js";
import { writeTranscript } from "../dist/src/policy/writer.js";

test("fresh aborted init does not write a repo transcript", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-init-gate-"));
  try {
    if (shouldWriteRepoTranscript(false, false)) {
      writeTranscript(projectRoot, [{ role: "user", content: "aegis init" }]);
    }
    assert.equal(
      fs.existsSync(path.join(projectRoot, ".agentpolicy")),
      false
    );
  } finally {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("repo transcript still writes for baseline or successful policy sessions", () => {
  assert.equal(shouldWriteRepoTranscript(true, false), true);
  assert.equal(shouldWriteRepoTranscript(false, true), true);
});
