import { businessDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  LedgerError,
  type JournalDraft,
} from '../ledger/index.js';
import { ZERO, type Poisha } from '../money/index.js';

import type { PayrollAccount } from './payroll-posted.js';

/**
 * Employee loan disbursed: **Dr Employee loan receivable / Cr W** (architecture §7).
 *
 * The company hands an employee cash and books an asset against that employee. It
 * is not an expense and it is not an advance against salary: §7 gives it its own
 * party account so that "what does Rashed still owe us" is a balance somebody can
 * read, and so that the monthly deduction has something to credit.
 *
 * The party is required by the account's subtype, and the employee id is it. A
 * disbursement with no party would balance and would make the loan invisible in
 * every party statement — the loan would exist only in `hr.employee_loans`, which
 * is the module's own bookkeeping rather than the company's.
 *
 * There is no interest line. §7 has `interest_expense` for *company* loans, where
 * the company is the borrower; a staff loan in this business is interest-free, and
 * inventing a rate here would be inventing a product. A loan that charges interest
 * needs its own posting rule and a decision row, not an optional field on this one.
 */
export interface EmployeeLoanDisbursedInput {
  readonly loanId: string;
  readonly employeeId: string;
  /** When the money left. Its Asia/Dhaka date is the business date. */
  readonly occurredAt: Date;
  readonly loanReceivable: PayrollAccount;
  readonly wallet: PayrollAccount;
  readonly amountPoisha: Poisha;
  readonly memo: string | null;
}

export function employeeLoanDisbursedDraft(input: EmployeeLoanDisbursedInput): JournalDraft {
  if (input.loanReceivable.subtype !== 'employee_loan_receivable') {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A staff loan is booked to the employee loan account.',
    );
  }
  if (!ACCOUNT_SUBTYPES[input.wallet.subtype].wallet) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A loan is disbursed from a wallet.');
  }
  if (input.amountPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A loan disbursement must be positive.');
  }

  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'employee_loan',
    sourceId: input.loanId.toLowerCase(),
    event: 'disbursed',
    idempotencyKey: idempotencyKey('employee_loan', input.loanId, 'disbursed'),
    memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.loanReceivable.accountId,
        debitPoisha: input.amountPoisha,
        creditPoisha: ZERO,
        branchId: input.loanReceivable.branchId ?? input.wallet.branchId,
        partyType: 'employee',
        partyId: input.employeeId.toLowerCase(),
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
