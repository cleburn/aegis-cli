/**
 * Typed exit for aegis flows.
 *
 * Deep code that wants to abort the CLI (user typed /quit, API key
 * flow was canceled, a fatal precondition failed) throws AegisExit
 * instead of calling process.exit directly. The top-level init
 * command catches it, runs guaranteed cleanup (lock release, UI
 * destroy), and sets process.exitCode so Node exits cleanly once
 * the event loop drains.
 *
 * Two reasons this matters:
 *
 * 1. process.exit from deep code bypasses the outer try/finally,
 *    which is where lock cleanup and UI teardown live. The lockfile
 *    signal handlers cover SIGINT/SIGTERM, but not every abort goes
 *    through a signal — an invalid API key, for example. Without a
 *    typed exit, those paths leak state.
 *
 * 2. Every fatal message needs a stderr fallback. Ink may not be
 *    mounted yet (or may fail to mount). process.stderr.write
 *    always works. The catch handler writes to stderr first and
 *    tries ui.showError as a best-effort second layer.
 */
export class AegisExit extends Error {
  readonly code: number;
  readonly userMessage: string | undefined;

  constructor(code: number, userMessage?: string) {
    super(userMessage ?? `aegis exit (code ${code})`);
    this.name = "AegisExit";
    this.code = code;
    this.userMessage = userMessage;
  }
}
