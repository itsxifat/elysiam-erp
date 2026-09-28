import { toIsoDate, type IsoDate } from '../dates/index.js';

import { PayrollError } from './errors.js';
import { monthDays, weekdayOf, type PayrollMonth } from './months.js';

/**
 * The working-day calendar and what attendance does to a month's pay
 * (architecture §12, D-029).
 *
 * ## Why everything is counted in half-days
 *
 * A half day is the reason. Paying half a day out of a monthly salary means
 * dividing by twice the working days, and dividing an integer amount of poisha by
 * 44 and then halving it rounds twice — which is how a run that should pay
 * ৳30,000.00 pays ৳29,999.98 and nobody can say where the two poisha went.
 *
 * So the month is measured in **half-day units** from the start: a working day is
 * two units, a half day forfeits one, a full absence forfeits two. The whole
 * month's salary is then split across the units *once*, with largest remainder,
 * and the forfeited units are taken out of that split. Every poisha therefore
 * lands either in the employee's pay or in the absence deduction, and the two
 * always sum to the salary — which is the property `payroll.test.ts` proves.
 */

/**
 * What a recorded day says about pay.
 *
 * `late` is deliberately paid in full. A late mark is a discipline fact and a
 * productivity input (§12), not a pay cut — an org that wants to dock it does so
 * with an explicit deduction input that a checker can see, rather than through a
 * rule buried in a calendar.
 */
export const ATTENDANCE_STATUSES = [
  'present',
  'late',
  'half_day',
  'absent',
  /** Leave with no balance behind it. Leave management itself is out of scope (D-030). */
  'leave_unpaid',
  'leave_paid',
  'weekly_off',
  'holiday',
] as const;

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

/** Half-day units a status forfeits on a working day. */
const FORFEITED_UNITS: Readonly<Record<AttendanceStatus, number>> = {
  present: 0,
  late: 0,
  half_day: 1,
  absent: 2,
  leave_unpaid: 2,
  leave_paid: 0,
  weekly_off: 0,
  holiday: 0,
};

export function forfeitedUnits(status: AttendanceStatus): number {
  return FORFEITED_UNITS[status];
}

export function isAttendanceStatus(value: string): value is AttendanceStatus {
  return (ATTENDANCE_STATUSES as readonly string[]).includes(value);
}

/**
 * An org's working-day calendar (§12).
 *
 * `weeklyOff` holds weekday numbers, 0 = Sunday. Bangladesh's usual pattern is
 * Friday alone or Friday and Saturday, so it is a list rather than a flag.
 * `holidays` are specific dates; a holiday that lands on a weekly off is simply
 * both, and counting it twice is the mistake `workingDays` is written to avoid.
 */
export interface WorkCalendar {
  readonly weeklyOff: readonly number[];
  readonly holidays: readonly IsoDate[];
}

export function isWorkingDay(calendar: WorkCalendar, date: IsoDate): boolean {
  if (calendar.weeklyOff.includes(weekdayOf(date))) return false;
  return !calendar.holidays.includes(date);
}

/** The month's working dates, in order. */
export function workingDays(calendar: WorkCalendar, month: PayrollMonth): IsoDate[] {
  return monthDays(month).filter((date) => isWorkingDay(calendar, date));
}

/**
 * How an unrecorded working day is treated (D-186, ASSUMED).
 *
 * `present` is the default, and the reason is whose mistake it punishes. The
 * biometric CSV is imported by an office administrator; if a failed import meant
 * `absent`, a forgotten upload would dock a month's salary from everybody who
 * turned up, and they would find out on payday. Paying an unrecorded day and
 * putting the count in front of the checker puts the mistake where it can be
 * caught instead.
 */
export type UnrecordedPolicy = 'present' | 'absent';

export interface AttendanceRecord {
  readonly date: IsoDate;
  readonly status: AttendanceStatus;
}

export interface AttendanceSummaryInput {
  readonly month: PayrollMonth;
  readonly calendar: WorkCalendar;
  /** Records for this employee in this month. Days outside the month are ignored. */
  readonly records: readonly AttendanceRecord[];
  /** Inclusive. A day before this is not employed, so it is not payable. */
  readonly joinedOn: IsoDate;
  /** Inclusive last day of employment, or null while employed. */
  readonly leftOn?: IsoDate | null;
  readonly unrecorded?: UnrecordedPolicy;
}

/**
 * What the payslip says about the month, and what the proration needs.
 *
 * `units` is twice `workingDays`, `forfeited` is what attendance took away and
 * `notEmployed` is what a mid-month join or leave took away. They are kept apart
 * because they read differently on a payslip and because only the first is
 * something the employee can argue about — but they prorate identically, which is
 * why `unpaidUnits` adds them.
 */
export interface AttendanceSummary {
  readonly month: PayrollMonth;
  readonly workingDays: number;
  readonly units: number;
  readonly presentDays: number;
  readonly absentDays: number;
  readonly halfDays: number;
  readonly paidLeaveDays: number;
  readonly lateDays: number;
  readonly unrecordedDays: number;
  readonly forfeitedUnits: number;
  readonly notEmployedUnits: number;
  readonly unpaidUnits: number;
}

export function attendanceSummary(input: AttendanceSummaryInput): AttendanceSummary {
  const policy = input.unrecorded ?? 'present';
  const joined = input.joinedOn;
  const left = input.leftOn ?? null;
  if (left !== null && left < joined) {
    throw new PayrollError(
      'PAYROLL_ATTENDANCE_INVALID',
      'An employee cannot have left before they joined.',
    );
  }

  const byDate = new Map<string, AttendanceStatus>();
  for (const record of input.records) {
    // Last write wins rather than first, so a corrected manual entry layered over
    // an imported one is the entry that counts. The database's unique index on
    // (org, employee, date) means this only ever sees one row per day in
    // production; the tolerance is here so a caller assembling records by hand
    // does not get a silently wrong month.
    byDate.set(record.date, record.status);
  }

  const dates = workingDays(input.calendar, input.month);
  let presentDays = 0;
  let absentDays = 0;
  let halfDays = 0;
  let paidLeaveDays = 0;
  let lateDays = 0;
  let unrecordedDays = 0;
  let forfeited = 0;
  let notEmployed = 0;

  for (const date of dates) {
    const employed = date >= joined && (left === null || date <= left);
    if (!employed) {
      notEmployed += 2;
      continue;
    }

    const recorded = byDate.get(date);
    const status: AttendanceStatus = recorded ?? (policy === 'present' ? 'present' : 'absent');
    if (recorded === undefined) unrecordedDays += 1;

    switch (status) {
      case 'present':
        presentDays += 1;
        break;
      case 'late':
        presentDays += 1;
        lateDays += 1;
        break;
      case 'half_day':
        halfDays += 1;
        break;
      case 'leave_paid':
        paidLeaveDays += 1;
        break;
      case 'absent':
      case 'leave_unpaid':
        absentDays += 1;
        break;
      // A weekly off or a holiday recorded against a working day is a calendar
      // disagreement, not attendance. Treated as worked rather than refused: the
      // calendar is the authority on which days are working days, and the count
      // of unrecorded days is what surfaces a calendar that needs fixing.
      case 'weekly_off':
      case 'holiday':
        presentDays += 1;
        break;
    }
    forfeited += forfeitedUnits(status);
  }

  const units = dates.length * 2;
  return {
    month: input.month,
    workingDays: dates.length,
    units,
    presentDays,
    absentDays,
    halfDays,
    paidLeaveDays,
    lateDays,
    unrecordedDays,
    forfeitedUnits: forfeited,
    notEmployedUnits: notEmployed,
    unpaidUnits: forfeited + notEmployed,
  };
}

/** A month with nobody's attendance in it, for a preview before any import. */
export function emptyAttendance(
  month: PayrollMonth,
  calendar: WorkCalendar,
  joinedOn?: IsoDate,
): AttendanceSummary {
  return attendanceSummary({
    month,
    calendar,
    records: [],
    joinedOn: joinedOn ?? toIsoDate(`${month}-01`),
  });
}
