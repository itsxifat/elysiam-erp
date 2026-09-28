import { LedgerError } from '../ledger/index.js';
import { type Poisha } from '../money/index.js';

/**
 * What a courier needs to take a parcel, checked before we ask (architecture §9).
 *
 * Pure, and it is here rather than in the adapter for one reason: a booking is an
 * outbound HTTP call inside a retrying job (invariant 6, §20), and a parcel the
 * courier will always refuse must fail *before* the job exists. Otherwise a missing
 * phone number costs five retries with exponential backoff, three minutes of queue
 * time and a `delivery.booking_failed` alert that says the courier rejected us when
 * in fact we sent rubbish.
 *
 * The rules are the ones every Bangladeshi courier shares — a name, a reachable
 * local number, an address a rider can find, and a COD amount that is not negative —
 * and nothing provider-specific. Anything a single courier insists on belongs in its
 * own adapter, because a rule applied to every courier on one courier's authority is
 * how the second integration ends up impossible.
 */

/** The address as a courier wants it: one block of text plus the admin divisions. */
export interface ParcelAddress {
  readonly recipientName: string;
  /** E.164, as `sales.orders.ship_phone_e164` stores it. */
  readonly recipientPhoneE164: string;
  readonly district: string;
  readonly thana: string;
  readonly area: string | null;
  readonly addressLine: string;
}

export interface ParcelInput {
  /**
   * Our own reference, echoed back on the statement.
   *
   * The order number, not the order id. A uuid in a courier's `invoice` field is
   * unreadable on a printed manifest and on a settlement sheet, and the settlement
   * matcher's secondary key is exactly this string — so it has to be the thing a
   * human and the courier both call the order.
   */
  readonly reference: string;
  readonly address: ParcelAddress;
  /** What the rider collects. Zero for a prepaid parcel. */
  readonly codAmountPoisha: Poisha;
  readonly itemDescription: string | null;
  readonly note: string | null;
  /** Declared weight in grams, when the org tracks it. */
  readonly weightGrams: number | null;
}

/** What the courier gives back when it accepts a parcel. */
export interface ParcelResult {
  /** The courier's id for the parcel. Our primary key into its world. */
  readonly consignmentNo: string;
  /** The code a customer types into the courier's website, when there is one. */
  readonly trackingCode: string | null;
  /** The courier's own word for the state it created the parcel in. */
  readonly rawStatus: string | null;
}

/** Enough to ask a courier about one parcel again. */
export interface ParcelRef {
  readonly consignmentNo: string;
  readonly reference: string;
  readonly trackingCode: string | null;
}

const MAX_NAME = 120;
const MAX_ADDRESS = 500;
const MAX_NOTE = 500;
/** ৳1 crore. A COD above this is a typo, and a typo the rider would try to collect. */
const MAX_COD_POISHA = 1_000_000_000n;
const BD_MOBILE = /^\+8801[13456789]\d{8}$/;

/**
 * Refuse a parcel no courier will accept, naming the field.
 *
 * `POSTING_INPUT_INVALID` is reused rather than a new code invented, because this is
 * the same class of failure the posting rules raise — a caller handed the domain
 * something structurally wrong — and the HTTP edge already maps it. The message names
 * the field, because the caller reading it is a job handler with no view of the form
 * somebody filled in.
 */
export function assertParcelInput(input: ParcelInput): void {
  const { address } = input;

  for (const [what, value, limit] of [
    ['recipient name', address.recipientName, MAX_NAME],
    ['address', address.addressLine, MAX_ADDRESS],
    ['district', address.district, MAX_NAME],
    ['thana', address.thana, MAX_NAME],
    ['reference', input.reference, MAX_NAME],
  ] as const) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new LedgerError('POSTING_INPUT_INVALID', `A parcel needs its ${what}.`);
    }
    if (trimmed.length > limit) {
      throw new LedgerError(
        'POSTING_INPUT_INVALID',
        `That ${what} is longer than ${String(limit)} characters, which every courier truncates.`,
      );
    }
  }

  if (!BD_MOBILE.test(address.recipientPhoneE164)) {
    /*
     * The number is checked here even though `sales.orders` has the same CHECK,
     * because a booking can be built from an address a person edited after the order
     * was created. A courier given an unreachable number does not refuse the parcel
     * — it accepts it, fails to deliver, and charges a return fee.
     *
     * The number itself is never in the message (invariant 10).
     */
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'That recipient phone number is not a Bangladeshi mobile number.',
    );
  }

  if (input.codAmountPoisha < 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A COD amount cannot be negative.');
  }
  if (input.codAmountPoisha > MAX_COD_POISHA) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'That COD amount is above the booking ceiling; check it before sending a rider for it.',
    );
  }
  if (input.note !== null && input.note.length > MAX_NOTE) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'That delivery note is too long.');
  }
  if (
    input.weightGrams !== null &&
    (!Number.isSafeInteger(input.weightGrams) || input.weightGrams <= 0)
  ) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A declared weight must be a positive integer.');
  }
}

/**
 * Taka, as a courier's `cod_amount` field wants it.
 *
 * Every Bangladeshi courier API takes taka, not poisha, and rounds to two decimals.
 * This is the one place poisha leaves the system as a decimal number, and it is a
 * *string* so nothing downstream can widen it into a float (invariant 1): a COD of
 * ৳12,345.67 sent as the JSON number 12345.67 is already a value that does not
 * round-trip, and the rider collects whatever the courier's own rounding produced.
 *
 * Fractional poisha cannot occur — `Poisha` is an integer by construction — so this
 * is exact division, not rounding.
 */
export function codAmountAsTaka(amount: Poisha): string {
  const negative = amount < 0n;
  // `-amount` on a branded bigint trips `no-unsafe-unary-minus`, which exists because a
  // branded numeric can be a type whose negation means something else. Widening to `bigint`
  // first says that this one is an ordinary integer.
  const raw: bigint = amount;
  const magnitude = negative ? -raw : raw;
  const taka = magnitude / 100n;
  const poishaPart = magnitude % 100n;
  return `${negative ? '-' : ''}${taka.toString()}.${poishaPart.toString().padStart(2, '0')}`;
}

/**
 * Taka from a courier's statement, back to poisha.
 *
 * Accepts `1234`, `1234.5`, `1,234.50` and a leading `৳`, because settlement files
 * contain all four. It refuses anything with more than two decimals rather than
 * rounding: a third decimal in a courier's file means the column is not taka, and
 * guessing turns a column-mapping mistake into a hundred small posting errors.
 *
 * `parseFloat` is not used, and not only because the lint rule forbids it (D-090):
 * ৳99,999,999.99 is inside a float but the parse of a longer statement total is not,
 * and a settlement is the one place a rounding error is indistinguishable from theft.
 */
export function takaToPoisha(input: string): bigint {
  const cleaned = input.replace(/[৳,\s]/g, '').trim();
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (match === null) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      `"${input}" is not an amount in taka with at most two decimals.`,
    );
  }
  const sign = match[1] === '-' ? -1n : 1n;
  const whole = BigInt(match[2] ?? '0');
  const fraction = BigInt((match[3] ?? '').padEnd(2, '0'));
  return sign * (whole * 100n + fraction);
}
