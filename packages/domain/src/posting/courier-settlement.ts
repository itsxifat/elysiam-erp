import { isIsoDate, type IsoDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  isUuid,
  LedgerError,
  type JournalDraft,
  type JournalLineDraft,
} from '../ledger/index.js';
import { add, sum, ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * A courier settlement, as two journals (architecture §7; D-037).
 *
 *     Courier charges (from settlement)
 *       Dr Courier charges + Dr Return charges / Cr Courier receivable
 *
 *     COD settlement received
 *       Dr W (bank or bKash) / Cr Courier receivable (net)
 *
 * §7 lists them as two business events and they stay two journals, posted in one
 * transaction. Two rather than one because they answer different questions and a
 * month-end reader needs them separable: "what did this courier cost us" is a P&L
 * question about the first, and "when did the money arrive" is a cash question about
 * the second. Their idempotency keys differ, so a retry that got halfway posts the
 * missing half and nothing twice.
 *
 * Together they credit courier receivable with charges + net, which is exactly the
 * gross the courier collected — so a consignment's receivable returns to **zero**
 * (M12 acceptance check 5). That identity is the only reason the split is safe: the
 * matcher refuses any row where the charges and the net do not add back to the
 * collection, so there is no settlement shape where the two journals relieve more or
 * less than delivery debited.
 *
 * ## The date is passed in, not derived
 *
 * Every other posting rule computes `businessDate` from an `occurredAt`. These two
 * take a `postingDate` the caller has already resolved against the closed periods,
 * because D-037 makes the posting date a *decision*: a settlement dated inside a
 * closed month posts to the earliest open period instead, and the resolution needs to
 * know which months are closed — which a pure function cannot ask.
 *
 * `settlementDate` comes along anyway, and lands in the memo. That is deliberate
 * belt-and-braces: the row keeps the original date as a column (D-037's "reference
 * field"), and the journal's memo keeps it too, so an account ledger read in two
 * years still says which month's cash a January-dated journal actually settled.
 */

export interface CourierSettlementBase {
  /** The settlement batch's id. Both keys derive from it. */
  readonly settlementId: string;
  /** Where the journal posts, after D-037's resolution. */
  readonly postingDate: IsoDate;
  /** The courier's own date for the statement. Never overwritten. */
  readonly settlementDate: IsoDate;
  readonly courierReceivable: PostingAccount;
  /** `courier_receivable` is a party subtype (§7): the balance is per courier. */
  readonly courierId: string;
  readonly branchId: string | null;
  readonly memo: string | null;
}

export interface CourierChargesInput extends CourierSettlementBase {
  readonly courierCharges: PostingAccount;
  readonly returnCharges: PostingAccount;
  /** Delivery fees on the matched rows. */
  readonly deliveryChargesPoisha: Poisha;
  /** Return fees on the matched rows. §7 gives these their own account. */
  readonly returnChargesPoisha: Poisha;
  /**
   * COD fees, fuel surcharges, anything else the statement itemises.
   *
   * Booked to Courier charges with the delivery fees rather than to its own account:
   * §7's chart has no line for it, and inventing one per courier surcharge would make
   * "what did delivery cost us this month" a sum across accounts nobody remembers to
   * include. The settlement line keeps the breakdown for anyone who asks.
   */
  readonly otherChargesPoisha: Poisha;
}

export interface CodSettlementInput extends CourierSettlementBase {
  /** The wallet the courier paid into: a bank account or bKash (§7). */
  readonly wallet: PostingAccount;
  /** Gross minus every charge, over the matched rows. Positive. */
  readonly netPoisha: Poisha;
}

function assertDates(input: CourierSettlementBase): void {
  if (!isIsoDate(input.postingDate) || !isIsoDate(input.settlementDate)) {
    throw new LedgerError('JOURNAL_DATE_INVALID', 'A settlement needs YYYY-MM-DD dates.');
  }
  if (input.postingDate < input.settlementDate) {
    /*
     * D-037 moves a settlement *forward* into the earliest open period, never back.
     * "Never silently back-dated" is the decision's own last sentence, and a posting
     * date before the statement's date would be exactly that — with the original date
     * still sitting on the row looking correct.
     */
    throw new LedgerError(
      'JOURNAL_DATE_INVALID',
      'A settlement never posts before its own date (D-037).',
    );
  }
  if (!isUuid(input.settlementId)) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A settlement journal names its batch.');
  }
  if (!isUuid(input.courierId)) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A settlement journal names its courier.');
  }
}

/**
 * The memo, carrying D-037's original date when the two differ.
 *
 * Only when they differ. A memo that said "settled 2026-03-31" on a journal dated
 * 2026-03-31 is noise, and noise on every line is how the one line that matters stops
 * being noticed.
 */
function settlementMemo(input: CourierSettlementBase): string | null {
  if (input.postingDate === input.settlementDate) return input.memo;
  const note = `Courier statement dated ${input.settlementDate}; posted in the earliest open period (D-037).`;
  return input.memo === null ? note : `${input.memo} — ${note}`;
}

/**
 * §7 "Courier charges (from settlement)".
 *
 * Refuses a charges journal of zero rather than returning an empty draft: a courier
 * that charged nothing has no charges journal, and the caller has to decide that
 * deliberately (`settlementPostsAnything` in the courier domain) instead of posting a
 * journal the balance trigger would reject at commit with a message about line counts.
 */
export function courierChargesDraft(input: CourierChargesInput): JournalDraft {
  assertDates(input);
  assertSubtype(input.courierReceivable, 'courier_receivable', 'The courier balance');
  assertSubtype(input.courierCharges, 'courier_charges', 'Delivery charges');
  assertSubtype(input.returnCharges, 'return_charges', 'Return charges');

  for (const [what, amount] of [
    ['The delivery charges', input.deliveryChargesPoisha],
    ['The return charges', input.returnChargesPoisha],
    ['The other charges', input.otherChargesPoisha],
  ] as const) {
    if (amount < 0n) {
      throw new LedgerError('POSTING_INPUT_INVALID', `${what} cannot be negative.`);
    }
  }

  const toCourierCharges = add(input.deliveryChargesPoisha, input.otherChargesPoisha);
  const total = add(toCourierCharges, input.returnChargesPoisha);
  if (total <= 0n) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'This settlement carries no charges, so there is no charges journal to post.',
    );
  }

  const lines: JournalLineDraft[] = [];
  if (toCourierCharges > 0n) {
    lines.push({
      accountId: input.courierCharges.accountId,
      debitPoisha: toCourierCharges,
      creditPoisha: ZERO,
      branchId: lineBranch(input.courierCharges, input.branchId),
      partyType: null,
      partyId: null,
      memo: null,
    });
  }
  if (input.returnChargesPoisha > 0n) {
    lines.push({
      accountId: input.returnCharges.accountId,
      debitPoisha: input.returnChargesPoisha,
      creditPoisha: ZERO,
      branchId: lineBranch(input.returnCharges, input.branchId),
      partyType: null,
      partyId: null,
      memo: null,
    });
  }

  lines.push({
    accountId: input.courierReceivable.accountId,
    debitPoisha: ZERO,
    creditPoisha: total,
    branchId: lineBranch(input.courierReceivable, input.branchId),
    // Without the party, every courier shares one receivable balance and the COD
    // reconciliation report — the thing this milestone exists to produce — cannot
    // answer "how much is Steadfast still holding".
    partyType: 'courier',
    partyId: input.courierId,
    memo: null,
  });

  return {
    businessDate: input.postingDate,
    sourceType: 'courier_settlement',
    sourceId: input.settlementId.toLowerCase(),
    event: 'charges',
    idempotencyKey: idempotencyKey('courier_settlement', input.settlementId, 'charges'),
    memo: settlementMemo(input),
    reversesJournalId: null,
    lines,
  };
}

/**
 * §7 "COD settlement received".
 *
 * The wallet is checked for being *a* wallet rather than for being bank or bKash.
 * §7's row says "(bank or bKash)" because that is how couriers pay in practice, but a
 * courier that hands over cash at a showroom is a real thing and refusing it would
 * leave the money unrecordable. What must not happen is a settlement posting into an
 * expense or a receivable, which is what the subtype check catches.
 */
export function codSettlementDraft(input: CodSettlementInput): JournalDraft {
  assertDates(input);
  assertSubtype(input.courierReceivable, 'courier_receivable', 'The courier balance');
  if (!ACCOUNT_SUBTYPES[input.wallet.subtype].wallet) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      `A settlement is received into a wallet, not a ${input.wallet.subtype} account.`,
    );
  }
  if (input.netPoisha <= 0n) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'This settlement pays nothing across, so there is no cash journal to post.',
    );
  }

  return {
    businessDate: input.postingDate,
    sourceType: 'courier_settlement',
    sourceId: input.settlementId.toLowerCase(),
    event: 'received',
    idempotencyKey: idempotencyKey('courier_settlement', input.settlementId, 'received'),
    memo: settlementMemo(input),
    reversesJournalId: null,
    lines: [
      {
        accountId: input.wallet.accountId,
        debitPoisha: input.netPoisha,
        creditPoisha: ZERO,
        branchId: lineBranch(input.wallet, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.courierReceivable.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.netPoisha,
        branchId: lineBranch(input.courierReceivable, input.branchId),
        partyType: 'courier',
        partyId: input.courierId,
        memo: null,
      },
    ],
  };
}

/**
 * What the two journals together take off the courier's balance.
 *
 * Exported so the settlement service can assert, before it posts, that the figure
 * equals Σ what delivery debited for the matched consignments. Asserting it is
 * cheaper than discovering a residue: both journals balance whatever the numbers are,
 * so a mismatch is invisible in the ledger and shows up only as a courier receivable
 * that never reaches zero.
 */
export function settlementRelievesPoisha(input: {
  readonly deliveryChargesPoisha: Poisha;
  readonly returnChargesPoisha: Poisha;
  readonly otherChargesPoisha: Poisha;
  readonly netPoisha: Poisha;
}): Poisha {
  return sum([
    input.deliveryChargesPoisha,
    input.returnChargesPoisha,
    input.otherChargesPoisha,
    input.netPoisha,
  ]);
}
