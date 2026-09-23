import type { FastifyReply, FastifyRequest } from 'fastify';

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
 * Better Auth's own limiter stays on underneath as defence in depth.
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
};

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
 * A fixed-window counter.
 *
 * In memory, which means per process: with several API replicas the effective
 * threshold multiplies by the replica count. That is a real limitation and it is
 * why the store is an interface — M04 moves it to Valkey, which is already in
 * the stack, and the limits become global (D-056). Until then a fixed window in
 * memory is still far better than the per-IP-only limiter it replaces.
 */
export class MemoryRateLimiter {
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
  readonly limiter: MemoryRateLimiter;
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
export function checkRateLimit(
  request: FastifyRequest,
  options: RateLimitOptions,
): RateLimitDecision {
  if (options.enabled === false) return { allowed: true };

  const rules = options.rules ?? CREDENTIAL_RULES;
  // Query strings never select an endpoint here; matching the raw url would let
  // `?x=1` walk straight past the rule.
  const path = request.url.split('?')[0] ?? '';
  const rule = rules[path];
  if (rule === undefined) return { allowed: true };

  const ipDecision = options.limiter.hit(
    `ip:${path}:${request.ip}`,
    rule.perIp,
    rule.windowSeconds,
  );

  const identifier = rule.perIdentifier === undefined ? null : identifierFrom(request.body);
  const identifierDecision =
    identifier === null || rule.perIdentifier === undefined
      ? { allowed: true }
      : options.limiter.hit(`id:${path}:${identifier}`, rule.perIdentifier, rule.windowSeconds);

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
  void reply
    .status(429)
    .header('retry-after', String(decision.retryAfterSeconds ?? 60))
    .send({
      type: 'about:blank',
      title: 'Too Many Requests',
      status: 429,
      code: 'RATE_LIMITED',
      detail: 'Too many attempts. Wait a minute and try again.',
    });
}
