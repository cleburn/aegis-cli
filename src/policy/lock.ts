/**
 * Per-project lockfile for aegis init.
 *
 * Two aegis processes running in the same project would clobber each
 * other's writes and produce half-updated policy. The lock is a tiny
 * file at .agentpolicy/.aegis.lock containing the holder's PID; a
 * second process checking into the same project sees the lock, probes
 * whether the holder is still alive, and either refuses (live process)
 * or takes over (stale lock from a crashed run).
 *
 * Sync API on purpose — acquisition runs early in the init flow and
 * release runs in a finally block that must complete before process
 * exit, so both paths avoid microtask scheduling.
 */

import * as fs from "node:fs";
import * as path from "node:path";

const LOCK_FILENAME = ".aegis.lock";

export class LockConflictError extends Error {
  readonly holderPid: number;
  readonly lockPath: string;
  constructor(holderPid: number, lockPath: string) {
    super(
      `Another aegis process (PID ${holderPid}) is already running in this project. ` +
        `Wait for it to finish, or delete ${lockPath} if you're certain it's stale.`
    );
    this.name = "LockConflictError";
    this.holderPid = holderPid;
    this.lockPath = lockPath;
  }
}

/**
 * Acquire the lock for this project. Returns the lock path so the
 * caller can release it later. Throws LockConflictError if another
 * live process holds the lock, or the underlying fs error on any
 * other failure.
 */
export function acquireLock(projectRoot: string): string {
  const lockDir = path.join(projectRoot, ".agentpolicy");
  fs.mkdirSync(lockDir, { recursive: true });
  const lockPath = path.join(lockDir, LOCK_FILENAME);

  try {
    fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
    return lockPath;
  } catch (err: unknown) {
    const fsErr = err as NodeJS.ErrnoException;
    if (fsErr?.code !== "EEXIST") throw err;
  }

  // Existing lock — probe whether the holder is still alive.
  let holderPid = 0;
  try {
    const contents = fs.readFileSync(lockPath, "utf-8").trim();
    const parsed = parseInt(contents, 10);
    if (Number.isFinite(parsed) && parsed > 0) holderPid = parsed;
  } catch {
    // Unreadable lock — treat as corrupt but refuse to take over
    // silently. Caller should surface this as a conflict.
    throw new LockConflictError(0, lockPath);
  }

  if (holderPid === 0) {
    throw new LockConflictError(0, lockPath);
  }

  // Signal 0 throws if the process is gone. ESRCH means stale; any
  // other error we treat as conflict because we can't be sure.
  try {
    process.kill(holderPid, 0);
  } catch (err: unknown) {
    const sigErr = err as NodeJS.ErrnoException;
    if (sigErr?.code === "ESRCH") {
      // Stale lock — unlink then re-acquire exclusively. The `wx`
      // flag ensures we fail closed if another contender raced in
      // after our unlink, so two processes cannot both "win" the
      // takeover path. A plain writeFileSync here would let both
      // overwrite and both proceed to clobber each other's output.
      try {
        fs.unlinkSync(lockPath);
      } catch (unlinkErr: unknown) {
        const e = unlinkErr as NodeJS.ErrnoException;
        if (e?.code !== "ENOENT") throw e;
      }
      try {
        fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
        return lockPath;
      } catch (retryErr: unknown) {
        const e = retryErr as NodeJS.ErrnoException;
        if (e?.code === "EEXIST") {
          throw new LockConflictError(0, lockPath);
        }
        throw retryErr;
      }
    }
  }

  throw new LockConflictError(holderPid, lockPath);
}

/**
 * Register a synchronous cleanup handler that removes the lock when
 * the process exits, regardless of exit path. `process.on('exit')`
 * fires for normal completion, process.exit, uncaught exceptions
 * (after Node's default handler), and signal-induced termination once
 * re-raised, so this closes the gap where a deep process.exit() call
 * in another module would otherwise bypass the top-level finally
 * block and leave an orphan lock on disk.
 *
 * Only sync work is allowed here — releaseLock is sync by design for
 * exactly this reason. Safe to double-call: releaseLock is a no-op
 * if the lock is already gone.
 */
export function registerExitCleanup(lockPath: string): void {
  process.once("exit", () => releaseLock(lockPath));
}

/**
 * Release a previously acquired lock. Silent if the file is already
 * gone — callers run this from finally blocks where throwing would
 * mask the original error.
 */
export function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
  } catch {
    // Already removed or never created
  }
}
