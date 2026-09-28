import { parseCsv, type CsvTable } from '../catalog/csv.js';
import { isIsoDate, toIsoDate, type IsoDate } from '../dates/index.js';

import { isAttendanceStatus, type AttendanceStatus } from './attendance.js';
import { monthOf, type PayrollMonth } from './months.js';

/**
 * The biometric attendance import (architecture §12, §21 `AttendanceImporter`).
 *
 * §21 says CSV first, and §12 says "CSV import from the biometric device
 * software". There is no single format for that: ZKTeco, Hikvision and the
 * half-dozen Chinese devices sold in Bangladesh each export different column
 * names, and every office has one person who has already renamed them in Excel.
 * So the import is **mapping-driven** — the file is whatever it is, and the org
 * says which of its columns means what — rather than requiring a fixed header.
 *
 * `parseCsv` is reused from the catalog importer rather than reimplemented,
 * because the files have the same three properties that break naive parsers: an
 * Excel BOM, CRLF endings, and quoted fields with commas inside. Bangla names in
 * the employee column are ordinary here.
 *
 * ## Nothing is guessed and nothing is partially applied
 *
 * Each row is either understood or rejected with a line number and a reason, and
 * the caller decides whether to apply the accepted ones — the same all-or-nothing
 * shape M06's price import settled on. A device file with one unreadable date
 * should not turn into a month where one person is silently marked absent: an
 * absence costs somebody money, which is the asymmetry that makes "skip the bad
 * rows" the wrong default here and only here.
 */

/** Which column in the file carries which field. Values are header names. */
export interface AttendanceCsvMapping {
  /** The employee's code as the org issues it, e.g. `EMP-014`. */
  readonly employeeCode: string;
  /** An Asia/Dhaka calendar date, `YYYY-MM-DD` or `DD/MM/YYYY`. */
  readonly date: string;
  /** Optional: a status word. Absent means the status is derived from the times. */
  readonly status?: string | undefined;
  readonly checkIn?: string | undefined;
  readonly checkOut?: string | undefined;
}

export interface ParsedAttendanceRow {
  readonly line: number;
  readonly employeeCode: string;
  readonly date: IsoDate;
  readonly status: AttendanceStatus;
  /** `HH:MM` in Asia/Dhaka, or null. Stored as a timestamptz by the caller. */
  readonly checkIn: string | null;
  readonly checkOut: string | null;
}

export interface RejectedAttendanceRow {
  readonly line: number;
  readonly reason: string;
}

export interface AttendanceImportReview {
  readonly month: PayrollMonth | null;
  readonly accepted: readonly ParsedAttendanceRow[];
  readonly rejected: readonly RejectedAttendanceRow[];
  /** Header names the mapping asked for that the file does not have. */
  readonly missingColumns: readonly string[];
}

/** Status words devices and spreadsheets actually write, folded to ours. */
const STATUS_WORDS: Readonly<Record<string, AttendanceStatus>> = {
  p: 'present',
  present: 'present',
  in: 'present',
  ok: 'present',
  a: 'absent',
  absent: 'absent',
  ab: 'absent',
  l: 'late',
  late: 'late',
  h: 'half_day',
  hd: 'half_day',
  half: 'half_day',
  'half day': 'half_day',
  half_day: 'half_day',
  lv: 'leave_unpaid',
  leave: 'leave_unpaid',
  leave_unpaid: 'leave_unpaid',
  leave_paid: 'leave_paid',
  'paid leave': 'leave_paid',
  w: 'weekly_off',
  off: 'weekly_off',
  weekend: 'weekly_off',
  weekly_off: 'weekly_off',
  holiday: 'holiday',
  ho: 'holiday',
};

const TIME = /^(\d{1,2}):(\d{2})(?::\d{2})?$/;

/**
 * A cell, as a rejection reason may quote it.
 *
 * Quoted at all because "row 6 could not be read" without the offending value is not enough
 * to fix a file; capped because a *mis-mapped* column means the value is whatever that column
 * held — an employee's name, most likely — and the reasons are persisted in
 * `hr.attendance_imports.rejected` and returned to the caller (invariant 10). Forty characters
 * is more than any date or time and short enough that a wrong column parks a fragment rather
 * than a record.
 */
function quoted(value: string): string {
  return value.length <= 40 ? value : `${value.slice(0, 40)}…`;
}

/** `HH:MM`, or null for an empty cell. Throws its own message for a bad one. */
function parseTime(raw: string): string | null {
  const value = raw.trim();
  if (value === '') return null;
  const match = TIME.exec(value);
  if (match === null) throw new Error(`"${quoted(value)}" is not a time of day.`);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) throw new Error(`"${quoted(value)}" is not a time of day.`);
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

/**
 * `YYYY-MM-DD`, or `DD/MM/YYYY` and `DD-MM-YYYY`.
 *
 * Day-first, not month-first, and this is the one place in the importer where a
 * choice could silently corrupt a month: `03/04/2026` is the 3rd of April in
 * Bangladesh and the 4th of March in an American spreadsheet. Day-first is the
 * local convention, and an unambiguous `2026-04-03` is always accepted, so an org
 * that wants certainty can export ISO.
 */
function parseDate(raw: string): IsoDate {
  const value = raw.trim();
  if (isIsoDate(value)) return toIsoDate(value);
  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  if (match === null) throw new Error(`"${quoted(value)}" is not a date.`);
  const [, day = '', month = '', year = ''] = match;
  return toIsoDate(`${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`);
}

function statusFrom(
  raw: string | undefined,
  checkIn: string | null,
  checkOut: string | null,
): AttendanceStatus {
  const word = (raw ?? '').trim().toLowerCase();
  if (word !== '') {
    const mapped = STATUS_WORDS[word] ?? (isAttendanceStatus(word) ? word : undefined);
    if (mapped === undefined) {
      throw new Error(`"${quoted(raw ?? '')}" is not an attendance status.`);
    }
    return mapped;
  }
  /*
   * No status column: a punch is presence and no punch is absence.
   *
   * Deliberately not clever. A device row with a check-in and no check-out is
   * somebody who came to work and whose exit did not register, and calling that a
   * half day would dock half a day's pay because a fingerprint reader missed a
   * finger. Late is not inferred from the time either — the shift start is not in
   * this file, and guessing it would mark a night-shift packer late every day.
   */
  if (checkIn === null && checkOut === null) return 'absent';
  return 'present';
}

export function reviewAttendanceCsv(input: {
  readonly text: string;
  readonly mapping: AttendanceCsvMapping;
  /** When given, a row outside this month is rejected rather than imported. */
  readonly month?: PayrollMonth | undefined;
}): AttendanceImportReview {
  let table: CsvTable;
  try {
    table = parseCsv(input.text);
  } catch (error) {
    return {
      month: input.month ?? null,
      accepted: [],
      rejected: [{ line: 1, reason: error instanceof Error ? error.message : 'Unreadable file.' }],
      missingColumns: [],
    };
  }

  /*
   * `parseCsv` lower-cases and trims every header, so the mapping is folded the
   * same way before it is looked up.
   *
   * Without this a mapping that says `Emp ID` — which is what the device wrote and
   * what the person configuring the import copied — finds nothing, and the import
   * reports every column missing while the file plainly has them. Case is not
   * information in a CSV header.
   */
  const fold = (header: string): string => header.trim().toLowerCase();
  const mapping = {
    employeeCode: fold(input.mapping.employeeCode),
    date: fold(input.mapping.date),
    status: input.mapping.status === undefined ? undefined : fold(input.mapping.status),
    checkIn: input.mapping.checkIn === undefined ? undefined : fold(input.mapping.checkIn),
    checkOut: input.mapping.checkOut === undefined ? undefined : fold(input.mapping.checkOut),
  };

  const wanted = [
    mapping.employeeCode,
    mapping.date,
    ...(mapping.status === undefined ? [] : [mapping.status]),
    ...(mapping.checkIn === undefined ? [] : [mapping.checkIn]),
    ...(mapping.checkOut === undefined ? [] : [mapping.checkOut]),
  ];
  const missing = wanted.filter((header) => !table.headers.includes(header));
  if (missing.length > 0) {
    return { month: input.month ?? null, accepted: [], rejected: [], missingColumns: missing };
  }

  const accepted: ParsedAttendanceRow[] = [];
  const rejected: RejectedAttendanceRow[] = [];
  // (code, date) already seen, so a device that punches four times a day does not
  // produce four rows the database's unique index would then reject one at a time.
  const seen = new Set<string>();

  for (const row of table.rows) {
    try {
      const employeeCode = (row.values[mapping.employeeCode] ?? '').trim();
      if (employeeCode === '') throw new Error('The employee code is blank.');
      if (employeeCode.length > 40) throw new Error('That employee code is too long to be one.');

      const date = parseDate(row.values[mapping.date] ?? '');
      if (input.month !== undefined && monthOf(date) !== input.month) {
        throw new Error(`${date} is not in ${input.month}.`);
      }

      const checkIn =
        mapping.checkIn === undefined ? null : parseTime(row.values[mapping.checkIn] ?? '');
      const checkOut =
        mapping.checkOut === undefined ? null : parseTime(row.values[mapping.checkOut] ?? '');
      if (checkIn !== null && checkOut !== null && checkOut < checkIn) {
        // An overnight shift is real, but this importer cannot tell one from a
        // swapped pair of columns — and the mapping is exactly where that mistake
        // is made. Rejecting names the row; accepting would produce a negative
        // working day nobody would look at again.
        throw new Error('The check-out time is before the check-in time.');
      }

      const status = statusFrom(
        mapping.status === undefined ? undefined : row.values[mapping.status],
        checkIn,
        checkOut,
      );

      const key = `${employeeCode.toUpperCase()}:${date}`;
      if (seen.has(key)) throw new Error(`${employeeCode} already has a row for ${date}.`);
      seen.add(key);

      accepted.push({ line: row.line, employeeCode, date, status, checkIn, checkOut });
    } catch (error) {
      rejected.push({
        line: row.line,
        reason: error instanceof Error ? error.message : 'That row could not be read.',
      });
    }
  }

  const months = new Set(accepted.map((row) => monthOf(row.date)));
  return {
    month: input.month ?? (months.size === 1 ? ([...months][0] ?? null) : null),
    accepted,
    rejected,
    missingColumns: [],
  };
}
