import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';
import { LedgerError, MoneyError } from '@elysium/domain';
import { PayrollError } from '@elysium/domain/payroll';
import { TargetError } from '@elysium/domain/targets';

import { HrDecryptionFailed } from './hr.crypto.js';

/**
 * HR and payroll failures, as the API reports them (architecture §23, D-087).
 *
 * Same shape as the ledger's, the inventory's and the supply module's: a stable
 * `code` plus a message, so a client branches on the code and never on the wording.
 *
 * ## Why the codes are declared here and not in `packages/contracts`
 *
 * They belong in `packages/contracts/src/errors.ts` with every other code, and
 * M19's INTEGRATION section hands the integrator the block to paste there. That file
 * is edited by several milestones at once in this working tree, and a second write to
 * it silently discards the first — so the union is widened locally, `HR_ERROR_CODES`
 * is exported for the integrator to copy verbatim, and a test asserts the two lists
 * agree once they are merged. Nothing here invents a code that already exists:
 * `IDEMPOTENCY_CONFLICT`, `APPROVAL_REQUIRED`, `PERIOD_CLOSED`, `MONEY_INVALID` and
 * `WALLET_INACTIVE` are the ledger's and are reused as they are.
 *
 * `databasePayrollCode` is the part worth reading. Migrations 0055 and 0056 raise
 * nine of these codes from triggers, and the CHECKs in 0053 raise 23514 for the
 * conditions the payroll arithmetic exists to make impossible. Both have to become
 * the same codes the services raise, because **which layer notices depends on
 * concurrency**: one request is refused by the service's own check, and two
 * simultaneous submits of the same run are refused by the database.
 */
export const HR_ERROR_CODES = [
  /** No such employee, payroll run, loan, calendar or import in this brand. */
  'HR_NOT_FOUND',
  /** That employee has resigned or been terminated, so nothing new may be recorded. */
  'HR_EMPLOYEE_INACTIVE',
  /** The employee has no salary structure effective in that month. */
  'HR_SALARY_STRUCTURE_MISSING',
  /** A mask column was given something that looks like a full number (invariant 10). */
  'HR_FIELD_NOT_MASKED',
  /** A stored encrypted field could not be read: wrong key, or a tampered row. */
  'HR_FIELD_UNREADABLE',
  /** An attendance day is invalid, or a correction did not record itself as manual. */
  'ATTENDANCE_INVALID',
  /** The CSV could not be read, or the mapping named columns it does not have. */
  'ATTENDANCE_IMPORT_REJECTED',
  /** An import that has already been applied or rejected cannot be decided again. */
  'ATTENDANCE_IMPORT_FROZEN',
  /** No such payroll run, or none for that month. */
  'PAYROLL_NOT_FOUND',
  /** A posted payroll run cannot be changed; reverse it and post a new one. */
  'PAYROLL_IMMUTABLE',
  /** A run's terms are fixed once it has been submitted for approval. */
  'PAYROLL_RUN_FROZEN',
  /** That transition is not one a payroll run may make (check 2). */
  'PAYROLL_TRANSITION_INVALID',
  /** The approval named is not a server-derived `payroll_run` for this amount. */
  'PAYROLL_APPROVAL_INVALID',
  /** The run's stored totals and its payslips disagree. */
  'PAYROLL_TOTALS_MISMATCH',
  /** Deductions exceed an employee's salary for the month; refused, never clamped. */
  'PAYROLL_NET_NEGATIVE',
  /** A salary structure a payslip has already been issued against cannot change. */
  'PAYROLL_STRUCTURE_FROZEN',
  /** A disbursed loan's terms, or a deducted instalment, cannot change. */
  'PAYROLL_LOAN_FROZEN',
  /** A loan's principal, instalment count or schedule is not a valid one. */
  'PAYROLL_LOAN_INVALID',
  /** Something in the run's inputs is not a payroll input. */
  'PAYROLL_INPUT_INVALID',
  /** Attendance the proration cannot make sense of. */
  'PAYROLL_ATTENDANCE_INVALID',
  /** M20: a target that cannot be set as asked. */
  'TARGET_INVALID',
  /** M20: that employee already has a live target on that metric for that month. */
  'TARGET_CONFLICT',
  /** M20: a target's terms and weekly split are fixed; a cancelled one is final. */
  'TARGET_FROZEN',
  /** M20: the bonus rule's JSON is not a rule this system can evaluate. */
  'BONUS_RULE_INVALID',
  /** M20: a submitted or decided bonus rule version cannot change. */
  'BONUS_RULE_FROZEN',
] as const;

export type HrErrorCode = (typeof HR_ERROR_CODES)[number];

/** Codes this module raises: its own, plus the shared ones it reuses unchanged. */
export type PayrollApiCode = HrErrorCode | ErrorCode;

const STATUS: Readonly<Partial<Record<PayrollApiCode, number>>> = {
  // The ledger's codes keep the ledger's statuses. Without these they fell through to
  // 400, which tells a caller to fix their input: choosing a wallet that `GET
  // /v1/ledger/wallets` deliberately still lists when it is closed is not a malformed
  // request, it is a state conflict, and a brand with no salary account is not the
  // caller's fault either.
  WALLET_INACTIVE: 409,
  LEDGER_ACCOUNT_NOT_FOUND: 404,
  HR_NOT_FOUND: 404,
  PAYROLL_NOT_FOUND: 404,
  // 409, not 400: the request was well-formed and the state of the world disagreed.
  // A client retries a 409 after reloading; a 400 tells it to change the body.
  HR_EMPLOYEE_INACTIVE: 409,
  PAYROLL_IMMUTABLE: 409,
  PAYROLL_RUN_FROZEN: 409,
  PAYROLL_TRANSITION_INVALID: 409,
  PAYROLL_APPROVAL_INVALID: 409,
  PAYROLL_TOTALS_MISMATCH: 409,
  PAYROLL_STRUCTURE_FROZEN: 409,
  PAYROLL_LOAN_FROZEN: 409,
  ATTENDANCE_IMPORT_FROZEN: 409,
  TARGET_CONFLICT: 409,
  TARGET_FROZEN: 409,
  BONUS_RULE_FROZEN: 409,
  APPROVAL_REQUIRED: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PERIOD_CLOSED: 409,
  // 500. A field that will not decrypt is our problem, not the caller's: the key is
  // wrong or the row is damaged, and a 400 would send them looking at their request
  // for a fault that is not in it.
  HR_FIELD_UNREADABLE: 500,
};

export class HrError extends Error {
  constructor(
    readonly code: PayrollApiCode,
    message: string,
  ) {
    super(message);
    this.name = 'HrError';
  }
}

export function hrHttpError(code: PayrollApiCode, message: string): HttpException {
  const body = { code, message };
  switch (STATUS[code] ?? 400) {
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    case 500:
      // Rethrown as an ordinary Error so the pipeline logs it as a 500 rather than
      // presenting it as something the caller did.
      return new HttpException(body, 500);
    default:
      return new BadRequestException(body);
  }
}

/** Codes migrations 0055 and 0056 raise with a `CODE: message` prefix. */
const TRIGGER_CODES: readonly PayrollApiCode[] = [
  'PAYROLL_IMMUTABLE',
  'PAYROLL_RUN_FROZEN',
  'PAYROLL_TRANSITION_INVALID',
  'PAYROLL_APPROVAL_INVALID',
  'PAYROLL_TOTALS_MISMATCH',
  'PAYROLL_STRUCTURE_FROZEN',
  'PAYROLL_LOAN_FROZEN',
  'ATTENDANCE_INVALID',
  'ATTENDANCE_IMPORT_FROZEN',
  'HR_FIELD_NOT_MASKED',
  // M20's, from 0091.
  'TARGET_INVALID',
  'TARGET_FROZEN',
  'BONUS_RULE_FROZEN',
  'PAYROLL_INPUT_INVALID',
];

/**
 * The CHECKs that mean something specific, and what to say instead of their names.
 *
 * `payroll_lines_journal_identity` is the one worth spelling out: it fires when a
 * payslip's salary expense plus bonus does not equal its net plus its loan deduction,
 * which is §7's payroll journal refusing to balance. A caller cannot fix that by
 * changing their request — it means the computation is wrong — so the message says so
 * rather than blaming the input.
 */
const CHECK_MESSAGES: Readonly<Record<string, { code: PayrollApiCode; message: string }>> = {
  payroll_lines_journal_identity: {
    code: 'PAYROLL_TOTALS_MISMATCH',
    message: 'That payslip does not balance against the payroll journal; nothing was posted.',
  },
  payroll_lines_net_composition: {
    code: 'PAYROLL_TOTALS_MISMATCH',
    message: 'That payslip’s net pay is not its gross less its deductions.',
  },
  payroll_lines_gross_composition: {
    code: 'PAYROLL_TOTALS_MISMATCH',
    message: 'That payslip’s gross is not its basic, allowances and bonus.',
  },
  payroll_lines_deductions_composition: {
    code: 'PAYROLL_TOTALS_MISMATCH',
    message: 'That payslip’s deductions do not add up to the four kinds it lists.',
  },
  payroll_runs_totals_add_up: {
    code: 'PAYROLL_TOTALS_MISMATCH',
    message: 'That payroll run’s totals do not add up.',
  },
  payroll_runs_status_links: {
    code: 'PAYROLL_TRANSITION_INVALID',
    message: 'A payroll run in that state cannot name those journals.',
  },
  loan_instalments_deducted_within_amount: {
    code: 'PAYROLL_LOAN_FROZEN',
    message: 'That instalment has already been deducted in full.',
  },
  loan_instalments_status_matches_deducted: {
    code: 'PAYROLL_LOAN_FROZEN',
    message: 'That instalment’s state does not match how much has been deducted from it.',
  },
  employees_payout_ref_present: {
    code: 'PAYROLL_INPUT_INVALID',
    message: 'A bank or mobile-wallet payout needs an account number.',
  },
  employees_leave_after_join: {
    code: 'PAYROLL_INPUT_INVALID',
    message: 'An employee cannot leave before they joined.',
  },
  salary_components_code_not_reserved: {
    code: 'PAYROLL_INPUT_INVALID',
    message:
      'basic, bonus, absence, other_deduction and loan_instalment are the codes a payslip generates; use a different one.',
  },
  employees_code_format: {
    code: 'PAYROLL_INPUT_INVALID',
    message: 'An employee code is letters, digits, dots, slashes and dashes.',
  },
  payroll_lines_days_sane: {
    code: 'PAYROLL_ATTENDANCE_INVALID',
    message: 'That payslip counts more attended days than the month has working days.',
  },
  attendance_days_import_matches_source: {
    code: 'ATTENDANCE_INVALID',
    message: 'An imported attendance row names its import; a manual one does not.',
  },
};

const UNIQUE_MESSAGES: Readonly<Record<string, { code: PayrollApiCode; message: string }>> = {
  employees_org_code_idx: {
    code: 'PAYROLL_INPUT_INVALID',
    message: 'An employee with that code already exists in this brand.',
  },
  employees_org_user_idx: {
    code: 'PAYROLL_INPUT_INVALID',
    message: 'That login is already linked to another employee in this brand.',
  },
  payroll_runs_org_live_month_idx: {
    code: 'PAYROLL_TRANSITION_INVALID',
    message: 'A payroll run for that month already exists. Close it before starting another.',
  },
  payroll_lines_org_run_employee_idx: {
    code: 'PAYROLL_TOTALS_MISMATCH',
    message: 'That employee already has a payslip in this run.',
  },
  attendance_days_org_employee_date_idx: {
    code: 'ATTENDANCE_INVALID',
    message: 'That employee already has an attendance record for that day.',
  },
  salary_structures_org_employee_from_idx: {
    code: 'PAYROLL_INPUT_INVALID',
    message: 'That employee already has a salary structure effective from that date.',
  },
  work_calendars_org_code_idx: {
    code: 'PAYROLL_INPUT_INVALID',
    message: 'A working-day calendar with that code already exists in this brand.',
  },
  work_calendars_org_default_idx: {
    code: 'PAYROLL_INPUT_INVALID',
    message: 'This brand already has a default working-day calendar.',
  },
  payroll_loan_deductions_org_line_instalment_idx: {
    code: 'PAYROLL_LOAN_FROZEN',
    message: 'That loan instalment has already been deducted on this payslip.',
  },
  targets_org_month_metric_employee_idx: {
    code: 'TARGET_CONFLICT',
    message: 'That employee already has a target on that metric for that month. Cancel it first.',
  },
  bonus_rules_org_name_idx: {
    code: 'BONUS_RULE_INVALID',
    message: 'A bonus rule with that name already exists in this brand.',
  },
  bonus_rule_versions_org_rule_pending_idx: {
    code: 'BONUS_RULE_FROZEN',
    message: 'Another version of this rule is already waiting for approval.',
  },
  bonus_rule_versions_org_rule_version_idx: {
    code: 'BONUS_RULE_FROZEN',
    message: 'Somebody added a version of this rule at the same moment; reload and try again.',
  },
};

export function databasePayrollCode(
  error: unknown,
): { code: PayrollApiCode; message: string } | null {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    const prefixed = /^([A-Z_]+): (.*)$/s.exec(current.message);
    if (prefixed !== null) {
      const code = TRIGGER_CODES.find((candidate) => candidate === prefixed[1]);
      if (code !== undefined) return { code, message: prefixed[2] ?? current.message };
    }

    const sqlstate = (current as { code?: unknown }).code;
    const constraint = (current as { constraint_name?: unknown }).constraint_name;
    const name = typeof constraint === 'string' ? constraint : '';

    if (sqlstate === '23514' && Object.hasOwn(CHECK_MESSAGES, name)) {
      return CHECK_MESSAGES[name] ?? null;
    }
    if (sqlstate === '23505') {
      return (
        UNIQUE_MESSAGES[name] ?? {
          code: 'PAYROLL_INPUT_INVALID',
          // Never the index name: it tells a caller the shape of our schema and tells
          // the person reading the screen nothing.
          message: 'That value is already taken in this brand.',
        }
      );
    }
  }
  return null;
}

export function toHrHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof HrError) return hrHttpError(error.code, error.message);
  if (error instanceof PayrollError) return hrHttpError(error.code, error.message);
  if (error instanceof TargetError) return hrHttpError(error.code, error.message);
  if (error instanceof LedgerError) return hrHttpError(error.code, error.message);
  if (error instanceof MoneyError) return hrHttpError('MONEY_INVALID', error.message);
  if (error instanceof HrDecryptionFailed) {
    return hrHttpError('HR_FIELD_UNREADABLE', error.message);
  }
  const fromDatabase = databasePayrollCode(error);
  if (fromDatabase !== null) return hrHttpError(fromDatabase.code, fromDatabase.message);
  return error;
}

export async function mapHrErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toHrHttpError(error);
  }
}
