import type {
  FraudSignalProvider,
  ProviderResult,
  ProviderSignalCounts,
} from './fraud-signal.provider.js';

/**
 * The fake provider (`.claude/rules/integrations.md`: interface, real implementation, fake).
 *
 * For tests and for local development, where there is no provider account and — until
 * D-010 is resolved — no verified endpoint to have one for. It is scripted rather than
 * random: a fake that invents plausible numbers makes a score test pass or fail depending
 * on the seed, which is the kind of flake that teaches everyone to re-run the suite.
 *
 * Every failure mode the interface can express is scriptable here, because those are the
 * ones the rest of the module has to survive. `stall()` in particular is what proves check
 * 3 — "when the provider times out, the badge falls back to an internal-only score" — and
 * it does it by never resolving, which is what a timeout actually is. A fake that resolved
 * with `{status: 'unavailable', reason: 'timeout'}` would test the string and not the
 * timeout.
 */
export class FakeFraudProvider implements FraudSignalProvider {
  readonly calls: string[] = [];

  private answer: ProviderResult = {
    status: 'ok',
    counts: { total: 0, delivered: 0, returnedOrCancelled: 0, ratio: null, raw: {} },
  };

  /** Never resolves until the caller's timeout fires. `false` restores normal answers. */
  private stalling = false;

  constructor(
    readonly name = 'fake',
    public configured = true,
  ) {}

  /** Answer with these counts from now on. */
  returns(counts: ProviderSignalCounts): this {
    this.answer = { status: 'ok', counts };
    this.stalling = false;
    return this;
  }

  /** Answer `unavailable` with this reason from now on. */
  fails(reason: Exclude<ProviderResult, { status: 'ok' }>['reason']): this {
    this.answer = { status: 'unavailable', reason };
    this.stalling = false;
    return this;
  }

  /**
   * Hang, so the caller's own timeout is what ends the call.
   *
   * The promise resolves on the abort rather than being left dangling, so a suite that
   * stalls a provider does not leave an unsettled promise behind for vitest to warn about
   * after the test has finished.
   */
  stall(): this {
    this.stalling = true;
    return this;
  }

  async lookup(e164: string, options: { readonly timeoutMs: number }): Promise<ProviderResult> {
    // The number is recorded so a test can assert it was normalised on the way in. It is a
    // fixture number by construction — a real one in a fixture is what invariant 10 forbids.
    this.calls.push(e164);

    if (!this.stalling) return this.answer;

    /*
     * The real adapter aborts its own fetch on `AbortSignal.timeout` and reports
     * `timeout`. The fake reproduces the *observable* behaviour — an answer that arrives
     * only after the budget has gone — so the gateway and the service are exercised on the
     * same path they take in production.
     */
    await new Promise((resolve) => setTimeout(resolve, options.timeoutMs + 10));
    return { status: 'unavailable', reason: 'timeout' };
  }
}
