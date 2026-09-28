import { Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { toIsoDate, type IsoDate } from '@elysium/domain';
import {
  attendanceSummary,
  daysInMonth,
  reviewAttendanceCsv,
  toPayrollMonth,
  type AttendanceStatus,
  type AttendanceSummary,
  type PayrollMonth,
  type UnrecordedPolicy,
  type WorkCalendar,
} from '@elysium/domain/payroll';
import { sql } from 'drizzle-orm';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope, scopeWhere } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { HrError, mapHrErrors } from './hr.errors.js';
import * as repo from './hr.repository.js';
import type {
  AttendanceImportInput,
  AttendanceQuery,
  RecordAttendanceInput,
} from './hr.schemas.js';

/**
 * Attendance: typed in, or imported from the biometric software
 * (architecture §12, §21 `AttendanceImporter`).
 *
 * ## The import previews by default
 *
 * `apply` defaults to false in `attendanceImportSchema`, so the first thing a person
 * gets back is what *would* happen: how many rows were understood, which ones were
 * not and why, and which employee codes the file names that this brand does not have.
 * That is not politeness. A wrong column mapping — the date column pointed at the
 * employee-number column, which is the easy mistake — would otherwise mark a month of
 * absences on the first click, and an absence costs somebody money. Nothing else in
 * the system defaults to a dry run; this does because the cost of being wrong lands on
 * a person rather than on a report.
 *
 * ## Times are stored as instants, dates as dates
 *
 * A check-in of `09:05` on 2026-03-01 is stored as the `timestamptz`
 * `2026-03-01T09:05:00+06:00` and the business date as `2026-03-01` (invariant 8). The
 * two are separate columns because a night shift's check-out at 01:00 belongs to the
 * shift that started the day before, and deriving one from the other would file it
 * under the wrong day.
 */

/** Asia/Dhaka's offset. Fixed: Bangladesh has had no DST since 2009. */
const DHAKA_OFFSET = '+06:00';

export interface AttendanceDayView {
  readonly id: string;
  readonly employeeId: string;
  readonly branchId: string | null;
  readonly businessDate: string;
  readonly status: string;
  readonly checkInAt: string | null;
  readonly checkOutAt: string | null;
  readonly source: string;
  readonly note: string | null;
}

export interface AttendanceImportView {
  readonly id: string | null;
  readonly month: string;
  readonly status: 'parsed' | 'applied' | 'rejected';
  readonly rowCount: number;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly rejected: readonly { readonly line: number; readonly reason: string }[];
  readonly missingColumns: readonly string[];
  /** Codes the file names that this brand has no employee for. */
  readonly unknownCodes: readonly string[];
}

@Injectable()
export class AttendanceService {
  constructor(private readonly audit: AuditService) {}

  /**
   * The scope columns for an *employee* row, for the routes that reach people rather than
   * attendance rows: the manual entry and the CSV import. §6 gives a branch manager
   * `update Employee` for their own branch's staff, and both of those write days against a
   * person somebody named.
   */
  private employeeScope(request: object) {
    return scopeWhere(request, {
      branchId: sql`e.branch_id`,
      createdBy: sql`e.created_by`,
      assignedTo: sql`e.user_id`,
    });
  }

  private attendanceScope(request: object) {
    return scopeWhere(request, {
      branchId: sql`a.branch_id`,
      createdBy: sql`a.recorded_by`,
      // §6 gives sales, marketing and warehouse `read Employee` at `own` scope, and
      // the attendance routes are guarded by that ability — so `own` here has to mean
      // "my own days", which is the employee row linked to my login.
      assignedTo: sql`(select e.user_id from hr.employees e
                       where e.org_id = a.org_id and e.id = a.employee_id)`,
    });
  }

  async list(
    context: ActiveContext,
    request: object,
    query: AttendanceQuery,
  ): Promise<{ items: AttendanceDayView[] }> {
    const scope = this.attendanceScope(request);
    const month = toPayrollMonth(query.month);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listAttendance(tx, context.orgId, {
        scope,
        from: `${month}-01`,
        to: `${month}-${String(daysInMonth(month)).padStart(2, '0')}`,
        employeeId: query.employeeId,
        branchId: query.branchId,
      });
      return { items: rows.map(view) };
    });
  }

  /**
   * Record or correct days by hand.
   *
   * Every entry is an upsert, so recording the same day twice corrects it rather than
   * failing — which is what the person doing it means. `source` is always `manual`
   * here and migration 0055 refuses a correction that says otherwise, so a month of
   * absences typed in the day before payroll can always be told apart from a month the
   * device reported.
   */
  async record(
    context: ActiveContext,
    request: AuditableRequest,
    input: RecordAttendanceInput,
  ): Promise<{ recorded: number }> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const employees = new Map<string, repo.EmployeeRow>();
        for (const entry of input.entries) {
          if (employees.has(entry.employeeId)) continue;
          const employee = await repo.employeeById(tx, context.orgId, entry.employeeId);
          if (employee === undefined) {
            throw new HrError('HR_NOT_FOUND', 'One of those employees is not in this brand.');
          }
          /*
           * A branch manager may only record their own branch's days.
           *
           * Asserted per employee rather than once for the batch, because a batch names many
           * people: checking the first would let the rest through. `assertInScope` answers 404,
           * so an employee outside the caller's branch is indistinguishable from one that does
           * not exist — and it marks the scope as applied, without which `ScopeInterceptor`
           * refuses the response as a 500 (which is the backstop working, not a bug to route
           * around).
           */
          assertInScope(request, {
            branchId: employee.branch_id,
            createdBy: employee.created_by,
            assignedTo: employee.user_id,
          });
          employees.set(entry.employeeId, employee);
        }

        for (const entry of input.entries) {
          const employee = employees.get(entry.employeeId);
          if (employee === undefined) continue;
          /*
           * A day before somebody joined or after they left is refused.
           *
           * Not silently ignored: the proration already treats those days as unpaid
           * (`attendanceSummary`'s employment window), so an accepted row would have
           * no effect and the person who typed it would believe it did. The likely
           * cause is the wrong employee, and saying so is more use than a no-op.
           */
          if (entry.businessDate < employee.join_date) {
            throw new HrError(
              'ATTENDANCE_INVALID',
              `${employee.code} had not joined on ${entry.businessDate}.`,
            );
          }
          if (employee.leave_date !== null && entry.businessDate > employee.leave_date) {
            throw new HrError(
              'ATTENDANCE_INVALID',
              `${employee.code} had left before ${entry.businessDate}.`,
            );
          }

          await repo.upsertAttendance(tx, {
            orgId: context.orgId,
            employeeId: entry.employeeId,
            branchId: employee.branch_id,
            businessDate: entry.businessDate,
            status: entry.status,
            checkInAt: instant(entry.businessDate, entry.checkIn ?? null),
            checkOutAt: instant(entry.businessDate, entry.checkOut ?? null),
            source: 'manual',
            importId: null,
            note: entry.note ?? null,
            recordedBy: context.userId,
          });
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'hr.attendance.recorded',
          entityType: 'Employee',
          // The first employee's id, because the audit row needs one entity and a
          // batch has many. The `after` block carries the whole batch, which is what
          // anybody investigating actually reads.
          entityId: input.entries[0]?.employeeId ?? context.orgId,
          before: null,
          after: {
            entries: input.entries.map((entry) => ({
              employeeId: entry.employeeId,
              businessDate: entry.businessDate,
              status: entry.status,
            })),
          },
          requestId: context.requestId,
          request,
        });

        return { recorded: input.entries.length };
      }),
    );
  }

  /**
   * Parse a device CSV, and apply it only if asked.
   *
   * The import row is written in both cases — a preview is a thing that happened and
   * somebody will want to know that the file was rejected on Tuesday — with
   * `status = 'parsed'` for a dry run and `'applied'` when the rows were written.
   */
  async import(
    context: ActiveContext,
    request: AuditableRequest,
    input: AttendanceImportInput,
  ): Promise<AttendanceImportView> {
    return mapHrErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const month = toPayrollMonth(input.month);
        const review = reviewAttendanceCsv({
          text: input.csv,
          mapping: input.mapping,
          month,
        });

        if (review.missingColumns.length > 0) {
          throw new HrError(
            'ATTENDANCE_IMPORT_REJECTED',
            `That file has no ${review.missingColumns.join(', ')} column. Check the column mapping.`,
          );
        }

        const codes = [...new Set(review.accepted.map((row) => row.employeeCode))];
        // Scoped in SQL: a code outside the caller's branch comes back as unknown, which is
        // the same answer as a code that does not exist (see `employeeIdsByCode`).
        const known = await repo.employeeIdsByCode(
          tx,
          context.orgId,
          codes,
          this.employeeScope(request),
        );
        const byCode = new Map(known.map((row) => [row.code.toUpperCase(), row]));
        const unknownCodes = codes.filter((code) => !byCode.has(code.toUpperCase()));

        const rejected = [
          ...review.rejected,
          // An unknown code is a rejection with a line number, like a bad date: the
          // person fixing it needs to know which row, not just that "some codes were
          // not found".
          ...review.accepted
            .filter((row) => !byCode.has(row.employeeCode.toUpperCase()))
            .map((row) => ({
              line: row.line,
              reason: `No employee with code ${row.employeeCode} in this brand.`,
            })),
        ].sort((a, b) => a.line - b.line);

        const applicable = review.accepted.filter((row) =>
          byCode.has(row.employeeCode.toUpperCase()),
        );

        /*
         * A file with nothing usable in it is refused rather than recorded as applied.
         *
         * `apply: true` on a file whose every row was rejected would otherwise write an
         * `applied` import that changed nothing, and the screen would say the month was
         * imported.
         */
        if (input.apply && applicable.length === 0) {
          throw new HrError(
            'ATTENDANCE_IMPORT_REJECTED',
            'None of the rows in that file could be matched to an employee in this brand.',
          );
        }

        const importId = await repo.insertImport(tx, {
          orgId: context.orgId,
          month,
          fileName: input.fileName ?? null,
          status: input.apply ? 'applied' : 'parsed',
          mapping: input.mapping,
          /*
           * `accepted_count` is how many rows were *understood*, not how many were
           * written — `status` says whether they were written. Counting a preview's
           * accepted rows as zero broke `attendance_imports_counts_add_up`, which is
           * exactly what that CHECK is for: the three numbers have to describe one file.
           */
          rowCount: review.accepted.length + review.rejected.length,
          acceptedCount: applicable.length,
          rejectedCount: rejected.length,
          rejected,
          createdBy: context.userId,
        });

        if (input.apply) {
          for (const row of applicable) {
            const employee = byCode.get(row.employeeCode.toUpperCase());
            if (employee === undefined) continue;
            await repo.upsertAttendance(tx, {
              orgId: context.orgId,
              employeeId: employee.id,
              branchId: employee.branch_id,
              businessDate: row.date,
              status: row.status,
              checkInAt: instant(row.date, row.checkIn),
              checkOutAt: instant(row.date, row.checkOut),
              source: 'csv_import',
              importId,
              note: null,
              recordedBy: context.userId,
            });
          }
        }

        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: input.apply ? 'update' : 'create',
          action: input.apply ? 'hr.attendance.imported' : 'hr.attendance.import_previewed',
          entityType: 'Payroll',
          entityId: importId,
          before: null,
          after: {
            month,
            fileName: input.fileName ?? null,
            // The mapping, not the file. The CSV is attendance for every employee by
            // name — personal data that has no business in an append-only log
            // (invariant 10).
            mapping: input.mapping,
            accepted: applicable.length,
            rejected: rejected.length,
            applied: input.apply,
          },
          requestId: context.requestId,
          request,
        });

        return {
          id: importId,
          month,
          status: input.apply ? 'applied' : 'parsed',
          rowCount: review.accepted.length + review.rejected.length,
          acceptedCount: applicable.length,
          rejectedCount: rejected.length,
          rejected,
          missingColumns: [],
          unknownCodes,
        };
      }),
    );
  }

  async imports(context: ActiveContext, month?: string): Promise<{ items: unknown[] }> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.listImports(tx, context.orgId, month)).map((row) => ({
        id: row.id,
        month: row.month,
        fileName: row.file_name,
        status: row.status,
        rowCount: row.row_count,
        acceptedCount: row.accepted_count,
        rejectedCount: row.rejected_count,
        rejected: row.rejected,
        createdBy: row.created_by,
        createdAt: row.created_at,
      })),
    }));
  }

  /**
   * The month's attendance summary for a set of employees, for the payroll run.
   *
   * Reads the calendar once per distinct calendar rather than once per employee: a
   * hundred-person org on one calendar would otherwise make a hundred identical
   * holiday queries inside the transaction that submits payroll.
   */
  async summariesFor(
    tx: Tx,
    orgId: string,
    input: {
      readonly month: PayrollMonth;
      readonly employees: readonly repo.EmployeeRow[];
      readonly unrecorded: UnrecordedPolicy;
    },
  ): Promise<Map<string, AttendanceSummary>> {
    const { month, employees } = input;
    const from = `${month}-01`;
    const to = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;

    // Creates `STD` if this brand has none: migration 0057 backfills the orgs that existed
    // when M19 shipped, and a brand added afterwards would otherwise be unpayable.
    const fallback = await repo.ensureDefaultCalendar(tx, orgId);
    const calendarIds = new Set<string>();
    for (const employee of employees) {
      calendarIds.add(employee.calendar_id ?? fallback.id);
    }

    const calendars = new Map<string, WorkCalendar>();
    for (const id of calendarIds) {
      const row = await repo.calendarById(tx, orgId, id);
      if (row === undefined) continue;
      const holidays = await repo.holidaysBetween(tx, orgId, id, from, to);
      calendars.set(id, {
        weeklyOff: row.weekly_off,
        holidays: holidays.map((date) => toIsoDate(date)),
      });
    }

    const attendance = await repo.listAttendance(tx, orgId, {
      // The payroll run is org-wide by design (§12, one run per org per month), so it
      // reads every employee's attendance. The route that reaches this needs
      // `create Payroll`, which §6 gives hr and org_admin at org scope only.
      scope: sql`true`,
      from,
      to,
    });
    const byEmployee = new Map<string, { date: IsoDate; status: AttendanceStatus }[]>();
    for (const row of attendance) {
      const list = byEmployee.get(row.employee_id) ?? [];
      list.push({ date: toIsoDate(row.business_date), status: row.status as AttendanceStatus });
      byEmployee.set(row.employee_id, list);
    }

    const summaries = new Map<string, AttendanceSummary>();
    for (const employee of employees) {
      const calendar = calendars.get(employee.calendar_id ?? fallback.id);
      if (calendar === undefined) {
        /*
         * No calendar at all is refused, not defaulted.
         *
         * Migration 0057 gives every org a default one, so this only happens if
         * somebody deactivated it. Falling back to "every day is a working day" would
         * divide a monthly salary across 31 days instead of 27 and dock a fifth more
         * per absence — a wrong answer that looks like a right one.
         */
        throw new HrError(
          'HR_NOT_FOUND',
          `${employee.code} has no working-day calendar, and this brand has no active default one.`,
        );
      }
      summaries.set(
        employee.id,
        attendanceSummary({
          month,
          calendar,
          records: byEmployee.get(employee.id) ?? [],
          joinedOn: toIsoDate(employee.join_date),
          leftOn: employee.leave_date === null ? null : toIsoDate(employee.leave_date),
          unrecorded: input.unrecorded,
        }),
      );
    }
    return summaries;
  }
}

/**
 * `09:05` on an Asia/Dhaka date, as an instant.
 *
 * The offset is written out rather than relying on the process timezone: a server in
 * UTC parsing `2026-03-01T09:05` would store 09:05 UTC, which is 15:05 in Dhaka, and
 * every check-in would be six hours late. Bangladesh has had no daylight saving since
 * the 2009 experiment, so a fixed `+06:00` is correct rather than convenient — and if
 * that ever changes, this one function is where it changes.
 */
function instant(businessDate: string, time: string | null): Date | null {
  if (time === null) return null;
  return new Date(`${businessDate}T${time}:00${DHAKA_OFFSET}`);
}

function view(row: repo.AttendanceRow): AttendanceDayView {
  return {
    id: row.id,
    employeeId: row.employee_id,
    branchId: row.branch_id,
    businessDate: row.business_date,
    status: row.status,
    checkInAt: row.check_in_at === null ? null : row.check_in_at.toISOString(),
    checkOutAt: row.check_out_at === null ? null : row.check_out_at.toISOString(),
    source: row.source,
    note: row.note,
  };
}
