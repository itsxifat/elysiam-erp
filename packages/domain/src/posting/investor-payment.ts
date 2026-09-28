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
 * A distribution or a withdrawal paid: **Dr Investor payable (or Investor
 * capital) / Cr W** (architecture §7, posting rules table; §15).
 *
 * One rule for both, because §7 writes them as one row and they are one journal.
 * What differs is which account is debited, and that is the whole decision this
 * rule protects:
 *
 * - **profit** — paying out something already declared. Dr `investor_payable`:
 *   settling a debt the company recognised when the distribution was declared.
 * - **capital** — returning money the investor put in. Dr `investor_capital`:
 *   reducing equity.
 *
 * Debiting the wrong one is invisible and lasting. Paying a profit distribution
 * against capital leaves the payable standing — so the company still shows the
 * debt, and the investor's capital account says they took their money out. Paying
 * capital against the payable drives a liability negative, which reads as the
 * company being owed money by its own investor. Neither shows up as an error; both
 * show up a year later in an argument. So the kind is explicit, and the subtype it
 * names is checked against it.
 *
 * The debit carries the **investor** as its party (§7 marks both subtypes as party
 * subtypes) and no branch: equity and the profit owed on it belong to the org.
 * The wallet line carries its own branch, so paying out of a showroom till shows
 * in that showroom's cash book.
 */

export const WITHDRAWAL_PAYMENT_KINDS = ['capital', 'profit'] as const;
export type WithdrawalPaymentKind = (typeof WITHDRAWAL_PAYMENT_KINDS)[number];

/** The account each kind is debited to (§7). */
export const WITHDRAWAL_DEBIT_SUBTYPE: Readonly<Record<WithdrawalPaymentKind, AccountSubtype>> = {
  capital: 'investor_capital',
  profit: 'investor_payable',
};

export interface InvestorPaymentAccount {
  readonly accountId: string;
  readonly subtype: AccountSubtype;
  readonly branchId: string | null;
}

export interface InvestorPaymentInput {
  /** The withdrawal row's identity. The idempotency key is derived from it. */
  readonly withdrawalId: string;
  readonly investorId: string;
  readonly kind: WithdrawalPaymentKind;
  /** When the money left. The business date is its Asia/Dhaka date. */
  readonly occurredAt: Date;
  /** `investor_capital` for a capital return, `investor_payable` for profit. */
  readonly debit: InvestorPaymentAccount;
  readonly wallet: InvestorPaymentAccount;
  readonly amountPoisha: Poisha;
  readonly memo: string | null;
}

export function investorPaymentDraft(input: InvestorPaymentInput): JournalDraft {
  if (input.amountPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A payment to an investor must be positive.');
  }
  if (!ACCOUNT_SUBTYPES[input.wallet.subtype].wallet) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'An investor is paid from a wallet.');
  }
  const expected = WITHDRAWAL_DEBIT_SUBTYPE[input.kind];
  if (input.debit.subtype !== expected) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      `A ${input.kind} withdrawal is debited to ${expected}, not ${input.debit.subtype} (§7).`,
    );
  }
  if (input.debit.branchId !== null && input.debit.branchId !== input.wallet.branchId) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'That investor account belongs to a different branch than the wallet.',
    );
  }

  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'investor_withdrawal',
    sourceId: input.withdrawalId.toLowerCase(),
    event: 'paid',
    idempotencyKey: idempotencyKey('investor_withdrawal', input.withdrawalId, 'paid'),
    memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.debit.accountId,
        debitPoisha: input.amountPoisha,
        creditPoisha: ZERO,
        branchId: input.debit.branchId,
        partyType: 'investor',
        partyId: input.investorId.toLowerCase(),
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
