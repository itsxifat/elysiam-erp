import { Button, Money, PermissionGate, StatusBadge } from '@elysium/ui';
import { useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { takaToPoisha } from '@elysium/ui';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import {
  addRunInput,
  cancelRun,
  getRun,
  listEmployees,
  listPayslips,
  listRunInputs,
  listWallets,
  payRun,
  payslipPdfUrl,
  previewRun,
  removeRunInput,
  submitRun,
  type Payslip,
} from './api.js';
import { control, Field, HrNav, numericControl, RUN_TONE } from './hr-nav.js';
import { useHrT, type HrMessageKey } from './messages.js';

/**
 * One payroll run: what it will pay, who agreed to it, and what it did (§12, §7).
 *
 * ## What the buttons are, and what is deliberately absent
 *
 * A draft gets **bonuses** and **send for approval**. A run waiting for a checker gets
 * nothing but a message saying so — the decision happens in the approvals inbox, by somebody
 * else, and offering an approve button here would be offering the maker their own signature.
 * A posted run gets **pay**. There is no post button at all, for anybody: the journal is
 * written by the transaction that approves the request (§7, D-072).
 *
 * ## The preview versus the payslips
 *
 * While the run is a draft, the table is a **preview** — recomputed from today's attendance
 * every time it is opened, which is the point, because attendance is still being imported.
 * Once it has been submitted, the table is the **frozen payslips**, and they cannot change.
 * The heading is the same either way, and the status badge at the top is what tells the user
 * which one they are looking at; the numbers themselves come from two different endpoints so
 * they cannot be confused in the code.
 *
 * The payslip PDF link only appears once the run is approved, because a payslip for a run
 * nobody has agreed to is a document telling an employee what they are *going* to be paid.
 */
export function PayrollRunPage() {
  const t = useHrT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  /*
   * `strict: false` for the same reason `hrPath` exists: the route is not in the tree until
   * the integrator registers it, so a typed `from` would not compile and the loose read comes
   * back as an unusable inferred type. The narrowing goes away with the same commit.
   *
   * The empty fallback is never hit in practice — the route only matches with a param — and
   * `getRun('')` answers a 400 rather than fetching somebody else's run if it ever is.
   */
  const params = useParams({ strict: false }) as unknown as { runId?: string };
  const runId = params.runId ?? '';

  const mayRead = ability.can('read', 'Payroll');
  const mayPrepare = ability.can('create', 'Payroll');
  const mayPay = ability.can('update', 'Payroll');

  const run = useQuery({
    queryKey: ['hr', 'run', runId],
    queryFn: () => getRun(runId),
    enabled: mayRead,
  });

  const status = run.data?.status;
  const isDraft = status === 'draft';
  const isApproved = status === 'posted' || status === 'paid';

  const preview = useQuery({
    queryKey: ['hr', 'run', runId, 'preview'],
    queryFn: () => previewRun(runId),
    enabled: mayRead && isDraft,
  });

  const payslips = useQuery({
    queryKey: ['hr', 'run', runId, 'payslips'],
    queryFn: () => listPayslips(runId),
    enabled: mayRead && status !== undefined && status !== 'draft',
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['hr'] });

  const submit = useMutation({ mutationFn: () => submitRun(runId), onSuccess: invalidate });
  const close = useMutation({ mutationFn: () => cancelRun(runId), onSuccess: invalidate });

  const rows: readonly Payslip[] = isDraft
    ? (preview.data?.payslips ?? [])
    : (payslips.data?.items ?? []);

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('hr.deniedTitle'), detail: t('hr.deniedDetail') }}
    >
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">
            {t('hr.runDetail')} — <span className="tabular-nums">{run.data?.month ?? ''}</span>
          </h1>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            {status === undefined ? null : (
              <StatusBadge tone={RUN_TONE[status] ?? 'neutral'}>
                {t(`hr.run.${status}` as HrMessageKey)}
              </StatusBadge>
            )}
            <span>
              {t('hr.unrecordedPolicy')}:{' '}
              {t(
                run.data?.unrecordedPolicy === 'absent'
                  ? 'hr.unrecorded.absent'
                  : 'hr.unrecorded.present',
              )}
            </span>
          </div>
        </header>

        <HrNav />

        <section
          aria-label={t('hr.totals')}
          className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-4"
        >
          <Metric label={t('hr.colStaff')} value={String(run.data?.employeeCount ?? 0)} />
          <MoneyMetric label={t('hr.colGross')} poisha={run.data?.grossPoisha} />
          <MoneyMetric label={t('hr.colDeductions')} poisha={run.data?.deductionsPoisha} />
          <MoneyMetric label={t('hr.colNet')} poisha={run.data?.netPoisha} emphasis />
        </section>

        {/* The warnings are the three ways a run is quietly wrong that the totals hide. */}
        {isDraft && (preview.data?.warnings.length ?? 0) > 0 ? (
          <section
            aria-label={t('hr.warnings')}
            className="rounded-lg border border-warning/30 bg-warning-subtle p-4 text-sm text-warning-subtle-foreground"
          >
            <h2 className="mb-1 font-medium">{t('hr.warnings')}</h2>
            <ul className="list-inside list-disc space-y-0.5">
              {(preview.data?.warnings ?? []).map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </section>
        ) : null}

        {isDraft ? (
          <PermissionGate allowed={mayPrepare}>
            <BonusPanel runId={runId} onChanged={invalidate} />
            <div className="flex flex-wrap items-center gap-3">
              <Button size="sm" disabled={submit.isPending} onClick={() => submit.mutate()}>
                {t('hr.submitRun')}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                disabled={close.isPending}
                onClick={() => close.mutate()}
              >
                {t('hr.cancelRun')}
              </Button>
              {submit.error === null ? null : (
                <p role="alert" className="text-sm text-destructive">
                  {submit.error instanceof ApiError ? submit.error.message : t('hr.saveFailed')}
                </p>
              )}
            </div>
          </PermissionGate>
        ) : null}

        {status === 'pending_approval' ? (
          <div className="flex flex-wrap items-center gap-3">
            <p role="status" className="text-sm text-muted-foreground">
              {t('hr.submittedHint')}
            </p>
            {/* Closable only once the checker has rejected it — the server refuses while the
                request is still pending, so the button is offered and the refusal explains. */}
            <PermissionGate allowed={mayPrepare}>
              <Button
                size="sm"
                variant="secondary"
                disabled={close.isPending}
                onClick={() => close.mutate()}
              >
                {t('hr.cancelRun')}
              </Button>
            </PermissionGate>
            {close.error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {close.error instanceof ApiError ? close.error.message : t('hr.saveFailed')}
              </p>
            )}
          </div>
        ) : null}

        {status === 'posted' ? (
          <PermissionGate allowed={mayPay}>
            <PayPanel runId={runId} onPaid={invalidate} />
          </PermissionGate>
        ) : null}

        {status === 'paid' ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('hr.paidHint')} <span className="tabular-nums">{run.data?.paidOn ?? ''}</span>
          </p>
        ) : null}

        <section aria-label={t('hr.payslips')} className="space-y-2">
          <h2 className="text-sm font-semibold">{t('hr.payslips')}</h2>
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {isDraft ? t('hr.emptyTitle') : t('hr.payslipsAfterApproval')}
            </p>
          ) : (
            <table className="w-full text-sm">
              <caption className="sr-only">{t('hr.payslips')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {t('hr.employee')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colBasic')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colAllowances')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colBonus')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colAbsence')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colLoan')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colNet')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colPresent')}
                  </th>
                  <th scope="col" className="py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((payslip) => (
                  <tr key={payslip.employeeId} className="h-9 border-b border-border/60">
                    <td className="py-2">
                      <span className="text-muted-foreground tabular-nums">
                        {payslip.employeeCode}
                      </span>{' '}
                      {payslip.employeeName}
                    </td>
                    <td className="py-2 text-right">
                      <Money poisha={payslip.basicPoisha} symbol={false} />
                    </td>
                    <td className="py-2 text-right">
                      <Money poisha={payslip.allowancesPoisha} symbol={false} />
                    </td>
                    <td className="py-2 text-right">
                      <Money poisha={payslip.bonusPoisha} symbol={false} />
                    </td>
                    <td className="py-2 text-right">
                      <Money poisha={payslip.absenceDeductionPoisha} symbol={false} />
                    </td>
                    <td className="py-2 text-right">
                      <Money poisha={payslip.loanDeductionPoisha} symbol={false} />
                    </td>
                    <td className="py-2 text-right font-medium">
                      <Money poisha={payslip.netPoisha} symbol={false} />
                    </td>
                    <td className="py-2 text-right tabular-nums">
                      {payslip.presentDays}/{payslip.workingDays}
                    </td>
                    <td className="py-2 text-right">
                      {isApproved ? (
                        <a
                          href={payslipPdfUrl(runId, payslip.employeeId)}
                          className="rounded-md px-2 py-1 text-sm text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                        >
                          {t('hr.downloadPayslip')}
                        </a>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </PermissionGate>
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-base font-medium tabular-nums">{value}</p>
    </div>
  );
}

function MoneyMetric({
  label,
  poisha,
  emphasis,
}: {
  readonly label: string;
  readonly poisha: string | undefined;
  readonly emphasis?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`text-base tabular-nums ${emphasis === true ? 'font-semibold' : 'font-medium'}`}
      >
        <Money poisha={poisha ?? '0'} />
      </p>
    </div>
  );
}

function BonusPanel({
  runId,
  onChanged,
}: {
  readonly runId: string;
  readonly onChanged: () => void;
}) {
  const t = useHrT();
  const [employeeId, setEmployeeId] = useState('');
  const [kind, setKind] = useState<'bonus' | 'deduction'>('bonus');
  const [label, setLabel] = useState('');
  const [amount, setAmount] = useState('');

  const inputs = useQuery({
    queryKey: ['hr', 'run', runId, 'inputs'],
    queryFn: () => listRunInputs(runId),
  });
  const employees = useQuery({
    queryKey: ['hr', 'employees', 'for-bonus'],
    queryFn: () => listEmployees({ status: 'active', pageSize: 200 }),
    staleTime: 5 * 60_000,
  });
  const byId = new Map((employees.data?.items ?? []).map((one) => [one.id, one]));

  const add = useMutation({
    mutationFn: () => {
      const amountPoisha = takaToPoisha(amount);
      if (amountPoisha === null) throw new ApiError(400, null, t('hr.saveFailed'));
      return addRunInput(runId, { employeeId, kind, label: label.trim(), amountPoisha });
    },
    onSuccess: () => {
      setLabel('');
      setAmount('');
      void inputs.refetch();
      onChanged();
    },
  });

  const remove = useMutation({
    mutationFn: (inputId: string) => removeRunInput(runId, inputId),
    onSuccess: () => {
      void inputs.refetch();
      onChanged();
    },
  });

  return (
    <section
      aria-label={t('hr.bonuses')}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="text-sm font-semibold">{t('hr.bonuses')}</h2>

      {(inputs.data?.items ?? []).length === 0 ? null : (
        <table className="w-full text-sm">
          <caption className="sr-only">{t('hr.bonuses')}</caption>
          <tbody>
            {(inputs.data?.items ?? []).map((input) => (
              <tr key={input.id} className="h-9 border-b border-border/60">
                <td className="py-2">
                  {byId.get(input.employeeId)?.fullName ?? input.employeeId.slice(0, 8)}
                </td>
                <td className="py-2">{t(`hr.kind.${input.kind}` as HrMessageKey)}</td>
                <td className="py-2 text-muted-foreground">{input.label}</td>
                <td className="py-2 text-right">
                  <Money poisha={input.amountPoisha} />
                </td>
                <td className="py-2 text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(input.id)}
                  >
                    {t('hr.remove')}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form
        className="grid gap-3 sm:grid-cols-5"
        onSubmit={(event) => {
          event.preventDefault();
          add.mutate();
        }}
      >
        <Field label={t('hr.employee')} id="bonus-employee">
          <select
            id="bonus-employee"
            value={employeeId}
            required
            className={control}
            onChange={(event) => setEmployeeId(event.target.value)}
          >
            <option value="">{t('hr.employee')}</option>
            {(employees.data?.items ?? []).map((employee) => (
              <option key={employee.id} value={employee.id}>
                {employee.code} · {employee.fullName}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('hr.field.kind')} id="bonus-kind">
          <select
            id="bonus-kind"
            value={kind}
            className={control}
            onChange={(event) =>
              setKind(event.target.value === 'deduction' ? 'deduction' : 'bonus')
            }
          >
            <option value="bonus">{t('hr.kind.bonus')}</option>
            <option value="deduction">{t('hr.kind.deduction')}</option>
          </select>
        </Field>
        <Field label={t('hr.field.label')} id="bonus-label">
          <input
            id="bonus-label"
            value={label}
            required
            maxLength={60}
            className={control}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        <Field label={t('hr.colAmount')} id="bonus-amount">
          <input
            id="bonus-amount"
            value={amount}
            required
            inputMode="decimal"
            className={numericControl}
            onChange={(event) => setAmount(event.target.value)}
          />
        </Field>
        <div className="flex items-end">
          <Button
            type="submit"
            size="sm"
            disabled={
              employeeId === '' || label.trim() === '' || amount.trim() === '' || add.isPending
            }
          >
            {t('hr.addBonus')}
          </Button>
        </div>
        {add.error === null ? null : (
          <p role="alert" className="text-sm text-destructive sm:col-span-5">
            {add.error instanceof ApiError ? add.error.message : t('hr.saveFailed')}
          </p>
        )}
      </form>
    </section>
  );
}

function PayPanel({ runId, onPaid }: { readonly runId: string; readonly onPaid: () => void }) {
  const t = useHrT();
  const [walletAccountId, setWalletAccountId] = useState('');

  const wallets = useQuery({
    queryKey: ['hr', 'wallets'],
    queryFn: listWallets,
    staleTime: 5 * 60_000,
  });

  const pay = useMutation({
    mutationFn: () => payRun(runId, { walletAccountId }),
    onSuccess: onPaid,
  });

  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        pay.mutate();
      }}
    >
      <Field label={t('hr.field.wallet')} id="pay-wallet">
        <select
          id="pay-wallet"
          value={walletAccountId}
          required
          className={`${control} sm:w-72`}
          onChange={(event) => setWalletAccountId(event.target.value)}
        >
          <option value="">{t('hr.field.wallet')}</option>
          {(wallets.data?.items ?? []).map((wallet) => (
            <option key={wallet.accountId} value={wallet.accountId}>
              {wallet.name}
            </option>
          ))}
        </select>
      </Field>
      {/* No amount field: the run pays exactly what was approved and posted (D-078). */}
      <Button type="submit" size="sm" disabled={walletAccountId === '' || pay.isPending}>
        {t('hr.payRun')}
      </Button>
      {pay.error === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {pay.error instanceof ApiError ? pay.error.message : t('hr.saveFailed')}
        </p>
      )}
    </form>
  );
}
