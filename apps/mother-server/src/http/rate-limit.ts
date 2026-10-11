/**
 * The credential limiter (D-487), the brand's two buckets (D-056): per address, generous,
 * because an office shares one; per identifier, tight, because that is what makes guessing
 * one account expensive however many addresses an attacker has. Both are counted before
 * either is judged.
 *
 * In memory: the mother runs one API process, so a process-wide counter is the whole
 * limit. Better Auth's own per-address limiter stays on underneath.
 */

export interface RateRule {
  readonly windowSeconds: number;
  readonly perIp: number;
  readonly perIdentifier?: number;
}

export const CREDENTIAL_RULES: Readonly<Record<string, RateRule>> = {
  '/api/auth/sign-in/email': { windowSeconds: 60, perIp: 20, perIdentifier: 5 },
  '/api/auth/reset-password': { windowSeconds: 60, perIp: 10 },
  '/api/auth/two-factor/verify-totp': { windowSeconds: 60, perIp: 10 },
  '/api/auth/two-factor/verify-backup-code': { windowSeconds: 60, perIp: 10 },
  // My account's checks of a password or a code (M40, D-705): per address here, and per
  // person in the account service, which refuses after five wrong answers in 15 minutes.
  '/v1/account/password': { windowSeconds: 60, perIp: 10 },
  '/v1/account/two-factor/new-app': { windowSeconds: 60, perIp: 10 },
  '/v1/account/two-factor/new-app/confirm': { windowSeconds: 60, perIp: 10 },
  '/v1/account/two-factor/backup-codes': { windowSeconds: 60, perIp: 10 },
};

export interface RateDecision {
  readonly allowed: boolean;
  readonly retryAfterSeconds?: number;
  readonly bucket?: 'ip' | 'identifier';
}

export class MemoryRateLimiter {
  private readonly counters = new Map<string, { count: number; resetAt: number }>();
  private lastSweep = 0;

  constructor(private readonly now: () => number = Date.now) {}

  hit(key: string, limit: number, windowSeconds: number): RateDecision {
    const now = this.now();
    if (now - this.lastSweep > 1000) {
      this.lastSweep = now;
      for (const [entry, counter] of this.counters) {
        if (counter.resetAt <= now) this.counters.delete(entry);
      }
    }
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
}

/** The path a request names, resolved the way Better Auth will read it (no `..` tricks). */
export function requestPath(url: string): string {
  try {
    return new URL(url, 'http://request.invalid').pathname;
  } catch {
    return url.split('?')[0] ?? '';
  }
}

/**
 * The path as the router matches it: find-my-way decodes percent-escapes before it routes,
 * so `/v1/account/%70assword` reaches the password handler and must meet its limit (the M40
 * audit's W2). Better Auth's router does not decode, so for `/api/auth` this can only add a
 * limit to a path that then matches nothing.
 */
export function routedPath(url: string): string {
  const path = requestPath(url);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

export function identifierFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const email = (body as Record<string, unknown>).email;
  if (typeof email !== 'string') return null;
  const normalised = email.trim().toLowerCase();
  return normalised === '' ? null : normalised;
}

export function checkRate(
  limiter: MemoryRateLimiter,
  input: { readonly url: string; readonly ip: string; readonly body: unknown },
  rules: Readonly<Record<string, RateRule>> = CREDENTIAL_RULES,
): RateDecision {
  const path = routedPath(input.url);
  const rule = rules[path];
  if (rule === undefined) return { allowed: true };
  const ip = limiter.hit(`ip:${path}:${input.ip}`, rule.perIp, rule.windowSeconds);
  const identifier = rule.perIdentifier === undefined ? null : identifierFrom(input.body);
  const byIdentifier =
    identifier === null || rule.perIdentifier === undefined
      ? { allowed: true }
      : limiter.hit(`id:${path}:${identifier}`, rule.perIdentifier, rule.windowSeconds);
  if (!byIdentifier.allowed) return { ...byIdentifier, bucket: 'identifier' };
  if (!ip.allowed) return { ...ip, bucket: 'ip' };
  return { allowed: true };
}
