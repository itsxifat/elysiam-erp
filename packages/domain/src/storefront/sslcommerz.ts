import { poisha, type Poisha } from '../money/index.js';
import { takaDecimal } from './price.js';

/**
 * SSLCommerz, as rules (M34, D-525): what an amount looks like on the wire, and whether a
 * validated payment may be accepted. The adapter (`apps/server/.../sslcommerz.gateway.ts`) does
 * the talking; nothing here touches a network.
 *
 * Built from SSLCommerz's developer documentation (v4: session initiation, the IPN, the
 * Order Validation API) and the old site's working `sslcommerz-lts` flow. UNVERIFIED until a
 * sandbox run (decisions.md, "Unverified integrations").
 */

/** The smallest and largest session SSLCommerz takes, in BDT (its documentation: 10.00–500000.00). */
export const SSLCOMMERZ_MIN_POISHA = 1_000n;
export const SSLCOMMERZ_MAX_POISHA = 50_000_000n;

/** How long an unpaid online order holds its stock before it is cancelled (D-527). */
export const UNPAID_ONLINE_ORDER_MINUTES = 60;

/** `total_amount` as SSLCommerz reads it: taka with two decimals, from integer poisha. */
export function gatewayAmount(amount: Poisha): string {
  return takaDecimal(amount);
}

/**
 * A gateway's decimal amount as exact poisha, or null when it is not one.
 *
 * Up to four decimals are read (some gateway answers pad), but anything past the second must
 * be zero: a payment of ৳1250.005 is not an amount this system can hold, and rounding it would
 * be inventing money (invariant 1).
 */
export function parseGatewayAmount(text: unknown): Poisha | null {
  if (typeof text !== 'string' && typeof text !== 'number') return null;
  const value = String(text).trim();
  const match = /^(\d{1,13})(?:\.(\d{1,4}))?$/.exec(value);
  if (match === null) return null;
  const [, whole = '0', fraction = ''] = match;
  if (fraction.length > 2 && !/^0+$/.test(fraction.slice(2))) return null;
  const cents = (fraction + '00').slice(0, 2);
  return poisha(BigInt(whole) * 100n + BigInt(cents));
}

/** Whether an amount can be paid through SSLCommerz at all. */
export function payableOnline(amount: Poisha): boolean {
  return amount >= SSLCOMMERZ_MIN_POISHA && amount <= SSLCOMMERZ_MAX_POISHA;
}

/** The Order Validation API's answer, as far as the decision needs it. Untrusted input. */
export interface GatewayValidation {
  readonly status?: unknown;
  readonly tran_id?: unknown;
  readonly val_id?: unknown;
  readonly amount?: unknown;
  readonly currency?: unknown;
  readonly currency_type?: unknown;
  readonly currency_amount?: unknown;
  readonly risk_level?: unknown;
}

export type ValidationRefusal =
  'not_valid' | 'transaction_mismatch' | 'currency_not_bdt' | 'amount_mismatch' | 'malformed';

export type ValidationVerdict =
  | { readonly ok: true; readonly amountPoisha: Poisha; readonly risky: boolean }
  | { readonly ok: false; readonly reason: ValidationRefusal };

/**
 * Accept a validated payment, or say why not (D-525).
 *
 * The validation API is the only evidence: the IPN's own fields and the return page's are
 * never trusted. Accepted only when SSLCommerz says VALID or VALIDATED, for this session's
 * transaction id, in BDT, for **exactly** the amount the session asked — the old site never
 * compared the amount, so a shopper who paid ৳10 for a ৳10,000 order was marked paid.
 * `currency_type` and `currency_amount` (the request's currency and amount) are checked when
 * the gateway sends them. A risky payment (`risk_level` 1) is accepted and flagged for the desk,
 * which confirms every website order by hand anyway.
 */
export function judgeValidation(
  session: { readonly tranId: string; readonly amountPoisha: Poisha },
  answer: GatewayValidation,
): ValidationVerdict {
  if (answer.status !== 'VALID' && answer.status !== 'VALIDATED') {
    return { ok: false, reason: 'not_valid' };
  }
  if (answer.tran_id !== session.tranId) return { ok: false, reason: 'transaction_mismatch' };
  if (answer.currency !== 'BDT') return { ok: false, reason: 'currency_not_bdt' };
  const amount = parseGatewayAmount(answer.amount);
  if (amount === null) return { ok: false, reason: 'malformed' };
  if (amount !== session.amountPoisha) return { ok: false, reason: 'amount_mismatch' };
  if (answer.currency_type !== undefined && answer.currency_type !== null) {
    if (answer.currency_type !== 'BDT') return { ok: false, reason: 'currency_not_bdt' };
    const requested = parseGatewayAmount(answer.currency_amount);
    if (requested === null) return { ok: false, reason: 'malformed' };
    if (requested !== session.amountPoisha) return { ok: false, reason: 'amount_mismatch' };
  }
  const risky = answer.risk_level === 1 || answer.risk_level === '1';
  return { ok: true, amountPoisha: amount, risky };
}
