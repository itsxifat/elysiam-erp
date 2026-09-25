/**
 * Stable error codes (architecture §23 "Errors").
 *
 * A response that fails carries one of these as `code`, so a client branches
 * on a code rather than on the wording of a message. M03 seeds the ledger's;
 * M04 turns every error into RFC 9457 problem+json around the same codes
 * (D-087). Codes are append-only: renaming one breaks every client that
 * branches on it.
 */
export const ERROR_CODES = [
  // Ledger (M03)
  'PERIOD_CLOSED',
  'PERIOD_NOT_ENDED',
  'PERIOD_ALREADY_CLOSED',
  'PERIOD_NOT_CLOSED',
  'PERIOD_REOPEN_UNAUTHORISED',
  'PERIOD_REOPEN_PENDING',
  'PERIOD_LATER_CLOSED',
  'JOURNAL_UNBALANCED',
  'JOURNAL_TOO_FEW_LINES',
  'JOURNAL_LINE_INVALID',
  'JOURNAL_KEY_INVALID',
  'JOURNAL_DATE_INVALID',
  'JOURNAL_NOT_FOUND',
  'IDEMPOTENCY_CONFLICT',
  'LEDGER_ACCOUNT_INVALID',
  'LEDGER_ACCOUNT_NOT_FOUND',
  'LEDGER_IMMUTABLE',
  'POSTING_INPUT_INVALID',
  'MONEY_INVALID',
  'MONEY_OVERFLOW',
  // Named by §23; owned by later milestones.
  'STOCK_INSUFFICIENT',
  'ORDER_TRANSITION_INVALID',
  'APPROVAL_REQUIRED',

  /*
   * The HTTP layer's own codes (M04, §23).
   *
   * problem+json needs a `code` for *every* failure, not only the ones a domain
   * module raised, or a client has to branch on the status alone for the rest —
   * and a status is not specific enough to act on: 409 already means both
   * "period closed" and "this idempotency key is still in flight", which call
   * for opposite responses (tell the user vs. retry in a moment).
   */
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'CONFLICT',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
  'SERVICE_UNAVAILABLE',
  /** The `Idempotency-Key` header is present but unusable (too short, too long). */
  'IDEMPOTENCY_KEY_INVALID',
  /**
   * A key whose first request has not answered yet. Distinct from
   * `IDEMPOTENCY_CONFLICT`, which means the same key arrived with a *different*
   * body: this one is retryable in a moment, that one never is.
   */
  'IDEMPOTENCY_IN_FLIGHT',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}
