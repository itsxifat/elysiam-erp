import { isIsoDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  LedgerError,
  type JournalDraft,
  type JournalLineDraft,
} from '../ledger/index.js';
import { sum, ZERO, type Poisha } from '../money/index.js';
import type { PosTenderLine } from './pos-sale.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * Goods brought back to a showroom till (M23; proposed as §7's "POS return" row):
 *
 *     Dr Sales revenue (what the customer paid for the returned units)
 *       Cr W (each refund tender's wallet)
 *     Dr Inventory
 *       Cr COGS (the units at the cost they left the shelf at)
 *
 * §7 names the sale and not its return, and the return is the sale undone
 * against the accounts that received it — the same reasoning `orderExchangeDraft`
 * gives for debiting Sales revenue rather than Sales discounts. A discount is a
 * price we chose to give; a return is a sale that did not happen, and booking it
 * as a discount would inflate both revenue and discounts by the same amount.
 *
 * **The cost comes back at the cost it went out at**, which the sale's `pos_sale`
 * movement recorded (§8: returns re-enter at the cost they were dispatched at).
 * Today's weighted average instead would let a price rise between sale and return
 * create inventory value out of a refund.
 *
 * An **exchange** is a return and a new sale, linked, each with its own journal:
 * the refund pays out of the drawer and the replacement pays back in, so the till
 * nets the difference while revenue, cost and stock each move by exactly the units
 * that moved. Netting the two into one journal would hide a real return inside a
 * smaller sale.
 */

export interface PosReturnInput {
  readonly returnId: string;
  readonly businessDate: string;
  /** Where the refund came from. Empty when nothing was refunded. */
  readonly refunds: readonly PosTenderLine[];
  readonly salesRevenue: PostingAccount;
  readonly cogs: PostingAccount;
  readonly inventory: PostingAccount;
  /** What the customer gets back: Σ of the returned lines' cumulative shares. */
  readonly refundPoisha: Poisha;
  /** Σ qty × the unit cost recorded when those units were sold. */
  readonly costPoisha: Poisha;
  readonly branchId: string;
  readonly memo: string | null;
}

export function posReturnDraft(input: PosReturnInput): JournalDraft {
  assertSubtype(input.salesRevenue, 'sales_revenue', 'A showroom return');
  assertSubtype(input.cogs, 'cogs', 'Cost of goods sold');
  assertSubtype(input.inventory, 'inventory', 'Stock returning to the shelf');
  if (!isIsoDate(input.businessDate)) {
    throw new LedgerError('JOURNAL_DATE_INVALID', `"${input.businessDate}" is not a date.`);
  }
  if (input.refundPoisha < 0n || input.costPoisha < 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A refund and its cost are never negative.');
  }
  for (const refund of input.refunds) {
    if (!ACCOUNT_SUBTYPES[refund.account.subtype].wallet) {
      throw new LedgerError('POSTING_INPUT_INVALID', 'A refund is paid out of a wallet.');
    }
    if (refund.amountPoisha <= 0n) {
      throw new LedgerError('POSTING_INPUT_INVALID', 'A refund line carries a positive amount.');
    }
  }
  if (sum(input.refunds.map((refund) => refund.amountPoisha)) !== input.refundPoisha) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'The wallets must pay out exactly what the return refunds.',
    );
  }
  if (input.refundPoisha === 0n && input.costPoisha === 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'This return moved no value, so has no journal.');
  }

  const lines: JournalLineDraft[] = [];
  if (input.refundPoisha > 0n) {
    lines.push({
      accountId: input.salesRevenue.accountId,
      debitPoisha: input.refundPoisha,
      creditPoisha: ZERO,
      branchId: lineBranch(input.salesRevenue, input.branchId),
      partyType: null,
      partyId: null,
      memo: null,
    });
    for (const refund of input.refunds) {
      lines.push({
        accountId: refund.account.accountId,
        debitPoisha: ZERO,
        creditPoisha: refund.amountPoisha,
        branchId: lineBranch(refund.account, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      });
    }
  }
  if (input.costPoisha > 0n) {
    lines.push(
      {
        accountId: input.inventory.accountId,
        debitPoisha: input.costPoisha,
        creditPoisha: ZERO,
        branchId: lineBranch(input.inventory, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.cogs.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.costPoisha,
        branchId: lineBranch(input.cogs, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
    );
  }

  return {
    businessDate: input.businessDate,
    sourceType: 'pos_return',
    sourceId: input.returnId.toLowerCase(),
    event: 'returned',
    idempotencyKey: idempotencyKey('pos_return', input.returnId, 'returned'),
    memo: input.memo,
    reversesJournalId: null,
    lines,
  };
}
