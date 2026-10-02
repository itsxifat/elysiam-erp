import { zodResolver } from '@hookform/resolvers/zod';
import {
  Button,
  DataTable,
  Dialog,
  Form,
  Money,
  PermissionGate,
  SelectField,
  StatusBadge,
  TextField,
  dataTableColumns,
  type DataTableColumn,
  type SelectOption,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import { listWallets } from '../accounts/api.js';
import { percentOfBps } from '../investors/share.js';
import {
  getStatement,
  payInstalment,
  voidLoan,
  type StatementInstalment,
  type StatementPayment,
} from './api.js';
import { attemptId, endsAttempt } from './attempt.js';
import { messageOf, METHOD_LABEL, NEXT_STATE, tableLabels } from './loans-page.js';
import { useLoansT, type LoansMessageKey } from './messages.js';

/**
 * A loan's statement (M26): its terms, the schedule with each instalment's state, every
 * repayment split into principal and interest, and the ledger's balance for the lender
 * beside what the schedules say is owed.
 *
 * One pay action, on the one instalment the server says may be paid now
 * (`payable.instalmentId`): instalments are paid whole and in order, and nothing while a
 * repayment waits for a checker. A button on any other row would always answer 409.
 */

const SINGLE_PAGE = { page: 1, pageSize: 500, total: null, hasNext: false } as const;

const voidFormSchema = z.object({ reason: z.string().trim().min(1).max(500) });
type VoidForm = z.infer<typeof voidFormSchema>;

const payFormSchema = z.object({
  walletAccountId: z.string().uuid(),
  memo: z.string().trim().max(500).optional(),
});
type PayForm = z.infer<typeof payFormSchema>;

const PAYMENT_STATUS: Record<
  StatementPayment['status'],
  { key: LoansMessageKey; tone: 'success' | 'warning' | 'neutral' }
> = {
  posted: { key: 'loans.statusPosted', tone: 'success' },
  pending_approval: { key: 'loans.statePending', tone: 'warning' },
  rejected: { key: 'loans.statusRejected', tone: 'neutral' },
};

export function LoanDetailPage() {
  const { loanId } = useParams({ from: '/loans/$loanId' });
  const ability = useAbility();
  const t = useT();
  const l = useLoansT();
  const { locale } = useLocale();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'CompanyLoan');
  const mayPay = ability.can('update', 'CompanyLoan');

  const [paying, setPaying] = useState<StatementInstalment | null>(null);
  /*
   * The payment's id lives as long as the attempt, not the request: a retry after a lost
   * response sends the same id and is answered from the row it wrote, instead of paying
   * again (ledger audit W-C). Another instalment, another wallet or memo, or a success
   * starts a new attempt — as the transfer screen renews its id (accounts/transfers.tsx).
   * Keyed by the values rather than renewed by watching the form: `watch()` cannot be
   * memoised, and the lint says so.
   */
  const attempt = useRef<{ readonly key: string; readonly id: string } | null>(null);
  const [voiding, setVoiding] = useState(false);
  const [notice, setNotice] = useState<LoansMessageKey | null>(null);

  const statementQuery = useQuery({
    queryKey: ['loans', 'statement', loanId],
    queryFn: () => getStatement(loanId),
    enabled: mayRead,
  });
  const walletsQuery = useQuery({
    queryKey: ['loans', 'wallets'],
    queryFn: () => listWallets(),
    enabled: mayPay,
  });

  const payForm = useForm<PayForm>({
    resolver: zodResolver(payFormSchema),
    defaultValues: { memo: '' },
  });

  const voidForm = useForm<VoidForm>({
    resolver: zodResolver(voidFormSchema),
    defaultValues: { reason: '' },
  });

  const voidMutation = useMutation({
    mutationFn: (values: VoidForm) => voidLoan(loanId, values.reason),
    onSuccess: async () => {
      setVoiding(false);
      setNotice('loans.voidedNotice');
      voidForm.reset({ reason: '' });
      await queryClient.invalidateQueries({ queryKey: ['loans'] });
    },
  });

  const payMutation = useMutation({
    mutationFn: (values: PayForm & { instalmentId: string }) =>
      payInstalment(loanId, {
        paymentId: attemptId(attempt, values),
        instalmentId: values.instalmentId,
        walletAccountId: values.walletAccountId,
        ...(values.memo === undefined || values.memo === '' ? {} : { memo: values.memo }),
      }),
    onSuccess: async (result) => {
      setPaying(null);
      attempt.current = null;
      setNotice(result.status === 'posted' ? 'loans.paidNotice' : 'loans.heldNotice');
      payForm.reset({ memo: '' });
      await queryClient.invalidateQueries({ queryKey: ['loans'] });
    },
    onError: (error) => {
      if (endsAttempt(error)) attempt.current = null;
    },
  });

  const statement = statementQuery.data;
  const payableId = statement?.payable.instalmentId ?? null;
  // Not void, nothing repaid or waiting, and not this viewer's own loan (D-304).
  const mayVoid = mayPay && statement?.loan.voidable === true;

  const instalmentColumns = useMemo<readonly DataTableColumn<StatementInstalment>[]>(() => {
    const column = dataTableColumns<StatementInstalment>();
    return column.columns([
      column.accessor('seq', { header: l('loans.colSeq'), meta: { numeric: true } }),
      column.accessor('dueOn', { header: l('loans.colDue') }),
      column.accessor('principalPoisha', {
        header: l('loans.colPrincipal'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('interestPoisha', {
        header: l('loans.colInterest'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('totalPoisha', {
        header: l('loans.colInstalment'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('balanceAfterPoisha', {
        header: l('loans.colBalance'),
        meta: { numeric: true },
        cell: (cell) => (
          <Money poisha={cell.getValue()} locale={locale} className="text-muted-foreground" />
        ),
      }),
      column.accessor('state', {
        header: l('loans.colState'),
        cell: (cell) => {
          const state = NEXT_STATE[cell.getValue()];
          return <StatusBadge tone={state.tone}>{l(state.key)}</StatusBadge>;
        },
      }),
      column.accessor('remindedOn', {
        header: l('loans.remindedOn'),
        cell: (cell) => cell.getValue() ?? '',
      }),
      column.display({
        id: 'actions',
        header: '',
        cell: (cell) => {
          const row = cell.row.original;
          if (!mayPay || row.id !== payableId) return null;
          return (
            <Button
              size="sm"
              onClick={() => {
                setNotice(null);
                setPaying(row);
              }}
            >
              {l('loans.pay')}
            </Button>
          );
        },
      }),
    ]) as readonly DataTableColumn<StatementInstalment>[];
  }, [l, locale, mayPay, payableId]);

  const paymentColumns = useMemo<readonly DataTableColumn<StatementPayment>[]>(() => {
    const column = dataTableColumns<StatementPayment>();
    return column.columns([
      column.accessor('seq', { header: l('loans.colSeq'), meta: { numeric: true } }),
      column.accessor('businessDate', { header: l('loans.colDate') }),
      column.accessor('principalPoisha', {
        header: l('loans.colPrincipal'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('interestPoisha', {
        header: l('loans.colInterest'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('status', {
        header: l('loans.colStatus'),
        cell: (cell) => {
          const status = PAYMENT_STATUS[cell.getValue()];
          return <StatusBadge tone={status.tone}>{l(status.key)}</StatusBadge>;
        },
      }),
    ]) as readonly DataTableColumn<StatementPayment>[];
  }, [l, locale]);

  if (!mayRead) {
    return (
      <PermissionGate
        allowed={false}
        explain={{ title: l('loans.deniedTitle'), detail: l('loans.deniedDetail') }}
      >
        {null}
      </PermissionGate>
    );
  }

  const walletOptions: readonly SelectOption[] = (walletsQuery.data?.items ?? [])
    .filter((wallet) => wallet.isActive)
    .map((wallet) => ({ value: wallet.ledgerAccountId, label: `${wallet.code} · ${wallet.name}` }));

  const agrees =
    statement !== undefined &&
    BigInt(statement.lender.ledgerOwedPoisha) === BigInt(statement.lender.scheduleOwedPoisha);

  return (
    <div className="space-y-6">
      <Link
        to="/loans"
        className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        {l('loans.back')}
      </Link>

      {statementQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {l('loans.notFound')}
        </p>
      ) : null}

      {statement === undefined ? null : (
        <header className="space-y-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="text-lg font-semibold tracking-tight">
              {l('loans.statementTitle')} · {statement.loan.lenderName}
            </h1>
            {statement.loan.voidedAt === null ? null : (
              <StatusBadge tone="neutral">{l('loans.voided')}</StatusBadge>
            )}
            {mayVoid ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setNotice(null);
                  setVoiding(true);
                }}
              >
                {l('loans.void')}
              </Button>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {[
              statement.loan.reference,
              `${l('loans.receivedOn')} ${statement.loan.receivedOn}`,
              `${percentOfBps(statement.loan.rateBps)} · ${l(METHOD_LABEL[statement.loan.method])}`,
              `${String(statement.loan.tenureMonths)} ${l('loans.months')}`,
              `${l('loans.reminder')}: ${String(statement.loan.reminderDays)} ${l('loans.daysBefore')}${
                statement.loan.reminderPhoneMasked === null
                  ? ''
                  : ` · ${statement.loan.reminderPhoneMasked}`
              }`,
            ]
              .filter((part) => part !== null && part !== '')
              .join(' · ')}
          </p>
        </header>
      )}

      {notice === null ? null : (
        <p
          role="status"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
        >
          {l(notice)}
        </p>
      )}
      {statement?.payable.reason === 'waiting' ? (
        <p
          role="status"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
        >
          {l('loans.waitingNotice')}
        </p>
      ) : null}

      {statement === undefined ? null : (
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Tile
            label={l('loans.totalPrincipal')}
            poisha={statement.loan.principalPoisha}
            locale={locale}
          />
          <Tile
            label={l('loans.totalOutstanding')}
            poisha={statement.totals.outstandingPrincipalPoisha}
            locale={locale}
          />
          <Tile
            label={l('loans.totalInterestPaid')}
            poisha={statement.totals.paidInterestPoisha}
            locale={locale}
          />
          <Tile
            label={l('loans.totalInterestOwed')}
            poisha={statement.totals.outstandingInterestPoisha}
            locale={locale}
          />
          <div className="rounded-md border border-border p-3">
            <dt className="text-xs text-muted-foreground">{l('loans.ledgerCheck')}</dt>
            <dd className="mt-1 space-y-1">
              <span className="block text-base font-semibold">
                <Money poisha={statement.lender.ledgerOwedPoisha} locale={locale} />
              </span>
              <StatusBadge tone={agrees ? 'success' : 'danger'}>
                {l(agrees ? 'loans.ledgerAgrees' : 'loans.ledgerDisagrees')}
              </StatusBadge>
            </dd>
          </div>
        </dl>
      )}

      <section aria-labelledby="schedule-heading" className="space-y-3">
        <h2 id="schedule-heading" className="text-sm font-medium">
          {l('loans.scheduleHeading')}
        </h2>
        <DataTable<StatementInstalment>
          caption={l('loans.scheduleCaption')}
          columns={instalmentColumns}
          data={statement?.instalments ?? []}
          getRowId={(row) => row.id}
          loading={statementQuery.isPending}
          error={statementQuery.error}
          onRetry={() => void statementQuery.refetch()}
          page={SINGLE_PAGE}
          onPageChange={() => undefined}
          sort={null}
          onSortChange={() => undefined}
          labels={tableLabels(t, l, 'loans.emptyTitle', 'loans.emptyDetail')}
        />
      </section>

      <section aria-labelledby="payments-heading" className="space-y-3">
        <h2 id="payments-heading" className="text-sm font-medium">
          {l('loans.paymentsHeading')}
        </h2>
        <DataTable<StatementPayment>
          caption={l('loans.paymentsCaption')}
          columns={paymentColumns}
          data={statement?.payments ?? []}
          getRowId={(row) => row.id}
          loading={statementQuery.isPending}
          error={statementQuery.error}
          onRetry={() => void statementQuery.refetch()}
          page={SINGLE_PAGE}
          onPageChange={() => undefined}
          sort={null}
          onSortChange={() => undefined}
          labels={tableLabels(t, l, 'loans.paymentsEmptyTitle', 'loans.paymentsEmptyDetail')}
        />
      </section>

      <Dialog
        open={voiding}
        onOpenChange={setVoiding}
        title={l('loans.voidTitle')}
        description={l('loans.voidDetail')}
        closeLabel={t('common.close')}
      >
        <Form<VoidForm>
          form={voidForm}
          onSubmit={(values) => voidMutation.mutateAsync(values).then(() => undefined)}
          {...(voidMutation.error === null
            ? {}
            : { submitError: messageOf(voidMutation.error, t) })}
        >
          <TextField<VoidForm> name="reason" label={l('loans.fieldVoidReason')} required />
          <div className="mt-5 flex justify-end">
            <Button type="submit" variant="destructive" disabled={voidMutation.isPending}>
              {voidMutation.isPending ? l('loans.saving') : l('loans.void')}
            </Button>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={paying !== null}
        onOpenChange={(open) => {
          if (!open) setPaying(null);
        }}
        title={`${l('loans.payTitle')} ${String(paying?.seq ?? '')}`}
        description={l('loans.payDetail')}
        closeLabel={t('common.close')}
      >
        <Form<PayForm>
          form={payForm}
          onSubmit={(values) =>
            payMutation
              .mutateAsync({ ...values, instalmentId: paying?.id ?? '' })
              .then(() => undefined)
          }
          {...(payMutation.error === null ? {} : { submitError: messageOf(payMutation.error, t) })}
        >
          {paying === null ? null : (
            <p className="mb-4 text-sm">
              {l('loans.colInstalment')}: <Money poisha={paying.totalPoisha} locale={locale} /> (
              {l('loans.colPrincipal')} <Money poisha={paying.principalPoisha} locale={locale} />,{' '}
              {l('loans.colInterest')} <Money poisha={paying.interestPoisha} locale={locale} />)
            </p>
          )}
          <div className="space-y-4">
            <SelectField<PayForm>
              name="walletAccountId"
              label={l('loans.fieldPayWallet')}
              required
              options={walletOptions}
              placeholder={l('loans.pickWallet')}
            />
            <TextField<PayForm> name="memo" label={l('loans.fieldMemo')} />
          </div>
          <div className="mt-5 flex justify-end">
            <Button type="submit" disabled={payMutation.isPending}>
              {payMutation.isPending ? l('loans.saving') : l('loans.pay')}
            </Button>
          </div>
        </Form>
      </Dialog>
    </div>
  );
}

function Tile({
  label,
  poisha,
  locale,
}: {
  readonly label: string;
  readonly poisha: string;
  readonly locale: 'en' | 'bn';
}) {
  return (
    <div className="rounded-md border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-base font-semibold">
        <Money poisha={poisha} locale={locale} />
      </dd>
    </div>
  );
}
