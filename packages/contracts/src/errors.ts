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
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: string): value is ErrorCode {
  return (ERROR_CODES as readonly string[]).includes(value);
}
