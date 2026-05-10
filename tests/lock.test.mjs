import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  acquireLock,
  LockConflictError,
  releaseLock,
} from "../dist/src/policy/lock.js";

test("acquireLock does not create .agentpolicy in a fresh project", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-lock-test-"));
  let lockPath;
  try {
    lockPath = acquireLock(projectRoot);
    assert.equal(
      fs.existsSync(path.join(projectRoot, ".agentpolicy")),
      false
    );
    assert.throws(() => acquireLock(projectRoot), LockConflictError);
  } finally {
    if (lockPath) releaseLock(lockPath);
    fs.rmSync(projectRoot, { recursive: true, force: true });
  }
});
