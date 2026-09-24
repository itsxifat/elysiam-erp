import { businessDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  LedgerError,
  type AccountSubtype,
  type JournalDraft,
} from '../ledger/index.js';
import { ZERO, type Poisha } from '../money/index.js';

/**
 * Cash in (category): **Dr W / Cr income account** (architecture §7, posting
 * rules table).
 *
 * Money arriving in a wallet that is not a sale, a settlement, capital or a
 * loan — scrap sold, a refund from a vendor, an insurance payout. The
 * category is the income account it is credited to, and only `other_income`
 * accounts qualify (D-086): crediting `sales_revenue` from here would book a
 * sale that no order, stock movement or COGS line stands behind, and
 * `inventory_adjustment_gain` needs an approval this rule does not have.
 *
 * Both lines carry the wallet's branch, so a showroom's cash in appears in
 * that showroom's day book and P&L.
 */

export const CASH_IN_INCOME_SUBTYPES: readonly AccountSubtype[] = ['other_income'];

export interface CashInAccount {
  readonly accountId: string;
  readonly subtype: AccountSubtype;
  readonly branchId: string | null;
}

export interface CashInInput {
  /** The cash entry's identity. The idempotency key is derived from it. */
  readonly entryId: string;
  /** When the money arrived. The business date is its Asia/Dhaka date. */
  readonly occurredAt: Date;
  readonly wallet: CashInAccount;
  readonly income: CashInAccount;
  readonly amountPoisha: Poisha;
  readonly memo: string | null;
}

export function cashInDraft(input: CashInInput): JournalDraft {
  if (input.amountPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A cash-in amount must be positive.');
  }
  if (!ACCOUNT_SUBTYPES[input.wallet.subtype].wallet) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'Cash in must be received into a wallet.');
  }
  if (!CASH_IN_INCOME_SUBTYPES.includes(input.income.subtype)) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'Cash in can only be credited to an other-income category.',
    );
  }
  // An income account tied to one branch cannot take another branch's cash.
  if (input.income.branchId !== null && input.income.branchId !== input.wallet.branchId) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'That income category belongs to a different branch than the wallet.',
    );
  }

  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'cash_in',
    sourceId: input.entryId.toLowerCase(),
    event: 'received',
    idempotencyKey: idempotencyKey('cash_in', input.entryId, 'received'),
    memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.wallet.accountId,
        debitPoisha: input.amountPoisha,
        creditPoisha: ZERO,
        branchId: input.wallet.branchId,
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.income.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.amountPoisha,
        branchId: input.wallet.branchId,
        partyType: null,
        partyId: null,
        memo: null,
      },
    ],
  };
}
