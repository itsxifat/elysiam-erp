/**
 * The one seam through which an unexpected failure reaches an error tracker (§26, D-344).
 *
 * Callers say what failed and a few low-cardinality tags (`kind`, `code`, `queue`); they
 * never import Sentry. `instrument.ts` installs a reporter when `SENTRY_DSN` is set, and
 * until then — every test, every developer machine — reporting is a no-op. That keeps the
 * SDK out of every process that does not use it, and keeps a reporting fault from ever
 * becoming the request's fault.
 */

export type ErrorTags = Readonly<Record<string, string>>;

export interface ErrorReporter {
  capture(error: unknown, tags: ErrorTags): void;
  /** Send what is queued, within `timeoutMs`. Called before the process exits. */
  close(timeoutMs: number): Promise<void>;
}

let reporter: ErrorReporter | undefined;

/** Called once by `instrument.ts`, and by tests (with `undefined` to reset). */
export function setErrorReporter(next: ErrorReporter | undefined): void {
  reporter = next;
}

/** Report an unexpected failure. Never throws: the caller is already handling one. */
export function reportError(error: unknown, tags: ErrorTags = {}): void {
  try {
    reporter?.capture(error, tags);
  } catch {
    // A reporter that fails must not turn a logged 500 into a crashed process.
  }
}

/** Things to finish before exit: queued error events, buffered spans. */
const closers: (() => Promise<void>)[] = [];

export function onObservabilityShutdown(close: () => Promise<void>): void {
  closers.push(close);
}

/**
 * Flush and stop everything `instrument.ts` started, within `timeoutMs`.
 *
 * Called on SIGTERM and on a failed boot. Without it the last errors before a crash, and
 * the spans of the requests a deploy drained, are dropped with the process.
 */
export async function shutdownObservability(timeoutMs = 2_000): Promise<void> {
  const pending = [
    ...(reporter === undefined ? [] : [reporter.close(timeoutMs)]),
    ...closers.map((close) => close()),
  ];
  if (pending.length === 0) return;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
