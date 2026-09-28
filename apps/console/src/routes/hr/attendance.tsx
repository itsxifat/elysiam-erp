import { Button, EmptyState, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import {
  importAttendance,
  listAttendance,
  listEmployees,
  recordAttendance,
  type AttendanceImportResult,
  type AttendanceStatus,
} from './api.js';
import { control, Field, HrNav } from './hr-nav.js';
import { useHrT, type HrMessageKey } from './messages.js';

/**
 * Attendance: one day at a time, or a whole month from the biometric export (§12, §21).
 *
 * ## The import previews first, and the screen makes that obvious
 *
 * Two buttons, not one: **check the file** and **apply to the month**. The first is the
 * default and the second only appears once the check came back, because a wrong column
 * mapping — the date column pointed at the employee-number column, which is the easy mistake
 * — would otherwise mark a month of absences on the first click. An absence costs somebody
 * money, and that asymmetry is why this is the one screen in the console that makes you look
 * before you commit.
 *
 * The rejected rows are shown with their **line numbers as Excel shows them**, because "142
 * of 148 rows imported" is not a useful thing to tell an office administrator: which six,
 * and why, is.
 *
 * ## Why the CSV is pasted rather than uploaded
 *
 * A device export is tens of kilobytes of ASCII. Routing it through M04's upload tickets
 * would put a file whose entire content is personal data — every employee's movements, by
 * name — in the private bucket forever, to read it once (invariant 10). What is worth keeping
 * is the parsed rows, and those go into `hr.attendance_days`.
 */

const STATUSES: readonly AttendanceStatus[] = [
  'present',
  'late',
  'half_day',
  'absent',
  'leave_unpaid',
  'leave_paid',
  'weekly_off',
  'holiday',
];

const ABSENT_TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  present: 'success',
  late: 'warning',
  half_day: 'warning',
  absent: 'danger',
  leave_unpaid: 'danger',
  leave_paid: 'neutral',
  weekly_off: 'neutral',
  holiday: 'neutral',
};

/** This month in Asia/Dhaka, as `YYYY-MM`. The console shows Dhaka dates (§24). */
function currentMonth(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
  }).format(new Date());
  return parts.slice(0, 7);
}

export function AttendancePage() {
  const t = useHrT();
  const ability = useAbility();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Employee');
  const mayRecord = ability.can('update', 'Employee');

  const [month, setMonth] = useState(currentMonth());

  const days = useQuery({
    queryKey: ['hr', 'attendance', month],
    queryFn: () => listAttendance({ month }),
    enabled: mayRead && /^\d{4}-\d{2}$/.test(month),
  });

  const employees = useQuery({
    queryKey: ['hr', 'employees', 'for-attendance'],
    queryFn: () => listEmployees({ status: 'active', pageSize: 200 }),
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });

  const byId = new Map((employees.data?.items ?? []).map((one) => [one.id, one]));
  const items = days.data?.items ?? [];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('hr.deniedTitle'), detail: t('hr.deniedPeople') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{t('hr.attendance')}</h1>
          <p className="text-sm text-muted-foreground">{t('hr.attendanceHint')}</p>
        </header>

        <HrNav />

        <Field label={t('hr.month')} id="attendance-month">
          <input
            id="attendance-month"
            type="month"
            value={month}
            className={`${control} sm:w-48`}
            onChange={(event) => setMonth(event.target.value)}
          />
        </Field>

        <PermissionGate allowed={mayRecord}>
          <ManualEntry
            month={month}
            employees={employees.data?.items ?? []}
            onSaved={() => void queryClient.invalidateQueries({ queryKey: ['hr', 'attendance'] })}
          />
          <ImportForm
            month={month}
            onApplied={() => void queryClient.invalidateQueries({ queryKey: ['hr', 'attendance'] })}
          />
        </PermissionGate>

        {items.length === 0 && !days.isLoading ? (
          <EmptyState title={t('hr.emptyTitle')} detail={t('hr.attendanceHint')} />
        ) : (
          <section aria-label={t('hr.attendance')}>
            <table className="w-full text-sm">
              <caption className="sr-only">{t('hr.attendance')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {t('hr.colDate')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.employee')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.colAttendance')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.colSource')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((day) => (
                  <tr key={day.id} className="h-9 border-b border-border/60">
                    <td className="py-2 tabular-nums">{day.businessDate}</td>
                    <td className="py-2">
                      {byId.get(day.employeeId)?.fullName ?? day.employeeId.slice(0, 8)}
                    </td>
                    <td className="py-2">
                      <StatusBadge tone={ABSENT_TONE[day.status] ?? 'neutral'}>
                        {t(`hr.attend.${day.status}` as HrMessageKey)}
                      </StatusBadge>
                    </td>
                    {/* `source` is the only evidence that a month of absences was typed in
                        the day before payroll rather than reported by the device. */}
                    <td className="py-2 text-muted-foreground">
                      {t(`hr.source.${day.source}` as HrMessageKey)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </PermissionGate>
  );
}

function ManualEntry({
  month,
  employees,
  onSaved,
}: {
  readonly month: string;
  readonly employees: readonly { id: string; code: string; fullName: string }[];
  readonly onSaved: () => void;
}) {
  const t = useHrT();
  const [employeeId, setEmployeeId] = useState('');
  const [date, setDate] = useState('');
  const [status, setStatus] = useState<AttendanceStatus>('absent');

  const save = useMutation({
    mutationFn: () => recordAttendance([{ employeeId, businessDate: date, status }]),
    onSuccess: () => {
      setDate('');
      onSaved();
    },
  });

  return (
    <form
      className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-4"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate();
      }}
    >
      <Field label={t('hr.employee')} id="attendance-employee">
        <select
          id="attendance-employee"
          value={employeeId}
          required
          className={control}
          onChange={(event) => setEmployeeId(event.target.value)}
        >
          <option value="">{t('hr.employee')}</option>
          {employees.map((employee) => (
            <option key={employee.id} value={employee.id}>
              {employee.code} · {employee.fullName}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('hr.colDate')} id="attendance-date">
        <input
          id="attendance-date"
          type="date"
          value={date}
          required
          // Bounded to the month on screen, so a typo cannot land a day in another month
          // that nobody is looking at.
          min={`${month}-01`}
          max={`${month}-31`}
          className={control}
          onChange={(event) => setDate(event.target.value)}
        />
      </Field>
      <Field label={t('hr.colAttendance')} id="attendance-status">
        <select
          id="attendance-status"
          value={status}
          className={control}
          onChange={(event) => setStatus(event.target.value as AttendanceStatus)}
        >
          {STATUSES.map((one) => (
            <option key={one} value={one}>
              {t(`hr.attend.${one}` as HrMessageKey)}
            </option>
          ))}
        </select>
      </Field>
      <div className="flex items-end gap-3">
        <Button
          type="submit"
          size="sm"
          disabled={employeeId === '' || date === '' || save.isPending}
        >
          {t('hr.recordDay')}
        </Button>
      </div>
      {save.error === null ? null : (
        <p role="alert" className="text-sm text-destructive sm:col-span-4">
          {save.error instanceof ApiError ? save.error.message : t('hr.saveFailed')}
        </p>
      )}
    </form>
  );
}

function ImportForm({
  month,
  onApplied,
}: {
  readonly month: string;
  readonly onApplied: () => void;
}) {
  const t = useHrT();
  const [csv, setCsv] = useState('');
  const [employeeCode, setEmployeeCode] = useState('');
  const [date, setDate] = useState('');
  const [statusColumn, setStatusColumn] = useState('');
  const [result, setResult] = useState<AttendanceImportResult | null>(null);
  const [applied, setApplied] = useState(false);

  const run = useMutation({
    mutationFn: (apply: boolean) =>
      importAttendance({
        month,
        csv,
        mapping: {
          employeeCode,
          date,
          ...(statusColumn.trim() === '' ? {} : { status: statusColumn.trim() }),
        },
        apply,
      }),
    onSuccess: (outcome) => {
      setResult(outcome);
      setApplied(outcome.status === 'applied');
      if (outcome.status === 'applied') onApplied();
    },
  });

  const ready = csv.trim() !== '' && employeeCode.trim() !== '' && date.trim() !== '';

  return (
    <section
      aria-label={t('hr.import')}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <header>
        <h2 className="text-sm font-semibold">{t('hr.import')}</h2>
        <p className="text-xs text-muted-foreground">{t('hr.importHint')}</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label={t('hr.field.mapEmployee')} id="import-map-employee">
          <input
            id="import-map-employee"
            value={employeeCode}
            className={control}
            placeholder="Emp ID"
            onChange={(event) => setEmployeeCode(event.target.value)}
          />
        </Field>
        <Field label={t('hr.field.mapDate')} id="import-map-date">
          <input
            id="import-map-date"
            value={date}
            className={control}
            placeholder="Date"
            onChange={(event) => setDate(event.target.value)}
          />
        </Field>
        <Field label={t('hr.field.mapStatus')} id="import-map-status">
          <input
            id="import-map-status"
            value={statusColumn}
            className={control}
            placeholder="Status"
            onChange={(event) => setStatusColumn(event.target.value)}
          />
        </Field>
      </div>

      <Field label={t('hr.field.csv')} id="import-csv">
        <textarea
          id="import-csv"
          value={csv}
          rows={6}
          className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onChange={(event) => {
            setCsv(event.target.value);
            // A changed file invalidates the check somebody already ran. Keeping the old
            // result on screen beside a new file is how an import gets applied against a
            // preview of something else.
            setResult(null);
            setApplied(false);
          }}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          variant="secondary"
          disabled={!ready || run.isPending}
          onClick={() => run.mutate(false)}
        >
          {t('hr.preview')}
        </Button>
        {/* Only offered once the file has been checked — see the file comment. */}
        {result !== null && !applied && result.acceptedCount > 0 ? (
          <Button size="sm" disabled={run.isPending} onClick={() => run.mutate(true)}>
            {t('hr.apply')}
          </Button>
        ) : null}
        {applied ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('hr.importApplied')}
          </p>
        ) : null}
        {run.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {run.error instanceof ApiError ? run.error.message : t('hr.saveFailed')}
          </p>
        )}
      </div>

      {result === null ? null : (
        <div className="space-y-2 text-sm">
          <p className="tabular-nums">
            <strong>{result.acceptedCount}</strong> {t('hr.importAccepted')} ·{' '}
            <strong>{result.rejectedCount}</strong> {t('hr.importRejected')}
          </p>
          {result.unknownCodes.length === 0 ? null : (
            <p className="text-muted-foreground">
              {t('hr.importUnknown')}: {result.unknownCodes.join(', ')}
            </p>
          )}
          {result.rejected.length === 0 ? null : (
            <table className="w-full text-sm">
              <caption className="sr-only">{t('hr.importRejected')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {t('hr.colLine')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.colReason')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.rejected.map((row) => (
                  <tr
                    key={`${String(row.line)}-${row.reason}`}
                    className="border-b border-border/60"
                  >
                    <td className="py-2 tabular-nums">{row.line}</td>
                    <td className="py-2 text-muted-foreground">{row.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
