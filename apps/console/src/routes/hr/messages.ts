import { useLocale } from '../../i18n/locale.js';
import { sectionCatalogue } from '../../i18n/messages.js';
import type { MessageKey } from '@elysium/i18n';

/**
 * The keys the HR and payroll screens render (M19).
 *
 * The strings are in `packages/i18n/src/locales/{en,bn}.ts`, which is where the
 * bn/en parity guarantee lives: `bn` is typed as `Record<MessageKey, string>`,
 * so a key translated on one side only does not compile. This file used to hold
 * its own copies because that catalogue was being written by several agents at
 * once and a second write discarded the first.
 *
 * Several keys end in a snake_case segment — `hr.attend.half_day`,
 * `hr.run.pending_approval` — because the call sites build them straight from a
 * domain enum value. A camelCase spelling would need a mapping table per enum,
 * and a mapping table is a second list to forget to update when a status is
 * added.
 *
 * The payslip **document** lives on the server (`payslip.template.ts`), in
 * English like everything else (D-750). These strings are the console's.
 */

const HR_KEYS = [
  'hr.people',
  'hr.peopleHint',
  'hr.attendance',
  'hr.payroll',
  'hr.loans',
  'hr.search',
  'hr.allBranches',
  'hr.allStatuses',
  'hr.newEmployee',
  'hr.colCode',
  'hr.colName',
  'hr.colDesignation',
  'hr.colBranch',
  'hr.colJoined',
  'hr.colStatus',
  'hr.colPayout',
  'hr.colPhone',
  'hr.status.active',
  'hr.status.suspended',
  'hr.status.resigned',
  'hr.status.terminated',
  'hr.payout.cash',
  'hr.payout.bank',
  'hr.payout.bkash',
  'hr.payout.nagad',
  'hr.field.code',
  'hr.field.name',
  'hr.field.designation',
  'hr.field.department',
  'hr.field.joinDate',
  'hr.field.branch',
  'hr.field.payoutMethod',
  'hr.field.payoutRef',
  'hr.field.nationalId',
  'hr.field.phone',
  'hr.privacyHint',
  'hr.save',
  'hr.cancel',
  'hr.salary',
  'hr.salaryHint',
  'hr.field.effectiveFrom',
  'hr.field.basic',
  'hr.field.allowance',
  'hr.addAllowance',
  'hr.colComponent',
  'hr.colAmount',
  'hr.colProrated',
  'hr.yes',
  'hr.no',
  'hr.earning',
  'hr.deduction',
  'hr.month',
  'hr.attendanceHint',
  'hr.colDate',
  'hr.colAttendance',
  'hr.colSource',
  'hr.source.manual',
  'hr.source.csv_import',
  'hr.source.device',
  'hr.attend.present',
  'hr.attend.late',
  'hr.attend.half_day',
  'hr.attend.absent',
  'hr.attend.leave_unpaid',
  'hr.attend.leave_paid',
  'hr.attend.weekly_off',
  'hr.attend.holiday',
  'hr.recordDay',
  'hr.employee',
  'hr.import',
  'hr.importHint',
  'hr.field.csv',
  'hr.field.mapEmployee',
  'hr.field.mapDate',
  'hr.field.mapStatus',
  'hr.field.mapIn',
  'hr.field.mapOut',
  'hr.preview',
  'hr.apply',
  'hr.importAccepted',
  'hr.importRejected',
  'hr.importUnknown',
  'hr.importApplied',
  'hr.colLine',
  'hr.colReason',
  'hr.payrollHint',
  'hr.newRun',
  'hr.colMonth',
  'hr.colStaff',
  'hr.colGross',
  'hr.colDeductions',
  'hr.colNet',
  'hr.run.draft',
  'hr.run.pending_approval',
  'hr.run.posted',
  'hr.run.paid',
  'hr.run.rejected',
  'hr.run.cancelled',
  'hr.open',
  'hr.runDetail',
  'hr.unrecordedPolicy',
  'hr.unrecorded.present',
  'hr.unrecorded.absent',
  'hr.bonuses',
  'hr.addBonus',
  'hr.field.label',
  'hr.field.kind',
  'hr.kind.bonus',
  'hr.kind.deduction',
  'hr.remove',
  'hr.submitRun',
  'hr.submittedHint',
  'hr.cancelRun',
  'hr.payRun',
  'hr.field.wallet',
  'hr.paidHint',
  'hr.payslips',
  'hr.colBasic',
  'hr.colAllowances',
  'hr.colBonus',
  'hr.colAbsence',
  'hr.colLoan',
  'hr.colWorkingDays',
  'hr.colPresent',
  'hr.colAbsent',
  'hr.downloadPayslip',
  'hr.payslipsAfterApproval',
  'hr.loansHint',
  'hr.newLoan',
  'hr.field.principal',
  'hr.field.instalments',
  'hr.field.firstMonth',
  'hr.field.note',
  'hr.colPrincipal',
  'hr.colOutstanding',
  'hr.colInstalments',
  'hr.loan.pending_disbursement',
  'hr.loan.active',
  'hr.loan.settled',
  'hr.loan.written_off',
  'hr.disburse',
  'hr.colDue',
  'hr.colDeducted',
  'hr.instalment.due',
  'hr.instalment.partly_deducted',
  'hr.instalment.deducted',
  'hr.instalment.waived',
  'hr.warnings',
  'hr.totals',
  'hr.emptyTitle',
  'hr.emptyPeople',
  'hr.emptyPeopleReadOnly',
  'hr.emptyRuns',
  'hr.emptyLoans',
  'hr.errorTitle',
  'hr.errorDetail',
  'hr.retry',
  'hr.deniedTitle',
  'hr.deniedDetail',
  'hr.deniedPeople',
  'hr.saveFailed',
  'hr.loading',
  'hr.edit',
  'hr.editTitle',
  'hr.editHint',
  'hr.editNothingChanged',
  'hr.editNameRequired',
  'hr.editPayoutRefRequired',
  'hr.field.leaveDate',
  'hr.field.login',
  'hr.noBranch',
  'hr.chooseBranch',
  'hr.unlistedBranch',
  'hr.notLinked',
  'hr.linkedElsewhere',
  'hr.unlistedLogin',
  'hr.keepHint',
  'hr.saved',
] as const satisfies readonly MessageKey[];

export type HrMessageKey = (typeof HR_KEYS)[number];

export const hrMessages = sectionCatalogue(HR_KEYS);
export const hrEn = hrMessages.en;

/**
 * The HR screens' lookup.
 *
 * Reads the locale from M05's provider, so the language switch in the shell
 * changes these strings too. Still throws on a missing value even though the key
 * type is narrow, because the dynamic call sites build the key out of a payroll
 * status and cast it, and a cast that a newly added status has outgrown would
 * otherwise put an empty cell in front of a payroll officer.
 */
export function useHrT(): (key: HrMessageKey) => string {
  const { locale } = useLocale();
  return (key) => {
    const value = hrMessages[locale][key];
    if (value === undefined) throw new Error(`No ${locale} message for "${key}".`);
    return value;
  };
}
