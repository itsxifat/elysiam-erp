import { businessDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  LedgerError,
  type AccountSubtype,
  type JournalDraft,
  type JournalLineDraft,
} from '../ledger/index.js';
import { poisha, ZERO, type Poisha } from '../money/index.js';

/**
 * Payroll posted (architecture §7, posting rules table):
 *
 *     Dr Salary expense + Dr Bonus expense
 *     Cr Salary payable + Cr Employee loan receivable (deductions)
 *
 * This journal is the moment a month's salary becomes a debt the company owes,
 * and it is posted by the transaction that *approves* the run — not by the one
 * that drafted it. Nothing in this file decides an amount: every figure comes
 * from `computePayrollLine`, which the checker's screen and the approval's
 * `amount_poisha` were both built from (D-072, D-078).
 *
 * ## Why the expense is split by branch and the payable is not
 *
 * §7's branch P&L needs the wage cost of a showroom to land on that showroom.
 * So `salary_expense` and `bonus_expense` get one line per branch, summed over
 * the employees who work there. The payable does not: the company owes one
 * amount to its staff, payable from whichever wallet accounts chooses, and
 * splitting it by branch would invite a payment that settles four branch
 * balances out of one bKash account and leaves three of them non-zero forever.
 *
 * ## Why the loan credit is one line per employee
 *
 * `employee_loan_receivable` is a party account (§7), so every line on it must
 * name a party — and the party is the employee, not "payroll". One aggregated
 * line would balance perfectly and make the employee loan statement unreadable:
 * §7's party statement for an employee is drawn from `party_id`, and a lump
 * credit would clear nobody's balance. The database's line/account trigger
 * refuses a missing party anyway; this is why it is right that it does.
 */

export interface PayrollAccount {
  readonly accountId: string;
  readonly subtype: AccountSubtype;
  /** Null for an org-level account. A branch-level one constrains every line. */
  readonly branchId: string | null;
}

/** One employee's contribution to the journal, straight off their payslip. */
export interface PayrollPostingLine {
  readonly employeeId: string;
  readonly branchId: string | null;
  readonly salaryExpensePoisha: Poisha;
  readonly bonusPoisha: Poisha;
  readonly netPoisha: Poisha;
  readonly loanDeductionPoisha: Poisha;
}

export interface PayrollPostedInput {
  readonly runId: string;
  /** The Asia/Dhaka instant the approval happened. Its date is the business date. */
  readonly occurredAt: Date;
  readonly salaryExpense: PayrollAccount;
  readonly bonusExpense: PayrollAccount;
  readonly salaryPayable: PayrollAccount;
  readonly employeeLoanReceivable: PayrollAccount;
  readonly lines: readonly PayrollPostingLine[];
  readonly memo: string | null;
}

function expect(account: PayrollAccount, subtype: AccountSubtype): void {
  if (account.subtype !== subtype) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      `A payroll journal needs the ${subtype} account, not a ${account.subtype} one.`,
    );
  }
}

/**
 * A branch-scoped account can only ever take its own branch's lines.
 *
 * Checked here rather than left to the database, because the database's message
 * names an account id and a trigger, and the person who hits this has mapped a
 * branch's salary account to the whole org's payroll — which is a sentence worth
 * saying.
 */
function branchFor(account: PayrollAccount, lineBranchId: string | null): string | null {
  if (account.branchId === null) return lineBranchId;
  if (lineBranchId !== null && lineBranchId !== account.branchId) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'That payroll account belongs to one branch, and the run covers more than one.',
    );
  }
  return account.branchId;
}

/** Sum by branch, with `null` (no branch) kept as its own bucket. */
function byBranch(
  lines: readonly PayrollPostingLine[],
  pick: (line: PayrollPostingLine) => Poisha,
): Map<string | null, bigint> {
  const totals = new Map<string | null, bigint>();
  for (const line of lines) {
    const amount = BigInt(pick(line));
    if (amount === 0n) continue;
    totals.set(line.branchId, (totals.get(line.branchId) ?? 0n) + amount);
  }
  return totals;
}

/** Deterministic line order: no branch first, then branch id, then employee id. */
function sortedKeys(totals: Map<string | null, bigint>): (string | null)[] {
  return [...totals.keys()].sort((a, b) => {
    if (a === b) return 0;
    if (a === null) return -1;
    if (b === null) return 1;
    return a < b ? -1 : 1;
  });
}

export function payrollPostedDraft(input: PayrollPostedInput): JournalDraft {
  expect(input.salaryExpense, 'salary_expense');
  expect(input.bonusExpense, 'bonus_expense');
  expect(input.salaryPayable, 'salary_payable');
  expect(input.employeeLoanReceivable, 'employee_loan_receivable');

  if (input.lines.length === 0) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A payroll run with no employees posts nothing.',
    );
  }

  let netTotal = 0n;
  for (const line of input.lines) {
    if (line.netPoisha < 0n || line.bonusPoisha < 0n || line.loanDeductionPoisha < 0n) {
      throw new LedgerError(
        'POSTING_INPUT_INVALID',
        'A payslip cannot carry a negative net, bonus or loan deduction.',
      );
    }
    netTotal += BigInt(line.netPoisha);
  }
  if (netTotal <= 0n) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A payroll run whose net pay is zero has nothing to post.',
    );
  }

  const lines: JournalLineDraft[] = [];

  /*
   * A salary expense can legitimately be negative for one employee: somebody who
   * joined on the last day of the month with a large fixed deduction. It cannot be
   * negative for a *branch*, because a credit balance on an expense account is a
   * branch P&L showing wage income. Summed first, then checked, so the common case
   * (many employees, one of them odd) passes and the impossible case is refused.
   */
  const salaryByBranch = byBranch(input.lines, (line) => line.salaryExpensePoisha);
  for (const branch of sortedKeys(salaryByBranch)) {
    const amount = salaryByBranch.get(branch) ?? 0n;
    if (amount < 0n) {
      throw new LedgerError(
        'POSTING_INPUT_INVALID',
        'The deductions in that branch exceed its salary for the month.',
      );
    }
    /*
     * A branch total of exactly zero emits no line.
     *
     * `byBranch` skips a per-line zero but keeps a branch whose *sum* is zero, which is
     * reachable for the same reason the negative check above exists: one employee at −200 and
     * a colleague at +200 in the same branch. A `0 / 0` line is refused by
     * `validateJournalDraft` — "exactly one of debit and credit is positive" — so without this
     * the whole run fails inside the checker's approval transaction, for a branch that simply
     * has no wage cost to book.
     */
    if (amount === 0n) continue;
    lines.push({
      accountId: input.salaryExpense.accountId,
      debitPoisha: poisha(amount),
      creditPoisha: ZERO,
      branchId: branchFor(input.salaryExpense, branch),
      partyType: null,
      partyId: null,
      memo: null,
    });
  }

  const bonusByBranch = byBranch(input.lines, (line) => line.bonusPoisha);
  for (const branch of sortedKeys(bonusByBranch)) {
    lines.push({
      accountId: input.bonusExpense.accountId,
      debitPoisha: poisha(bonusByBranch.get(branch) ?? 0n),
      creditPoisha: ZERO,
      branchId: branchFor(input.bonusExpense, branch),
      partyType: null,
      partyId: null,
      memo: null,
    });
  }

  lines.push({
    accountId: input.salaryPayable.accountId,
    debitPoisha: ZERO,
    creditPoisha: poisha(netTotal),
    branchId: input.salaryPayable.branchId,
    partyType: null,
    partyId: null,
    memo: null,
  });

  for (const line of [...input.lines].sort((a, b) =>
    a.employeeId < b.employeeId ? -1 : a.employeeId > b.employeeId ? 1 : 0,
  )) {
    if (line.loanDeductionPoisha === 0n) continue;
    lines.push({
      accountId: input.employeeLoanReceivable.accountId,
      debitPoisha: ZERO,
      creditPoisha: line.loanDeductionPoisha,
      branchId: branchFor(input.employeeLoanReceivable, line.branchId),
      // The account's party type (§7). Omitting it is refused by the database's
      // line/account trigger, and there is no aggregate party a loan could use.
      partyType: 'employee',
      partyId: line.employeeId.toLowerCase(),
      memo: null,
    });
  }

  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'payroll_run',
    sourceId: input.runId.toLowerCase(),
    event: 'posted',
    // `payroll_run:<id>:posted`. The second approval of the same run — a retry, a
    // double-clicked button, a job replay — posts nothing and returns the first
    // journal (M19 check 2). The run's own status trigger refuses it too; both, for
    // the reason the ledger gives: which layer refuses depends on concurrency.
    idempotencyKey: idempotencyKey('payroll_run', input.runId, 'posted'),
    memo,
    reversesJournalId: null,
    lines,
  };
}

/**
 * Salary paid: **Dr Salary payable / Cr W** (§7).
 *
 * Separate from the posting above and deliberately so. Posting recognises the
 * cost; paying moves the cash, days later, possibly from a different wallet than
 * anyone expected when the run was approved. Folding them into one journal is the
 * shortcut that makes "what do we still owe our staff" unanswerable — which is the
 * question `salary_payable` exists to answer.
 */
export interface SalaryPaidInput {
  readonly runId: string;
  readonly occurredAt: Date;
  readonly salaryPayable: PayrollAccount;
  readonly wallet: PayrollAccount;
  readonly amountPoisha: Poisha;
  readonly memo: string | null;
}

export function salaryPaidDraft(input: SalaryPaidInput): JournalDraft {
  expect(input.salaryPayable, 'salary_payable');
  if (!ACCOUNT_SUBTYPES[input.wallet.subtype].wallet) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'Salary is paid from a wallet.');
  }
  if (input.amountPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A salary payment must be positive.');
  }

  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'payroll_run',
    sourceId: input.runId.toLowerCase(),
    event: 'paid',
    idempotencyKey: idempotencyKey('payroll_run', input.runId, 'paid'),
    memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.salaryPayable.accountId,
        debitPoisha: input.amountPoisha,
        creditPoisha: ZERO,
        // The wallet's branch on both lines, as a cash-out does: a showroom paying
        // its own staff out of its till should show in that showroom's cash book.
        branchId: input.salaryPayable.branchId ?? input.wallet.branchId,
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
