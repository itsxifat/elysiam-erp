import { businessDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  LedgerError,
  type JournalDraft,
  type JournalLineDraft,
} from '../ledger/index.js';
import { add, ZERO, type Poisha } from '../money/index.js';

import type { PostingAccount } from './supply-received.js';

/**
 * Company loans (architecture §7's posting rules table, §15; M26).
 *
 *     received          Dr W / Cr Loan payable (lender)
 *     instalment paid   Dr Loan payable (lender, principal) + Dr Interest expense / Cr W
 *
 * A loan is debt, not income and not equity: crediting the principal anywhere but
 * `loan_payable` would balance and would show borrowed money as a profitable month or
 * as the owners' capital. The repayment splits what the lender is paid into the part
 * that reduces the debt and the part that is the cost of borrowing — only the second is
 * an expense. Both rules check the subtypes they are handed for exactly that reason.
 *
 * `loan_payable` is a party subtype (§7): every line on it names the lender, so "what
 * do we still owe Sonali Bank" is a party balance anyone can read. Neither the debt nor
 * its interest belongs to a branch; the wallet line carries its own branch, so a
 * repayment from a showroom till shows in that till's cash book.
 */

export interface CompanyLoanReceivedInput {
  /** The loan row's identity. The idempotency key is derived from it. */
  readonly loanId: string;
  readonly lenderId: string;
  /** When the money arrived. Its Asia/Dhaka date is the business date. */
  readonly occurredAt: Date;
  readonly wallet: PostingAccount;
  readonly loanPayable: PostingAccount;
  readonly principalPoisha: Poisha;
  readonly memo: string | null;
}

function cleanMemo(memo: string | null): string | null {
  const trimmed = memo?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function assertLoanPayable(account: PostingAccount): void {
  if (account.subtype !== 'loan_payable') {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A company loan is booked to the loan payable account (§7), never to income or equity.',
    );
  }
}

function assertWallet(account: PostingAccount, what: string): void {
  if (!ACCOUNT_SUBTYPES[account.subtype].wallet) {
    throw new LedgerError('POSTING_INPUT_INVALID', what);
  }
}

export function companyLoanReceivedDraft(input: CompanyLoanReceivedInput): JournalDraft {
  if (input.principalPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A loan’s principal must be positive.');
  }
  assertWallet(input.wallet, 'A loan is received into a wallet.');
  assertLoanPayable(input.loanPayable);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'company_loan',
    sourceId: input.loanId.toLowerCase(),
    event: 'received',
    idempotencyKey: idempotencyKey('company_loan', input.loanId, 'received'),
    memo: cleanMemo(input.memo),
    reversesJournalId: null,
    lines: [
      {
        accountId: input.wallet.accountId,
        debitPoisha: input.principalPoisha,
        creditPoisha: ZERO,
        branchId: input.wallet.branchId,
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.loanPayable.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.principalPoisha,
        branchId: input.loanPayable.branchId,
        partyType: 'lender',
        partyId: input.lenderId.toLowerCase(),
        memo: null,
      },
    ],
  };
}

export interface LoanInstalmentPaidInput {
  /**
   * The instalment being paid. The key is the instalment's, not the payment row's: a
   * second payment row for one instalment can never post a second journal.
   */
  readonly instalmentId: string;
  readonly lenderId: string;
  /** When the money left. Its Asia/Dhaka date is the business date. */
  readonly occurredAt: Date;
  readonly wallet: PostingAccount;
  readonly loanPayable: PostingAccount;
  readonly interestExpense: PostingAccount;
  readonly principalPoisha: Poisha;
  readonly interestPoisha: Poisha;
  readonly memo: string | null;
}

export function loanInstalmentPaidDraft(input: LoanInstalmentPaidInput): JournalDraft {
  if (input.principalPoisha < 0n || input.interestPoisha < 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'An instalment’s parts cannot be negative.');
  }
  const total = add(input.principalPoisha, input.interestPoisha);
  if (total <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'An instalment must pay something.');
  }
  assertWallet(input.wallet, 'A lender is paid from a wallet.');
  assertLoanPayable(input.loanPayable);
  if (input.interestExpense.subtype !== 'interest_expense') {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'Loan interest is booked to the interest expense account (§7).',
    );
  }

  // A line is either a debit or a credit of more than zero, so a part that is nothing
  // (an interest-free loan, or a final instalment of pure interest) has no line.
  const lines: JournalLineDraft[] = [];
  if (input.principalPoisha > 0n) {
    lines.push({
      accountId: input.loanPayable.accountId,
      debitPoisha: input.principalPoisha,
      creditPoisha: ZERO,
      branchId: input.loanPayable.branchId,
      partyType: 'lender',
      partyId: input.lenderId.toLowerCase(),
      memo: null,
    });
  }
  if (input.interestPoisha > 0n) {
    lines.push({
      accountId: input.interestExpense.accountId,
      debitPoisha: input.interestPoisha,
      creditPoisha: ZERO,
      branchId: input.interestExpense.branchId,
      partyType: null,
      partyId: null,
      memo: null,
    });
  }
  lines.push({
    accountId: input.wallet.accountId,
    debitPoisha: ZERO,
    creditPoisha: total,
    branchId: input.wallet.branchId,
    partyType: null,
    partyId: null,
    memo: null,
  });

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'loan_instalment',
    sourceId: input.instalmentId.toLowerCase(),
    event: 'paid',
    idempotencyKey: idempotencyKey('loan_instalment', input.instalmentId, 'paid'),
    memo: cleanMemo(input.memo),
    reversesJournalId: null,
    lines,
  };
}
