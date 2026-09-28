import { Inject, Injectable, Optional } from '@nestjs/common';

import { FRAUD_CONFIG, type FraudConfig } from '../fraud.config.js';
import {
  FRAUD_PROVIDERS,
  type FraudSignalProvider,
  type ProviderResult,
} from './fraud-signal.provider.js';

/**
 * The one door to every provider: throttled, timed out, and never trusted to behave
 * (architecture §10 "Cached, throttled", §21; M13 check 3).
 *
 * The TTL cache is **not here**. It is `fraud.provider_checks.fetched_at` in the
 * database, and that is a deliberate choice rather than a shortcut:
 *
 * * Several API instances serve the desk. A per-process map would mean one TTL and one
 *   throttle budget *per replica*, so the metered lookups would multiply by the
 *   deployment size and the badge would be cached for whichever instance the browser
 *   happened to reach.
 * * The cached row is also the row the score reads. A separate cache would be a second
 *   copy of the same answer with its own expiry, and the two would disagree — which is
 *   the bug where the badge changes when you reload without anything having happened.
 *
 * What lives here is the part that is genuinely about *this process*: the outbound
 * rate limit and the timeout. Both exist to stop a third party's bad afternoon becoming
 * our outage.
 */
@Injectable()
export class ProviderGateway {
  private readonly providers: readonly FraudSignalProvider[];

  /**
   * Timestamps of the lookups started in the last minute.
   *
   * A sliding window rather than a fixed bucket: a fixed per-minute counter allows
   * twice the limit across a boundary, which is exactly when a burst happens — the
   * desk opening at 10:00 and everyone pasting a phone number at once.
   *
   * In-process, and that is honest rather than ideal. The limit it enforces is "this
   * replica will not start more than N lookups a minute", which is the property that
   * protects *us* from a runaway loop. A cluster-wide budget belongs in Valkey beside
   * the HTTP rate limiter and is logged as a follow-up; the reason it is not here is
   * that a Valkey outage must not be able to stop fraud checks, and getting that
   * fallback right is its own piece of work.
   */
  private readonly started: number[] = [];

  constructor(
    @Inject(FRAUD_CONFIG) private readonly config: FraudConfig,
    @Optional() @Inject(FRAUD_PROVIDERS) providers?: readonly FraudSignalProvider[],
  ) {
    this.providers = providers ?? [];
  }

  /**
   * Whether any provider could answer at all.
   *
   * The distinction the badge needs (check 3): no provider *configured* means the score
   * is internal by design and says nothing about providers, whereas a configured
   * provider that did not answer is a fact the desk should see.
   */
  get anyConfigured(): boolean {
    return this.providers.some((provider) => provider.configured);
  }

  /** The configured providers' names, for the caller's TTL bookkeeping. */
  get names(): readonly string[] {
    return this.providers.filter((provider) => provider.configured).map((p) => p.name);
  }

  /**
   * Look one number up at every configured provider.
   *
   * Concurrently, with one shared timeout, because they are independent and the desk is
   * waiting. `Promise.all` is safe here only because `lookup` never throws — that is
   * part of the interface's contract, and the `catch` below is a belt on top of it: a
   * provider that broke the contract would otherwise reject the whole batch and lose
   * the answers that did arrive.
   */
  async lookupAll(e164: string): Promise<Map<string, ProviderResult>> {
    const results = new Map<string, ProviderResult>();
    const configured = this.providers.filter((provider) => provider.configured);
    if (configured.length === 0) return results;

    if (!this.take(configured.length)) {
      // Throttled before the network, not by it. A provider that rate-limits us
      // eventually blocks us, and then every org loses the check at once — so the
      // ceiling is ours to enforce.
      for (const provider of configured) {
        results.set(provider.name, { status: 'unavailable', reason: 'throttled' });
      }
      return results;
    }

    const timeoutMs = this.config.FRAUD_PROVIDER_TIMEOUT_MS;

    await Promise.all(
      configured.map(async (provider) => {
        try {
          results.set(provider.name, await provider.lookup(e164, { timeoutMs }));
        } catch {
          // The interface says never throw. If one does, it is still just "no answer"
          // to the order desk — and the error is deliberately not logged, because a
          // provider's error text quotes the request, and the request is a phone
          // number (invariant 10).
          results.set(provider.name, { status: 'unavailable', reason: 'error' });
        }
      }),
    );

    return results;
  }

  /** Claim `count` slots in the sliding window, or refuse the whole batch. */
  private take(count: number): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    while (this.started.length > 0 && (this.started[0] ?? 0) < cutoff) this.started.shift();

    if (this.started.length + count > this.config.FRAUD_PROVIDER_RATE_PER_MINUTE) return false;
    for (let i = 0; i < count; i += 1) this.started.push(now);
    return true;
  }
}
