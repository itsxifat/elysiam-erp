import type { FastifyReply, FastifyRequest } from 'fastify';

import { instanceOf, problemFor, PROBLEM_CONTENT_TYPE } from './problem.js';

/**
 * Rate limiting for the credential endpoints (architecture §25).
 *
 * Better Auth ships a limiter, and it is keyed `${ip}|${path}` — per IP only.
 * That is close to useless against the attack that actually happens here:
 * credential stuffing from a botnet gets the full allowance *per address*, so
 * one targeted account absorbs as many attempts as the attacker has hosts. And
 * per-IP alone is actively harmful in Bangladesh, where most mobile traffic
 * shares a handful of carrier NAT addresses — one attacker behind Grameenphone
 * locks out everyone else behind it.
 *
 * So both buckets are counted, and either one can reject:
 *
 *   per IP          — the shared-address bucket, generous
 *   per identifier  — the email or phone being attempted, tight
 *
 * The identifier bucket is what makes stuffing one account expensive regardless
 * of how many addresses the attacker has. The IP bucket is what stops a single
 * host walking a list of accounts.
 *
 * Better Auth's own limiter stays on underneath as defence in depth, with each
 * per-address allowance equal to the bucket here (`LIBRARY_RATE_RULES`, D-168). It
 * used to allow five sign-ins a minute per address, which made it the binding limit
 * and undid the point of the generous bucket above.
 */

export interface RateLimitRule {
  /** Window length in seconds. */
  readonly windowSeconds: number;
  /** Attempts allowed per window, per IP. */
  readonly perIp: number;
  /** Attempts allowed per window, per identifier. Omitted where there is none. */
  readonly perIdentifier?: number;
}

/**
 * The endpoints worth guessing against, and nothing else.
 *
 * An allowlist rather than a default-on rule: limiting every route would throttle
 * the order desk, and the routes that need it are exactly the ones where a wrong
 * answer is cheap to retry.
 */
export const CREDENTIAL_RULES: Readonly<Record<string, RateLimitRule>> = {
  '/api/auth/sign-in/email': { windowSeconds: 60, perIp: 20, perIdentifier: 5 },
  '/api/auth/sign-in/phone-number': { windowSeconds: 60, perIp: 20, perIdentifier: 5 },
  '/api/auth/sign-up/email': { windowSeconds: 60, perIp: 10, perIdentifier: 3 },
  '/api/auth/phone-number/send-otp': { windowSeconds: 60, perIp: 10, perIdentifier: 3 },
  '/api/auth/request-password-reset': { windowSeconds: 60, perIp: 10, perIdentifier: 3 },
  '/api/auth/reset-password': { windowSeconds: 60, perIp: 10 },
  // No identifier in the body — the pending user is named by a signed cookie —
  // so these are per IP only. The second factor has its own lockout inside
  // Better Auth, which counts failures against the user.
  '/api/auth/two-factor/verify-totp': { windowSeconds: 60, perIp: 10 },
  '/api/auth/two-factor/verify-backup-code': { windowSeconds: 60, perIp: 10 },
  // M31 (D-473): an owner sign-in link. Its token names no identifier worth a bucket of its
  // own; a link is single use and two minutes long, so ten a minute is plenty.
  '/v1/auth/owner-link': { windowSeconds: 60, perIp: 10 },
  // M35b (D-554): the packing scanner's sign-in takes an email and a password like the
  // console's; the old site allowed eight tries in ten minutes per address, and so does this,
  // per address and per email.
  '/v1/scanner/sign-in': { windowSeconds: 600, perIp: 8, perIdentifier: 8 },
};

/**
 * The path a request names, read the way the code that finally serves it reads it (M30).
 *
 * The rules are keyed by path, and the raw `request.url` is not the path Better Auth acts
 * on: the bridge in `auth-plugin.ts` hands it a WHATWG `URL`, which resolves `.` and `..`
 * segments (and their `%2e` spellings), while Fastify's router does not normalise at all.
 * Keyed by the raw url, `POST /api/auth/x/../sign-in/email` matched no rule here and was
 * still a sign-in there: credential stuffing with both buckets skipped. Every lookup that
 * decides something about an `/api/auth` request goes through this one function, so the
 * limiter, the enrolment hatch and the bridge cannot read one request two ways.
 */
export function requestPath(url: string): string {
  try {
    return new URL(url, 'http://request.invalid').pathname;
  } catch {
    return url.split('?')[0] ?? '';
  }
}

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Which bucket rejected, for the log. Never sent to the client. */
  readonly bucket?: 'ip' | 'identifier';
  readonly retryAfterSeconds?: number;
}

interface Counter {
  count: number;
  /** Epoch ms when this window ends. */
  resetAt: number;
}

/**
 * Where the counters live.
 *
 * An interface because D-056 said the in-memory store was temporary and named
 * Valkey as its exit, and M04 takes it: `ValkeyRateLimiter` in
 * `rate-limit.valkey.ts` makes the limits global across replicas, while this
 * file's `MemoryRateLimiter` stays as the test store and as the fallback for
 * when Valkey is unreachable.
 *
 * `hit` may return a promise, which is the one thing that could not stay the
 * same: a network round trip cannot be pretended away, so `checkRateLimit` is
 * async. Everything else — the two buckets, the rules, the 429 — is untouched.
 */
export interface RateLimitStore {
  hit(
    key: string,
    limit: number,
    windowSeconds: number,
  ): RateLimitDecision | Promise<RateLimitDecision>;

  /**
   * How many hits `key` holds in its current window, without counting one (D-416).
   *
   * For a budget that only some outcomes spend: the tracking page asks before it looks
   * whether a brand's misses are spent, and spends one only when the answer is a miss.
   */
  peek(key: string): RateLimitPeek | Promise<RateLimitPeek>;
}

export interface RateLimitPeek {
  readonly count: number;
  /** Seconds until the window resets; 0 when the key holds nothing. */
  readonly retryAfterSeconds: number;
}

/**
 * A fixed-window counter.
 *
 * In memory, which means per process: with several API replicas the effective
 * threshold multiplies by the replica count. That is why the store became an
 * interface, and M04 took D-056's stated exit — `ValkeyRateLimiter` is the
 * production store and the limits are global across replicas.
 *
 * This one stays, for two jobs rather than one:
 *
 * - the test store, because a suite that drives dozens of logins should not need
 *   Valkey running to do it;
 * - the **fallback** when Valkey is unreachable. Failing closed there would take
 *   sign-in down for everyone whenever the cache blinks; failing open would hand
 *   an attacker an unlimited window at exactly the moment nobody is watching.
 *   Degrading to a per-process limit is worse than global and far better than
 *   either.
 */
export class MemoryRateLimiter implements RateLimitStore {
  private readonly counters = new Map<string, Counter>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Count one attempt against `key`. True when it is still within `limit`. */
  hit(key: string, limit: number, windowSeconds: number): RateLimitDecision {
    const now = this.now();
    this.sweep(now);

    const existing = this.counters.get(key);
    if (existing === undefined || existing.resetAt <= now) {
      this.counters.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true };
    }

    existing.count += 1;
    if (existing.count > limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }

    return { allowed: true };
  }

  /**
   * Drop expired counters.
   *
   * Without this the map grows by one entry per distinct email ever attempted,
   * which is a memory-exhaustion vector handed to the same attacker the limiter
   * exists to stop. Swept at most once a second, so it costs nothing per request.
   */
  private sweep(now: number): void {
    if (now - this.lastSweep < 1000) return;
    this.lastSweep = now;
    for (const [key, counter] of this.counters) {
      if (counter.resetAt <= now) this.counters.delete(key);
    }
  }

  peek(key: string): RateLimitPeek {
    const now = this.now();
    const existing = this.counters.get(key);
    if (existing === undefined || existing.resetAt <= now)
      return { count: 0, retryAfterSeconds: 0 };
    return {
      count: existing.count,
      retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
    };
  }

  /** Test seam. */
  reset(): void {
    this.counters.clear();
    this.lastSweep = 0;
  }
}

/**
 * The identifier being attempted, normalised.
 *
 * Lower-cased and trimmed so `Victim@Example.com` and `victim@example.com` share
 * a bucket — otherwise the limit is one `toUpperCase()` away from meaningless.
 */
export function identifierFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;

  // First non-empty of the two, not `email ?? phoneNumber`: an empty string is
  // not nullish, so `{ email: '', phoneNumber: '+880...' }` would short-circuit
  // to no identifier and walk straight past the identifier bucket.
  const record = body as Record<string, unknown>;
  for (const field of ['email', 'phoneNumber'] as const) {
    const raw = record[field];
    if (typeof raw !== 'string') continue;
    const normalised = raw.trim().toLowerCase();
    if (normalised !== '') return normalised;
  }

  return null;
}

export interface RateLimitOptions {
  readonly limiter: RateLimitStore;
  readonly rules?: Readonly<Record<string, RateLimitRule>>;
  /** Off only in tests that need to drive many logins. */
  readonly enabled?: boolean;
}

/**
 * Decide whether this request may proceed.
 *
 * Both buckets are incremented before either is judged, deliberately: counting
 * only until the first rejection would let an attacker keep one bucket cold by
 * making sure the other always trips first.
 */
export async function checkRateLimit(
  request: FastifyRequest,
  options: RateLimitOptions,
): Promise<RateLimitDecision> {
  if (options.enabled === false) return { allowed: true };

  const rules = options.rules ?? CREDENTIAL_RULES;
  // Query strings never select an endpoint here, and neither do dot segments: the path is
  // the one Better Auth will route (`requestPath`), so `?x=1` and `/x/../` cannot walk
  // straight past the rule.
  const path = requestPath(request.url);
  const rule = rules[path];
  if (rule === undefined) return { allowed: true };

  const identifier = rule.perIdentifier === undefined ? null : identifierFrom(request.body);

  // Concurrently, so a Valkey-backed store costs one round trip's latency rather
  // than two on the login path — and so both buckets are still counted whatever
  // either answers, which is the rule this function exists to enforce.
  const [ipDecision, identifierDecision] = await Promise.all([
    options.limiter.hit(`ip:${path}:${request.ip}`, rule.perIp, rule.windowSeconds),
    identifier === null || rule.perIdentifier === undefined
      ? Promise.resolve<RateLimitDecision>({ allowed: true })
      : options.limiter.hit(`id:${path}:${identifier}`, rule.perIdentifier, rule.windowSeconds),
  ]);

  if (!identifierDecision.allowed) {
    return { ...identifierDecision, bucket: 'identifier' };
  }
  if (!ipDecision.allowed) return { ...ipDecision, bucket: 'ip' };

  return { allowed: true };
}

/**
 * The 429.
 *
 * Says nothing about which bucket tripped. "Too many attempts for this account"
 * would confirm the account exists, turning the limiter into the account
 * enumeration oracle the login endpoint is careful not to be.
 */
export function sendRateLimited(reply: FastifyReply, decision: RateLimitDecision): void {
  /*
   * Built by `problemFor`, not by hand.
   *
   * This runs in a Fastify hook, before Nest exists, so `ProblemFilter` will
   * never see it — and that is exactly how the body drifted: it was
   * `{ type: 'about:blank', title: 'Too Many Requests', … }` while every other
   * error carried `/problems/<code>` and a code from `errors.ts`. A client then
   * had to know which layer refused it before it could read why. The document is
   * the same shape whichever layer answers.
   */
  void reply
    .status(429)
    .header('retry-after', String(decision.retryAfterSeconds ?? 60))
    .header('content-type', PROBLEM_CONTENT_TYPE)
    .send(
      problemFor({
        status: 429,
        code: 'RATE_LIMITED',
        detail: 'Too many attempts. Wait a minute and try again.',
        instance: instanceOf(reply.request.url),
      }),
    );
}
