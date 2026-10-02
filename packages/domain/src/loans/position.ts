import type { IsoDate } from '../dates/index.js';
import { poisha, type Poisha } from '../money/index.js';

/**
 * Where a loan stands, from its schedule and the payments against it (M26).
 *
 * Nothing here is stored: a loan has no balance column, so every figure on a statement is
 * derived from the instalments and their payments on each read — and the statement puts the
 * ledger's own balance for the lender beside it, so a disagreement is visible.
 */

export type InstalmentPayment = 'posted' | 'pending_approval' | null;

export interface InstalmentFacts {
  readonly seq: number;
  readonly dueOn: IsoDate;
  readonly principalPoisha: Poisha;
  readonly interestPoisha: Poisha;
  /** The instalment's live payment: posted, waiting for a checker, or none. */
  readonly payment: InstalmentPayment;
}

export type InstalmentState = 'paid' | 'pending_approval' | 'overdue' | 'due';

export function instalmentState(row: InstalmentFacts, today: IsoDate): InstalmentState {
  if (row.payment === 'posted') return 'paid';
  if (row.payment === 'pending_approval') return 'pending_approval';
  return row.dueOn < today ? 'overdue' : 'due';
}

/**
 * The one instalment that may be paid now, or why none may (D-297).
 *
 * Instalments are paid whole and in order: the lowest one without a posted payment, and
 * only while no payment for it is waiting for a checker — one repayment in flight at a
 * time, so a rejected one can never leave a later instalment paid ahead of it.
 */
export function payableInstalment(
  rows: readonly InstalmentFacts[],
): { readonly seq: number } | { readonly seq: null; readonly reason: 'settled' | 'waiting' } {
  const next = [...rows].sort((a, b) => a.seq - b.seq).find((row) => row.payment !== 'posted');
  if (next === undefined) return { seq: null, reason: 'settled' };
  if (next.payment === 'pending_approval') return { seq: null, reason: 'waiting' };
  return { seq: next.seq };
}

export interface LoanPosition {
  readonly paidInstalments: number;
  readonly paidPrincipalPoisha: Poisha;
  readonly paidInterestPoisha: Poisha;
  readonly outstandingPrincipalPoisha: Poisha;
  readonly outstandingInterestPoisha: Poisha;
}

/** What is paid and what is still owed, over posted payments only. */
export function loanPosition(rows: readonly InstalmentFacts[]): LoanPosition {
  let paidCount = 0;
  let paidPrincipal = 0n;
  let paidInterest = 0n;
  let owedPrincipal = 0n;
  let owedInterest = 0n;
  for (const row of rows) {
    if (row.payment === 'posted') {
      paidCount += 1;
      paidPrincipal += row.principalPoisha;
      paidInterest += row.interestPoisha;
    } else {
      owedPrincipal += row.principalPoisha;
      owedInterest += row.interestPoisha;
    }
  }
  return {
    paidInstalments: paidCount,
    paidPrincipalPoisha: poisha(paidPrincipal),
    paidInterestPoisha: poisha(paidInterest),
    outstandingPrincipalPoisha: poisha(owedPrincipal),
    outstandingInterestPoisha: poisha(owedInterest),
  };
}
