/**
 * Cloudflare Turnstile's server-side check (architecture §23: "a Turnstile token for
 * browser forms").
 *
 * Built against Cloudflare's own documentation, "Server-side validation"
 * (developers.cloudflare.com/turnstile/get-started/server-side-validation), and nothing
 * else:
 *
 * * `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`, form-encoded or JSON;
 *   this sends `application/x-www-form-urlencoded`.
 * * Fields: `secret` and `response` required; `remoteip` and `idempotency_key` optional.
 *   `response` is at most 2048 characters.
 * * Answer: `success`, `challenge_ts`, `hostname`, `error-codes`, `action`, `cdata`.
 * * Tokens live 300 seconds and **validate once**: a second siteverify of the same token
 *   answers `timeout-or-duplicate` — unless the retry carries the same `idempotency_key`,
 *   which Cloudflare documents as the way to retry a validation safely.
 *
 * That last point decides how this is called. The key sent is the id of the intake's
 * claim row, which a retry of the same request takes over rather than replaces — so a
 * landing page whose first attempt timed out after Cloudflare had already spent the token
 * gets the same verdict on retry instead of a spurious "duplicate".
 *
 * **Never inside a transaction** (invariant 6). The service calls this between the claim's
 * commit and the order's transaction, so a slow Cloudflare holds no row lock and no pool
 * connection.
 */

export interface TurnstileVerdict {
  readonly success: boolean;
  /** Cloudflare's `error-codes`, verbatim, for the log. Never sent to the client. */
  readonly errorCodes: readonly string[];
  /** True when Cloudflare could not be asked, rather than said no. */
  readonly unavailable: boolean;
  readonly hostname: string | null;
}

export interface TurnstileVerifier {
  verify(input: {
    readonly token: string;
    readonly remoteIp: string | null;
    readonly idempotencyKey: string;
  }): Promise<TurnstileVerdict>;
}

/** The documented upper bound on a token. Longer is refused without asking Cloudflare. */
export const TURNSTILE_TOKEN_MAX = 2048;

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class CloudflareTurnstile implements TurnstileVerifier {
  constructor(
    private readonly options: {
      readonly secret: string;
      readonly url: string;
      readonly timeoutMs: number;
      /** Injectable for the unit test; the real one is the platform `fetch`. */
      readonly fetch?: FetchLike;
    },
  ) {}

  async verify(input: {
    readonly token: string;
    readonly remoteIp: string | null;
    readonly idempotencyKey: string;
  }): Promise<TurnstileVerdict> {
    if (input.token === '' || input.token.length > TURNSTILE_TOKEN_MAX) {
      return {
        success: false,
        errorCodes: ['invalid-input-response'],
        unavailable: false,
        hostname: null,
      };
    }

    const form = new URLSearchParams({
      secret: this.options.secret,
      response: input.token,
      idempotency_key: input.idempotencyKey,
    });
    if (input.remoteIp !== null) form.set('remoteip', input.remoteIp);

    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.options.url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch {
      // Timed out or unreachable. Not a verdict about the visitor, so it is reported as
      // unavailability and the service answers 503 — retryable — rather than 403.
      return { success: false, errorCodes: ['unreachable'], unavailable: true, hostname: null };
    }

    if (!response.ok) {
      return {
        success: false,
        errorCodes: [`http-${String(response.status)}`],
        unavailable: true,
        hostname: null,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { success: false, errorCodes: ['unreadable'], unavailable: true, hostname: null };
    }

    const record = (body ?? {}) as {
      success?: unknown;
      'error-codes'?: unknown;
      hostname?: unknown;
    };
    const errorCodes = Array.isArray(record['error-codes'])
      ? record['error-codes'].filter((code): code is string => typeof code === 'string')
      : [];
    return {
      // Strictly `true`. A proxy that rewrote the body into something truthy must not be
      // able to turn "unknown" into "passed".
      success: record.success === true,
      errorCodes,
      // Cloudflare's own failure is not the visitor's either.
      unavailable: record.success !== true && errorCodes.includes('internal-error'),
      hostname: typeof record.hostname === 'string' ? record.hostname : null,
    };
  }
}

/**
 * Development and tests only. `intakeConfig()` refuses to start a production process with
 * the flag that selects this, so there is no configuration in which it guards real orders.
 */
export class BypassTurnstile implements TurnstileVerifier {
  verify(): Promise<TurnstileVerdict> {
    return Promise.resolve({ success: true, errorCodes: [], unavailable: false, hostname: null });
  }
}

/** No secret configured: every check fails closed as unavailable, so the intake answers 503. */
export class UnconfiguredTurnstile implements TurnstileVerifier {
  verify(): Promise<TurnstileVerdict> {
    return Promise.resolve({
      success: false,
      errorCodes: ['not-configured'],
      unavailable: true,
      hostname: null,
    });
  }
}
