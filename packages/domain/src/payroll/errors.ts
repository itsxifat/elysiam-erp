/**
 * What the payroll arithmetic refuses (architecture §12, §23).
 *
 * Separate from `LedgerError` because these are refusals about *inputs a person
 * assembled* — a structure with no basic, a month that is not a month, a
 * deduction larger than the salary it comes out of — and the API has to answer
 * them with the code the client branches on rather than with a 500. The posting
 * rules below still raise `LedgerError`, because by the time a draft is built
 * the numbers have already been agreed.
 *
 * `PAYROLL_NET_NEGATIVE` is the one that earns its own code. A payroll run whose
 * deductions exceed somebody's salary is not a rounding problem, it is a data
 * problem — a fixed deduction typed in taka instead of poisha, most likely — and
 * the right behaviour is to stop the whole run rather than to clamp the net to
 * zero and quietly pay nothing. Clamping is what makes "why did Rina get no
 * salary in March" a question nobody can answer.
 */
export type PayrollErrorCode =
  | 'PAYROLL_INPUT_INVALID'
  | 'PAYROLL_NET_NEGATIVE'
  | 'PAYROLL_ATTENDANCE_INVALID'
  | 'PAYROLL_LOAN_INVALID';

export class PayrollError extends Error {
  constructor(
    readonly code: PayrollErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PayrollError';
  }
}
