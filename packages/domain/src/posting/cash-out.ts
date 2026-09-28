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
 * Cash out and petty cash: **Dr expense account / Cr W** (architecture §7,
 * posting rules table).
 *
 * One rule for both, because they are the same journal. What differs is the
 * paperwork around it — petty cash requires a receipt photo and, above the
 * org's threshold, a checker — and paperwork is not accounting. Two rules with
 * identical bodies would be two places to fix the day the posting changes.
 *
 * The category is the expense account the money is debited to, and only
 * operating-expense accounts qualify. The exclusion is the point: debiting COGS
 * from a cash-out screen would book a cost of sale with no order, no stock
 * movement and no delivery behind it, and `inventory_writeoff`,
 * `cash_over_short` and `bank_charges` each have their own rule with their own
 * approval. A cash payment that is genuinely one of those goes through that
 * rule (D-119).
 *
 * `ad_spend` is allowed as well as the operating categories: §11's campaign
 * spend posts `Dr Ad spend / Cr W`, which is this journal, and the finance team
 * pays for boosted posts out of bKash long before M14 exists.
 *
 * Both lines carry the wallet's branch, so a showroom's spending appears in
 * that showroom's day book and branch P&L rather than only in the org's.
 */

export const CASH_OUT_EXPENSE_SUBTYPES: readonly AccountSubtype[] = [
  'operating_expense',
  'ad_spend',
];

export interface CashOutAccount {
  readonly accountId: string;
  readonly subtype: AccountSubtype;
  readonly branchId: string | null;
}

/** `cash_out` and `petty_cash` differ only in `source_type` and their paperwork. */
export type CashOutKind = 'cash_out' | 'petty_cash';

export interface CashOutInput {
  /** The cash entry's identity. The idempotency key is derived from it. */
  readonly entryId: string;
  readonly kind: CashOutKind;
  /** When the money left. The business date is its Asia/Dhaka date. */
  readonly occurredAt: Date;
  readonly wallet: CashOutAccount;
  readonly expense: CashOutAccount;
  readonly amountPoisha: Poisha;
  readonly memo: string | null;
}

export function cashOutDraft(input: CashOutInput): JournalDraft {
  if (input.amountPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A cash-out amount must be positive.');
  }
  if (!ACCOUNT_SUBTYPES[input.wallet.subtype].wallet) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'Cash out must be paid from a wallet.');
  }
  if (!CASH_OUT_EXPENSE_SUBTYPES.includes(input.expense.subtype)) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'Cash out can only be charged to an operating-expense or ad-spend category.',
    );
  }
  // An expense account tied to one branch cannot take another branch's spending:
  // the branch P&L would show a cost the branch never incurred.
  if (input.expense.branchId !== null && input.expense.branchId !== input.wallet.branchId) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'That expense category belongs to a different branch than the wallet.',
    );
  }

  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: input.kind,
    sourceId: input.entryId.toLowerCase(),
    event: 'paid',
    idempotencyKey: idempotencyKey(input.kind, input.entryId, 'paid'),
    memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.expense.accountId,
        debitPoisha: input.amountPoisha,
        creditPoisha: ZERO,
        branchId: input.wallet.branchId,
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.wallet.accountId,
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
