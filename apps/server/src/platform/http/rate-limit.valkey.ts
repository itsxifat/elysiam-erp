import {
  MemoryRateLimiter,
  type RateLimitDecision,
  type RateLimitPeek,
  type RateLimitStore,
} from './rate-limit.js';

/**
 * The credential rate limiter's counters, in Valkey (D-056's stated exit).
 *
 * D-056 resolved the *policy* — two buckets, per IP and per identifier, either
 * of which can reject — and recorded that the store was in memory and therefore
 * per process. That is not a detail: with N API replicas behind the load
 * balancer, an attacker gets N times the allowance, and which replica answers is
 * outside their control but also outside ours. Five attempts per account per
 * minute becomes fifteen. Moving the counters here makes the published limit the
 * real one.
 *
 * The policy, the rules and the 429 are unchanged and still live in
 * `rate-limit.ts`; this file is only the counter.
 */

/**
 * The subset of ioredis this needs.
 *
 * Structural rather than `import { Redis }`, so the limiter can be unit-tested
 * against a fake and so this module does not decide how the connection is
 * configured — the composition root already owns that for the realtime adapter,
 * and two places creating Valkey clients with different retry settings is how
 * one of them ends up wrong.
 */
export interface ValkeyScriptClient {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

/**
 * Increment, set the expiry if it is a new window, and report the remaining TTL
 * — atomically.
 *
 * Atomicity is the whole reason this is a script rather than three commands. The
 * obvious version is `INCR` then `EXPIRE`, and it has a failure that is rare,
 * permanent and very hard to diagnose: if the process dies, the connection drops
 * or the server fails over between the two, the key exists with **no TTL**. The
 * counter then never resets, and that IP or that account is locked out of signing
 * in forever — a lockout no code path can clear and no operator would think to
 * look for in a cache.
 *
 * The `ttl < 0` branch repairs a key that somehow has no expiry anyway (a manual
 * `SET`, a restore from a snapshot taken mid-window), because a limiter whose
 * worst case is a permanent lockout should be able to heal itself.
 */
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if count == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {count, ttl}
`.trim();

/** Read a counter and its TTL without touching either (D-416). */
const PEEK_SCRIPT = `
local count = redis.call('GET', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
return {tonumber(count) or 0, ttl}
`.trim();

export interface ValkeyRateLimiterOptions {
  readonly client: ValkeyScriptClient;
  /**
   * Namespace for the keys.
   *
   * Environments must not share one, or staging's load test locks production's
   * users out — the counters are keyed by path and identifier, which are
   * identical across environments. Same reasoning as the realtime adapter's
   * channel key.
   */
  readonly keyPrefix?: string;
  /**
   * Where to count when Valkey will not answer. Defaults to a private
   * `MemoryRateLimiter`.
   */
  readonly fallback?: RateLimitStore;
  /** Called once per failure, so an outage is visible rather than inferred. */
  readonly onError?: (error: unknown) => void;
}

export class ValkeyRateLimiter implements RateLimitStore {
  private readonly client: ValkeyScriptClient;
  private readonly keyPrefix: string;
  private readonly fallback: RateLimitStore;
  private readonly onError: ((error: unknown) => void) | undefined;

  constructor(options: ValkeyRateLimiterOptions) {
    this.client = options.client;
    this.keyPrefix = options.keyPrefix ?? 'rl';
    this.fallback = options.fallback ?? new MemoryRateLimiter();
    this.onError = options.onError;
  }

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision> {
    const namespaced = `${this.keyPrefix}:${key}`;

    let reply: unknown;
    try {
      reply = await this.client.eval(HIT_SCRIPT, 1, namespaced, String(windowSeconds * 1000));
    } catch (error) {
      /*
       * Valkey is unreachable, and neither extreme is acceptable.
       *
       * Failing closed would refuse every sign-in while the cache is down — a
       * cache outage becoming an authentication outage. Failing open would turn
       * the limiter off entirely at the moment monitoring is already noisy,
       * which is exactly when credential stuffing is cheapest.
       *
       * So the counters degrade to per process: the limit becomes N times looser
       * with N replicas, which is where it was before M04, rather than absent.
       */
      this.onError?.(error);
      return this.fallback.hit(key, limit, windowSeconds);
    }

    const parsed = readReply(reply);
    if (parsed === null) {
      // A reply we cannot read means the script did not run as expected — a
      // different server, a proxy rewriting replies. Treated as an outage rather
      // than as an allowance, for the same reason as above.
      this.onError?.(new Error(`Unreadable rate-limit reply: ${JSON.stringify(reply)}`));
      return this.fallback.hit(key, limit, windowSeconds);
    }

    const { count, ttlMs } = parsed;
    if (count <= limit) return { allowed: true };

    return {
      allowed: false,
      // At least a second: a `retry-after: 0` invites an immediate retry, which
      // is a busy loop against the endpoint the limiter is protecting.
      retryAfterSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
    };
  }

  async peek(key: string): Promise<RateLimitPeek> {
    const namespaced = `${this.keyPrefix}:${key}`;
    let reply: unknown;
    try {
      reply = await this.client.eval(PEEK_SCRIPT, 1, namespaced);
    } catch (error) {
      // As for `hit`: degrade to this process's counters rather than to "nothing spent".
      this.onError?.(error);
      return this.fallback.peek(key);
    }
    const parsed = readReply(reply);
    if (parsed === null) {
      this.onError?.(new Error(`Unreadable rate-limit reply: ${JSON.stringify(reply)}`));
      return this.fallback.peek(key);
    }
    return {
      count: parsed.count,
      retryAfterSeconds: parsed.ttlMs > 0 ? Math.max(1, Math.ceil(parsed.ttlMs / 1000)) : 0,
    };
  }
}

/**
 * Read `{count, ttl}` out of the script's reply.
 *
 * RESP integers arrive as numbers through ioredis, but a Lua table can also come
 * back with string members depending on the client and the server version, so
 * both are accepted. Guessing wrong here would make every hit unreadable and
 * silently park the limiter on its fallback — a degradation with no symptom.
 */
function readReply(reply: unknown): { count: number; ttlMs: number } | null {
  if (!Array.isArray(reply) || reply.length < 2) return null;

  const count = Number(reply[0]);
  const ttlMs = Number(reply[1]);
  if (!Number.isFinite(count) || !Number.isFinite(ttlMs)) return null;

  return { count, ttlMs };
}
