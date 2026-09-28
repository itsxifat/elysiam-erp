import { Button, EmptyState, Money, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { takaToPoisha } from '@elysium/ui';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import {
  createLoan,
  disburseLoan,
  listEmployees,
  listLoans,
  listWallets,
  type LoanStatus,
} from './api.js';
import { control, Field, HrNav, numericControl } from './hr-nav.js';
import { useHrT, type HrMessageKey } from './messages.js';

/**
 * Staff loans and their schedules (§12, §7).
 *
 * Two facts the screen has to make obvious, because getting either wrong costs an employee
 * money.
 *
 * **A loan that has not been paid out deducts nothing.** `pending_disbursement` is a real
 * state — the agreement is signed on Monday and accounts pays on Thursday — and its badge is
 * deliberately not a success colour. An instalment taken from a payslip for money the
 * employee never received is a wage cut dressed as a repayment.
 *
 * **The instalments are not typed.** There is no instalment-amount field: the amount is the
 * principal split by largest remainder so the parts sum to it exactly. ৳25,000 over six
 * months is 416,666.66… poisha an instalment, and six rounded instalments leave the loan
 * either four poisha short forever or two poisha over — which is why the form asks for a
 * count and not an amount.
 */

const LOAN_TONE: Readonly<Record<LoanStatus, 'neutral' | 'warning' | 'info' | 'success'>> = {
  pending_disbursement: 'warning',
  active: 'info',
  settled: 'success',
  written_off: 'neutral',
};

/** This month in Asia/Dhaka, as `YYYY-MM`. */
function currentMonth(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);
}

export function LoansPage() {
  const t = useHrT();
  const ability = useAbility();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Payroll');
  const mayCreate = ability.can('create', 'Payroll');
  const mayDisburse = ability.can('update', 'Payroll');

  const [expanded, setExpanded] = useState<string | null>(null);

  const loans = useQuery({
    queryKey: ['hr', 'loans'],
    queryFn: () => listLoans(),
    enabled: mayRead,
  });
  const employees = useQuery({
    queryKey: ['hr', 'employees', 'for-loans'],
    queryFn: () => listEmployees({ status: 'active', pageSize: 200 }),
    enabled: mayRead,
    staleTime: 5 * 60_000,
  });
  const wallets = useQuery({
    queryKey: ['hr', 'wallets'],
    queryFn: listWallets,
    enabled: mayDisburse,
    staleTime: 5 * 60_000,
  });

  const byId = new Map((employees.data?.items ?? []).map((one) => [one.id, one]));
  const items = loans.data?.items ?? [];
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['hr'] });

  const disburse = useMutation({
    mutationFn: (input: { loanId: string; walletAccountId: string }) =>
      disburseLoan(input.loanId, { walletAccountId: input.walletAccountId }),
    onSuccess: invalidate,
  });

  const [wallet, setWallet] = useState('');

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('hr.deniedTitle'), detail: t('hr.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{t('hr.loans')}</h1>
          <p className="text-sm text-muted-foreground">{t('hr.loansHint')}</p>
        </header>

        <HrNav />

        <PermissionGate allowed={mayCreate}>
          <NewLoanForm employees={employees.data?.items ?? []} onCreated={invalidate} />
        </PermissionGate>

        <PermissionGate allowed={mayDisburse}>
          <Field label={t('hr.field.wallet')} id="loan-wallet">
            <select
              id="loan-wallet"
              value={wallet}
              className={`${control} sm:w-72`}
              onChange={(event) => setWallet(event.target.value)}
            >
              <option value="">{t('hr.field.wallet')}</option>
              {(wallets.data?.items ?? []).map((one) => (
                <option key={one.accountId} value={one.accountId}>
                  {one.name}
                </option>
              ))}
            </select>
          </Field>
        </PermissionGate>

        {items.length === 0 && !loans.isLoading ? (
          <EmptyState title={t('hr.emptyTitle')} detail={t('hr.emptyLoans')} />
        ) : (
          <section aria-label={t('hr.loans')} className="space-y-2">
            <table className="w-full text-sm">
              <caption className="sr-only">{t('hr.loans')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {t('hr.employee')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colPrincipal')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colInstalments')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.field.firstMonth')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {t('hr.colOutstanding')}
                  </th>
                  <th scope="col" className="py-2">
                    {t('hr.colStatus')}
                  </th>
                  <th scope="col" className="py-2" />
                </tr>
              </thead>
              <tbody>
                {items.map((loan) => (
                  <tr key={loan.id} className="h-9 border-b border-border/60">
                    <td className="py-2">
                      {byId.get(loan.employeeId)?.fullName ?? loan.employeeId.slice(0, 8)}
                    </td>
                    <td className="py-2 text-right">
                      <Money poisha={loan.principalPoisha} />
                    </td>
                    <td className="py-2 text-right tabular-nums">{loan.instalmentCount}</td>
                    <td className="py-2 tabular-nums">{loan.firstMonth}</td>
                    <td className="py-2 text-right font-medium">
                      <Money poisha={loan.outstandingPoisha} />
                    </td>
                    <td className="py-2">
                      <StatusBadge tone={LOAN_TONE[loan.status]}>
                        {t(`hr.loan.${loan.status}` as HrMessageKey)}
                      </StatusBadge>
                    </td>
                    <td className="py-2 text-right">
                      {loan.status === 'pending_disbursement' && mayDisburse ? (
                        <Button
                          size="sm"
                          disabled={wallet === '' || disburse.isPending}
                          onClick={() =>
                            disburse.mutate({ loanId: loan.id, walletAccountId: wallet })
                          }
                        >
                          {t('hr.disburse')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setExpanded(expanded === loan.id ? null : loan.id)}
                        >
                          {t('hr.colInstalments')}
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {disburse.error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {disburse.error instanceof ApiError ? disburse.error.message : t('hr.saveFailed')}
              </p>
            )}

            {expanded === null ? null : (
              <Schedule instalments={items.find((one) => one.id === expanded)?.instalments ?? []} />
            )}
          </section>
        )}
      </div>
    </PermissionGate>
  );
}

function Schedule({
  instalments,
}: {
  readonly instalments: readonly {
    id: string;
    seq: number;
    dueMonth: string;
    amountPoisha: string;
    deductedPoisha: string;
    status: string;
  }[];
}) {
  const t = useHrT();
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{t('hr.colInstalments')}</caption>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th scope="col" className="py-2">
            #
          </th>
          <th scope="col" className="py-2">
            {t('hr.colMonth')}
          </th>
          <th scope="col" className="py-2 text-right">
            {t('hr.colDue')}
          </th>
          <th scope="col" className="py-2 text-right">
            {t('hr.colDeducted')}
          </th>
          <th scope="col" className="py-2">
            {t('hr.colStatus')}
          </th>
        </tr>
      </thead>
      <tbody>
        {instalments.map((instalment) => (
          <tr key={instalment.id} className="h-9 border-b border-border/60">
            <td className="py-2 tabular-nums">{instalment.seq}</td>
            <td className="py-2 tabular-nums">{instalment.dueMonth}</td>
            <td className="py-2 text-right">
              <Money poisha={instalment.amountPoisha} symbol={false} />
            </td>
            <td className="py-2 text-right">
              <Money poisha={instalment.deductedPoisha} symbol={false} />
            </td>
            <td className="py-2 text-muted-foreground">
              {t(`hr.instalment.${instalment.status}` as HrMessageKey)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NewLoanForm({
  employees,
  onCreated,
}: {
  readonly employees: readonly { id: string; code: string; fullName: string }[];
  readonly onCreated: () => void;
}) {
  const t = useHrT();
  const [employeeId, setEmployeeId] = useState('');
  const [principal, setPrincipal] = useState('');
  const [instalments, setInstalments] = useState('3');
  const [firstMonth, setFirstMonth] = useState(currentMonth());
  const [note, setNote] = useState('');

  const create = useMutation({
    mutationFn: () => {
      const principalPoisha = takaToPoisha(principal);
      if (principalPoisha === null) throw new ApiError(400, null, t('hr.saveFailed'));
      return createLoan({
        employeeId,
        principalPoisha,
        instalmentCount: Number(instalments),
        firstMonth,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      });
    },
    onSuccess: () => {
      setPrincipal('');
      setNote('');
      onCreated();
    },
  });

  return (
    <form
      className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-5"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <Field label={t('hr.employee')} id="loan-employee">
        <select
          id="loan-employee"
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
      <Field label={t('hr.field.principal')} id="loan-principal">
        <input
          id="loan-principal"
          value={principal}
          required
          inputMode="decimal"
          className={numericControl}
          onChange={(event) => setPrincipal(event.target.value)}
        />
      </Field>
      {/* A count, not an amount: the split is the server's, so the instalments sum to the
          principal exactly. */}
      <Field label={t('hr.field.instalments')} id="loan-instalments">
        <input
          id="loan-instalments"
          type="number"
          min={1}
          max={120}
          step={1}
          value={instalments}
          required
          className={numericControl}
          onChange={(event) => setInstalments(event.target.value)}
        />
      </Field>
      <Field label={t('hr.field.firstMonth')} id="loan-first-month">
        <input
          id="loan-first-month"
          type="month"
          value={firstMonth}
          required
          className={control}
          onChange={(event) => setFirstMonth(event.target.value)}
        />
      </Field>
      <Field label={t('hr.field.note')} id="loan-note">
        <input
          id="loan-note"
          value={note}
          maxLength={500}
          className={control}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      <div className="flex items-end gap-3 sm:col-span-5">
        <Button
          type="submit"
          size="sm"
          disabled={
            employeeId === '' ||
            principal.trim() === '' ||
            Number(instalments) < 1 ||
            create.isPending
          }
        >
          {t('hr.newLoan')}
        </Button>
        {create.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {create.error instanceof ApiError ? create.error.message : t('hr.saveFailed')}
          </p>
        )}
      </div>
    </form>
  );
}
