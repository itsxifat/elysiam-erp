import { isIsoDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  LedgerError,
  type JournalDraft,
  type JournalLineDraft,
} from '../ledger/index.js';
import { sum, ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * A showroom sale (architecture §7 "POS sale"):
 *
 *     Dr W (each tender's wallet, what it kept)
 *       Cr Sales revenue (the net, after discounts)
 *     Dr COGS
 *       Cr Inventory (the units at the weighted average they left the shelf at)
 *
 * Revenue is recognised at the till, not on delivery: D-003's reason for waiting
 * (a COD parcel may come back) does not apply to goods the customer carried out
 * having paid. Recorded net of discounts (§7's accounting policy); the discount
 * stays on the sale row for reporting.
 *
 * ## One journal, both halves
 *
 * The same reason `orderDeliveredDraft` gives: gross profit on a sale has to be
 * one fact. Two journals balance individually and let a retry post one of them — a
 * sale with revenue and no cost reads as a hundred per cent margin until somebody
 * reconciles inventory.
 *
 * ## The key is the till's own id
 *
 * `pos_sale:<saleId>:sold`, where `saleId` is the UUID the till generated when the
 * cashier pressed pay — offline, before the server knew the sale existed. That is
 * what makes a re-sync harmless at the ledger: the same sale delivered twice,
 * or by two requests racing, reaches `ledger.post()` with the same key, and the
 * second gets the first journal back (invariant 2). A key the server minted on
 * arrival would be a new key per delivery, and the ledger could not tell a retry
 * from a second customer.
 *
 * ## Dated by the caller
 *
 * The business date is passed in rather than derived from an instant, because a
 * sale held for review may post on a later day than it happened (`postingDateFor`).
 */

export interface PosTenderLine {
  /** A `wallet_*` account: hand cash, bKash, or the bank a card settles to. */
  readonly account: PostingAccount;
  readonly amountPoisha: Poisha;
}

export interface PosSaleInput {
  readonly saleId: string;
  readonly businessDate: string;
  readonly tenders: readonly PosTenderLine[];
  readonly salesRevenue: PostingAccount;
  readonly cogs: PostingAccount;
  readonly inventory: PostingAccount;
  /** What the customer paid, after discounts. Equal to Σ tenders. */
  readonly netPoisha: Poisha;
  /** Σ qty × the unit cost each `pos_sale` movement recorded. */
  readonly costPoisha: Poisha;
  readonly branchId: string;
  readonly memo: string | null;
}

export function posSaleDraft(input: PosSaleInput): JournalDraft {
  assertSubtype(input.salesRevenue, 'sales_revenue', 'A showroom sale');
  assertSubtype(input.cogs, 'cogs', 'Cost of goods sold');
  assertSubtype(input.inventory, 'inventory', 'Stock leaving the shelf');
  if (!isIsoDate(input.businessDate)) {
    throw new LedgerError('JOURNAL_DATE_INVALID', `"${input.businessDate}" is not a date.`);
  }
  if (input.netPoisha < 0n || input.costPoisha < 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A sale and its cost are never negative.');
  }
  for (const tender of input.tenders) {
    if (!ACCOUNT_SUBTYPES[tender.account.subtype].wallet) {
      throw new LedgerError('POSTING_INPUT_INVALID', 'A tender is paid into a wallet (§7 "W").');
    }
    if (tender.amountPoisha <= 0n) {
      throw new LedgerError('POSTING_INPUT_INVALID', 'A tender line carries a positive amount.');
    }
  }
  const paid = sum(input.tenders.map((tender) => tender.amountPoisha));
  if (paid !== input.netPoisha) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'The wallets must receive exactly what the sale earned.',
    );
  }
  if (input.netPoisha === 0n && input.costPoisha === 0n) {
    /*
     * A sale worth nothing that cost nothing — a free sample of stock carried at
     * no cost. There is no journal of zero (§7's balance trigger needs two positive
     * sides), so the caller records the sale and posts nothing. Refused with a code
     * rather than returned empty so that decision is the caller's, made on purpose.
     */
    throw new LedgerError('POSTING_INPUT_INVALID', 'This sale moved no value, so has no journal.');
  }

  const lines: JournalLineDraft[] = input.tenders.map((tender) => ({
    accountId: tender.account.accountId,
    debitPoisha: tender.amountPoisha,
    creditPoisha: ZERO,
    // A branch's hand cash carries its own branch and the line must repeat it
    // (migration 0014); an org-level bank or bKash account takes the sale's.
    branchId: lineBranch(tender.account, input.branchId),
    partyType: null,
    partyId: null,
    memo: null,
  }));

  if (input.netPoisha > 0n) {
    lines.push({
      accountId: input.salesRevenue.accountId,
      debitPoisha: ZERO,
      creditPoisha: input.netPoisha,
      branchId: lineBranch(input.salesRevenue, input.branchId),
      partyType: null,
      partyId: null,
      memo: null,
    });
  }

  /*
   * The cost pair, conditional on there being a cost: stock migrated in at nothing
   * leaves at nothing, and a zero line is refused by `validateJournalDraft`. The
   * revenue pair still stands on its own. A fully discounted sale is the opposite
   * case — cost and no revenue — and is legitimate too: the value of the units
   * given away is an expense the brand chose to incur.
   */
  if (input.costPoisha > 0n) {
    lines.push(
      {
        accountId: input.cogs.accountId,
        debitPoisha: input.costPoisha,
        creditPoisha: ZERO,
        branchId: lineBranch(input.cogs, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.inventory.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.costPoisha,
        branchId: lineBranch(input.inventory, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
    );
  }

  return {
    businessDate: input.businessDate,
    sourceType: 'pos_sale',
    sourceId: input.saleId.toLowerCase(),
    event: 'sold',
    idempotencyKey: idempotencyKey('pos_sale', input.saleId, 'sold'),
    memo: input.memo,
    reversesJournalId: null,
    lines,
  };
}
