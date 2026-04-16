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

/**
 * Upper bound on how long a lock is considered legitimately held by a
 * live PID. Beyond this, the holder is treated as stale even if the
 * PID is still alive — guards against the "PID was reused by an
 * unrelated live process" scenario where process.kill(pid, 0) keeps
 * reporting success indefinitely. 12 hours is far longer than any
 * legitimate aegis init session, short enough that PID reuse within
 * the window is statistically negligible.
 */
const MAX_LOCK_AGE_MS = 12 * 60 * 60 * 1000;

interface LockContents {
  pid: number;
  createdAt: number;
}

function readLockContents(lockPath: string): LockContents | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8").trim();
    if (!raw) return null;

    // Preferred format: JSON with pid + createdAt. Falls back to a
    // bare PID integer so locks written by older aegis versions can
    // still be inspected and recovered. Strict type checks here —
    // floats, negatives, and non-finite numbers are treated as
    // corrupt so they cannot silently flow into the stale-age logic.
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; createdAt?: unknown };
      const pidValid =
        typeof parsed.pid === "number" &&
        Number.isInteger(parsed.pid) &&
        parsed.pid > 0;
      const createdAtValid =
        typeof parsed.createdAt === "number" &&
        Number.isInteger(parsed.createdAt) &&
        parsed.createdAt >= 0;
      if (pidValid && createdAtValid) {
        return {
          pid: parsed.pid as number,
          createdAt: parsed.createdAt as number,
        };
      }
    } catch {
      // Not JSON — try the legacy bare-pid format
    }

    // Legacy format: strict digits-only. parseInt("123abc", 10) would
    // happily return 123 without the regex guard, which would let
    // malformed content slip into the legacy path instead of being
    // rejected as corrupt.
    if (/^\d+$/.test(raw)) {
      const pid = parseInt(raw, 10);
      if (Number.isFinite(pid) && pid > 0) {
        return { pid, createdAt: 0 };
      }
    }
  } catch {
    // Unreadable lock
  }
  return null;
}

function writeLockContents(
  lockPath: string,
  flag: "wx" | "w"
): void {
  const payload = JSON.stringify({
    pid: process.pid,
    createdAt: Date.now(),
  });
  fs.writeFileSync(lockPath, payload + "\n", { flag });
}

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
    writeLockContents(lockPath, "wx");
    return lockPath;
  } catch (err: unknown) {
    const fsErr = err as NodeJS.ErrnoException;
    if (fsErr?.code !== "EEXIST") throw err;
  }

  // Existing lock — parse it and decide whether we can take over.
  const existing = readLockContents(lockPath);
  if (!existing) {
    // Corrupt or empty lock file — refuse to touch it silently.
    throw new LockConflictError(0, lockPath);
  }

  // Stale-lock heuristic combines two signals:
  //   1. PID liveness via process.kill(pid, 0) — ESRCH means dead.
  //   2. Lock age — a JSON lock older than MAX_LOCK_AGE_MS is treated
  //      as stale even if the PID reports live, because the PID may
  //      have been recycled by an unrelated process after the original
  //      holder exited. Legacy bare-PID locks have no createdAt, so
  //      we skip the age check for them and rely on PID liveness
  //      alone — otherwise a legitimate older-aegis session would
  //      get evicted the moment a newer aegis runs.
  const haveAge = existing.createdAt > 0;
  const age = haveAge ? Date.now() - existing.createdAt : 0;
  let pidIsLive = false;
  try {
    process.kill(existing.pid, 0);
    pidIsLive = true;
  } catch (err: unknown) {
    const sigErr = err as NodeJS.ErrnoException;
    if (sigErr?.code === "ESRCH") {
      pidIsLive = false;
    } else {
      // EPERM on signal 0 means the PID exists but we can't signal
      // it (different user). Treat as live — safer than taking over.
      pidIsLive = true;
    }
  }

  const isStale = !pidIsLive || (haveAge && age > MAX_LOCK_AGE_MS);

  if (isStale) {
    // Unlink + re-acquire via `wx`. The exclusive-create flag closes
    // the race where two contenders both detect staleness and both
    // try to overwrite: one wins the wx, the other sees EEXIST and
    // surfaces a fresh conflict.
    try {
      fs.unlinkSync(lockPath);
    } catch (unlinkErr: unknown) {
      const e = unlinkErr as NodeJS.ErrnoException;
      if (e?.code !== "ENOENT") throw e;
    }
    try {
      writeLockContents(lockPath, "wx");
      return lockPath;
    } catch (retryErr: unknown) {
      const e = retryErr as NodeJS.ErrnoException;
      if (e?.code === "EEXIST") {
        throw new LockConflictError(0, lockPath);
      }
      throw retryErr;
    }
  }

  throw new LockConflictError(existing.pid, lockPath);
}

/**
 * Register a synchronous cleanup handler that removes the lock on
 * every exit path. Three gates:
 *
 *   1. `process.on('exit')` fires on normal completion, `process.exit`,
 *      and uncaught exceptions after Node's default handler runs.
 *   2. Explicit SIGINT / SIGTERM handlers, because Node's default
 *      signal termination does not reliably fire the 'exit' event in
 *      every environment — raw-mode stdin via Ink changes the default
 *      handling path, and we don't want a Ctrl+C to strand the lock.
 *      The handlers do sync cleanup and then exit with the
 *      conventional signal code so shells see a normal signal exit.
 *   3. A closure-scoped `done` flag gates the cleanup so double-firing
 *      (e.g. signal handler + exit event) does not double-unlink or
 *      surface confusing errors.
 *
 * Only sync work runs here by design — releaseLock is sync exactly so
 * it works inside signal and exit handlers.
 */
export function registerExitCleanup(lockPath: string): void {
  let done = false;
  const cleanup = (): void => {
    if (done) return;
    done = true;
    releaseLock(lockPath);
  };

  process.once("exit", cleanup);

  const handleSignal = (code: number): void => {
    cleanup();
    process.exit(code);
  };

  process.once("SIGINT", () => handleSignal(130));
  process.once("SIGTERM", () => handleSignal(143));
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
