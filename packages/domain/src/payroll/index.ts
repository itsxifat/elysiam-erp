/**
 * Payroll arithmetic (architecture §12, D-029, invariant 11).
 *
 * Pure functions, so the preview a payroll officer looks at, the total a checker
 * approves and the journal that posts are all the same computation. The money rule
 * every one of them obeys is in `proration.ts`: a month's salary is split across
 * its half-day units exactly once, so pay and absence deduction always sum back to
 * the salary and no poisha is ever created or lost.
 */
export * from './errors.js';
export * from './months.js';
export * from './attendance.js';
export * from './proration.js';
export * from './loans.js';
export * from './payroll.js';
export * from './csv.js';
