import { add, sub, ZERO, type Poisha } from '../money/index.js';

/**
 * The trial balance, as a pure fold over journal lines (§7 "Reports").
 *
 * The server computes the same thing in SQL; this is the definition the SQL
 * is tested against, and the thing check 1's property is stated over: for any
 * sequence of balanced journals, total debits equal total credits, so the
 * trial balance nets to zero.
 */

export interface LedgerLine {
  readonly accountId: string;
  readonly debitPoisha: Poisha;
  readonly creditPoisha: Poisha;
}

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly debitPoisha: Poisha;
  readonly creditPoisha: Poisha;
  /** Debit minus credit. */
  readonly netPoisha: Poisha;
}

export interface TrialBalance {
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebitPoisha: Poisha;
  readonly totalCreditPoisha: Poisha;
  /** Σ debit − Σ credit. Zero for any ledger built from balanced journals. */
  readonly differencePoisha: Poisha;
}

export function trialBalance(lines: Iterable<LedgerLine>): TrialBalance {
  const byAccount = new Map<string, { debit: Poisha; credit: Poisha }>();
  let totalDebit = ZERO;
  let totalCredit = ZERO;

  for (const line of lines) {
    const entry = byAccount.get(line.accountId) ?? { debit: ZERO, credit: ZERO };
    entry.debit = add(entry.debit, line.debitPoisha);
    entry.credit = add(entry.credit, line.creditPoisha);
    byAccount.set(line.accountId, entry);
    totalDebit = add(totalDebit, line.debitPoisha);
    totalCredit = add(totalCredit, line.creditPoisha);
  }

  const rows = [...byAccount.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([accountId, { debit, credit }]) => ({
      accountId,
      debitPoisha: debit,
      creditPoisha: credit,
      netPoisha: sub(debit, credit),
    }));

  return {
    rows,
    totalDebitPoisha: totalDebit,
    totalCreditPoisha: totalCredit,
    differencePoisha: sub(totalDebit, totalCredit),
  };
}
