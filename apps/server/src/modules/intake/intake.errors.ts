import { HttpException, HttpStatus } from '@nestjs/common';
import { isErrorCode, type ErrorCode } from '@elysium/contracts';

/**
 * The public intake's refusals, as RFC 9457 problems with codes from `errors.ts` (§23).
 *
 * The codes are the platform's general ones on purpose — `UNAUTHENTICATED`, `FORBIDDEN`,
 * `RATE_LIMITED`, `IDEMPOTENCY_*` — rather than intake-specific inventions: a landing-page
 * developer branches on "sign it again", "slow down" and "retry later", and those are
 * already named. What they must never be able to branch on is *which* authentication check
 * failed, so every one of them is the same 401 with the same sentence.
 */
export class IntakeError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    /** Seconds, for a 429. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'IntakeError';
  }

  toHttp(): HttpException {
    return new HttpException({ code: this.code, message: this.message }, this.status);
  }
}

/**
 * One sentence for every authentication failure: unknown key, revoked key, stale timestamp,
 * wrong signature, a key issued under a different master key.
 *
 * Distinguishing them would tell a prober which part of a forged request was right — that
 * the key id exists, say, and only the signature is off — which is exactly the information
 * an HMAC scheme exists to withhold. The server log says which check failed.
 */
export function notAuthenticated(): IntakeError {
  return new IntakeError(
    'UNAUTHENTICATED',
    HttpStatus.UNAUTHORIZED,
    'The request was not accepted: check the key id, the timestamp and the signature.',
  );
}

/**
 * A refusal from the orders module (a bad phone, an unknown SKU, a missing zone), as a 4xx.
 *
 * The orders module's domain and service errors both carry a contract `code`. They are
 * turned into problems here rather than by importing that module's own mapper, because
 * `orders.errors.ts` is not its `*.api.ts` (invariant 12) — and because what a *public*
 * caller should be told differs: a landing page can fix its body, it cannot "reload the
 * order", so everything the caller could have sent differently is a 400.
 */
const NOT_FOUND: readonly string[] = ['CUSTOMER_NOT_FOUND', 'DELIVERY_ZONE_NOT_FOUND'];

export function fromOrdersRefusal(error: unknown): HttpException | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !isErrorCode(code)) return null;
  const status = NOT_FOUND.includes(code)
    ? HttpStatus.UNPROCESSABLE_ENTITY
    : HttpStatus.BAD_REQUEST;
  return new HttpException({ code, message: error.message }, status);
}
