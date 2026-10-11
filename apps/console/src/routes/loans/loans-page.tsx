import { zodResolver } from '@hookform/resolvers/zod';
import {
  Button,
  DataTable,
  Dialog,
  Form,
  Money,
  MoneyField,
  PageHeader,
  PermissionGate,
  SelectField,
  StatusBadge,
  TextField,
  dataTableColumns,
  type DataTableColumn,
  type SelectOption,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import type { MessageKey } from '@elysium/i18n';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import { listWallets } from '../accounts/api.js';
import { bpsFromPercent, percentOfBps } from '../investors/share.js';
import {
  createLender,
  createLoan,
  listLenders,
  listLoans,
  previewSchedule,
  type LenderKind,
  type LenderRow,
  type LoanMethod,
  type LoanRow,
  type Preview,
  type PreviewRow,
  type Terms,
} from './api.js';
import { attemptId, endsAttempt } from './attempt.js';
import { useLoansT, type LoansMessageKey } from './messages.js';

/**
 * The Company loans screen (M26): lenders, loans with what is still owed and the next
 * instalment, and the forms that record them.
 *
 * Every figure is the server's. The new-loan form asks the server for the schedule
 * (`POST /v1/loans/preview`) rather than computing it here: the schedule is a domain
 * function with exact integer rounding, and a second implementation in the browser is a
 * second answer that can disagree with the books.
 */

const SINGLE_PAGE = { page: 1, pageSize: 500, total: null, hasNext: false } as const;

const lenderFormSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(['bank', 'person', 'other']),
  notes: z.string().trim().max(2_000).optional(),
});
type LenderForm = z.infer<typeof lenderFormSchema>;

const loanFormSchema = z.object({
  lenderId: z.string().uuid(),
  principalPoisha: z.string().regex(/^[1-9]\d*$/),
  ratePercent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/),
  method: z.enum(['flat', 'reducing']),
  tenureMonths: z.string().regex(/^[1-9]\d{0,2}$/),
  firstDueOn: z
    .string()
    .regex(/^(\d{4}-\d{2}-\d{2})?$/)
    .optional(),
  walletAccountId: z.string().uuid(),
  reference: z.string().trim().max(80).optional(),
  reminderDays: z.string().regex(/^\d{1,2}$/),
  reminderPhone: z.string().trim().max(20).optional(),
  memo: z.string().trim().max(500).optional(),
});
type LoanForm = z.infer<typeof loanFormSchema>;

const LOAN_DEFAULTS: Partial<LoanForm> = {
  principalPoisha: '',
  ratePercent: '12',
  method: 'reducing',
  tenureMonths: '12',
  firstDueOn: '',
  reminderDays: '3',
};

export const METHOD_LABEL: Record<LoanMethod, LoansMessageKey> = {
  flat: 'loans.methodFlat',
  reducing: 'loans.methodReducing',
};

const KIND_LABEL: Record<LenderKind, LoansMessageKey> = {
  bank: 'loans.kindBank',
  person: 'loans.kindPerson',
  other: 'loans.kindOther',
};

export const NEXT_STATE: Record<
  'due' | 'overdue' | 'pending_approval' | 'paid' | 'void',
  { key: LoansMessageKey; tone: 'neutral' | 'danger' | 'warning' | 'success' }
> = {
  due: { key: 'loans.stateDue', tone: 'neutral' },
  overdue: { key: 'loans.stateOverdue', tone: 'danger' },
  pending_approval: { key: 'loans.statePending', tone: 'warning' },
  paid: { key: 'loans.statePaid', tone: 'success' },
  void: { key: 'loans.stateVoid', tone: 'neutral' },
};

/** The server's problem+json detail is written to be shown; anything else never reached it. */
export function messageOf(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof ApiError) return error.message;
  return t('error.unreachable');
}

const TERM_FIELDS = [
  'principalPoisha',
  'ratePercent',
  'method',
  'tenureMonths',
  'firstDueOn',
] as const;

function termsOf(values: Pick<LoanForm, (typeof TERM_FIELDS)[number]>): Terms {
  return {
    principalPoisha: values.principalPoisha,
    rateBps: bpsFromPercent(values.ratePercent),
    method: values.method,
    tenureMonths: Number(values.tenureMonths),
    ...(values.firstDueOn === undefined || values.firstDueOn === ''
      ? {}
      : { firstDueOn: values.firstDueOn }),
  };
}

export function tableLabels(
  t: ReturnType<typeof useT>,
  l: (key: LoansMessageKey) => string,
  emptyTitle: LoansMessageKey,
  emptyDetail: LoansMessageKey,
) {
  return {
    columns: t('table.columns'),
    previous: t('table.previous'),
    next: t('table.next'),
    emptyTitle: l(emptyTitle),
    emptyDetail: l(emptyDetail),
    errorTitle: t('table.errorTitle'),
    errorDetail: t('table.errorDetail'),
    retry: t('common.retry'),
    pageStatus: `${t('table.page')} 1`,
    sortAscending: t('table.sortAscending'),
    sortDescending: t('table.sortDescending'),
  };
}

export function scheduleColumns(
  l: (key: LoansMessageKey) => string,
  locale: 'en',
): readonly DataTableColumn<PreviewRow>[] {
  const column = dataTableColumns<PreviewRow>();
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
  ]) as readonly DataTableColumn<PreviewRow>[];
}

export function LoansPage() {
  const ability = useAbility();
  const t = useT();
  const l = useLoansT();
  const { locale } = useLocale();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'CompanyLoan');
  const mayRecord = ability.can('create', 'CompanyLoan');

  const [lenderOpen, setLenderOpen] = useState(false);
  const [loanOpen, setLoanOpen] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  /*
   * The loan's id lives as long as the attempt: a retry after a lost response sends the same
   * id and is answered from the loan it recorded, instead of recording a second loan and a
   * second receipt (ledger audit W-C). Any edit or a success starts a new attempt, as the
   * transfer screen renews its id (accounts/transfers.tsx).
   */
  const attempt = useRef<{ readonly key: string; readonly id: string } | null>(null);

  const loansQuery = useQuery({
    queryKey: ['loans', 'list'],
    queryFn: listLoans,
    enabled: mayRead,
  });
  const lendersQuery = useQuery({
    queryKey: ['loans', 'lenders'],
    queryFn: listLenders,
    enabled: mayRead,
  });
  const walletsQuery = useQuery({
    queryKey: ['loans', 'wallets'],
    queryFn: () => listWallets(),
    enabled: mayRecord,
  });

  const lenderForm = useForm<LenderForm>({
    resolver: zodResolver(lenderFormSchema),
    defaultValues: { name: '', kind: 'bank', notes: '' },
  });
  const loanForm = useForm<LoanForm>({
    resolver: zodResolver(loanFormSchema),
    defaultValues: LOAN_DEFAULTS,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['loans'] });
  };

  const lenderMutation = useMutation({
    mutationFn: (values: LenderForm) =>
      createLender({
        name: values.name,
        kind: values.kind,
        ...(values.notes === undefined || values.notes === '' ? {} : { notes: values.notes }),
      }),
    onSuccess: async () => {
      setLenderOpen(false);
      lenderForm.reset({ name: '', kind: 'bank', notes: '' });
      await refresh();
    },
  });

  const previewMutation = useMutation({
    mutationFn: (values: Pick<LoanForm, (typeof TERM_FIELDS)[number]>) =>
      previewSchedule(termsOf(values)),
    onSuccess: (result) => setPreview(result),
  });

  const loanMutation = useMutation({
    mutationFn: (values: LoanForm) =>
      createLoan({
        ...termsOf(values),
        loanId: attemptId(attempt, values),
        lenderId: values.lenderId,
        walletAccountId: values.walletAccountId,
        reminderDays: Number(values.reminderDays),
        ...(values.reference === undefined || values.reference === ''
          ? {}
          : { reference: values.reference }),
        ...(values.reminderPhone === undefined || values.reminderPhone === ''
          ? {}
          : { reminderPhone: values.reminderPhone }),
        ...(values.memo === undefined || values.memo === '' ? {} : { memo: values.memo }),
      }),
    onSuccess: async () => {
      setLoanOpen(false);
      setPreview(null);
      loanForm.reset(LOAN_DEFAULTS);
      attempt.current = null;
      await refresh();
    },
    onError: (error) => {
      if (endsAttempt(error)) attempt.current = null;
    },
  });

  const loanColumns = useMemo<readonly DataTableColumn<LoanRow>[]>(() => {
    const column = dataTableColumns<LoanRow>();
    return column.columns([
      column.accessor('lenderName', {
        header: l('loans.colLender'),
        cell: (cell) => (
          <Link
            to="/loans/$loanId"
            params={{ loanId: cell.row.original.id }}
            className="font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {cell.getValue()}
          </Link>
        ),
      }),
      column.accessor('reference', {
        header: l('loans.colReference'),
        cell: (cell) => cell.getValue() ?? '',
      }),
      column.accessor('principalPoisha', {
        header: l('loans.colPrincipal'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('rateBps', {
        header: l('loans.colRate'),
        meta: { numeric: true },
        cell: (cell) => percentOfBps(cell.getValue()),
      }),
      column.accessor('method', {
        header: l('loans.colMethod'),
        cell: (cell) => l(METHOD_LABEL[cell.getValue()]),
      }),
      column.accessor('outstandingPrincipalPoisha', {
        header: l('loans.colOutstanding'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.display({
        id: 'next',
        header: l('loans.colNext'),
        cell: (cell) => {
          const next = cell.row.original.next;
          if (cell.row.original.voided) {
            return <StatusBadge tone="neutral">{l('loans.voided')}</StatusBadge>;
          }
          if (next === null) return <StatusBadge tone="success">{l('loans.settled')}</StatusBadge>;
          const state = NEXT_STATE[next.state];
          return (
            <span className="flex flex-wrap items-center gap-2">
              <span className="tabular-nums">{next.dueOn}</span>
              <Money poisha={next.totalPoisha} locale={locale} />
              <StatusBadge tone={state.tone}>{l(state.key)}</StatusBadge>
            </span>
          );
        },
      }),
    ]) as readonly DataTableColumn<LoanRow>[];
  }, [l, locale]);

  const lenderColumns = useMemo<readonly DataTableColumn<LenderRow>[]>(() => {
    const column = dataTableColumns<LenderRow>();
    return column.columns([
      column.accessor('name', { header: l('loans.colName') }),
      column.accessor('kind', {
        header: l('loans.colKind'),
        cell: (cell) => l(KIND_LABEL[cell.getValue()]),
      }),
      column.accessor('notes', {
        header: l('loans.fieldNotes'),
        cell: (cell) => cell.getValue() ?? '',
      }),
    ]) as readonly DataTableColumn<LenderRow>[];
  }, [l]);

  const previewColumns = useMemo(() => scheduleColumns(l, locale), [l, locale]);

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

  const lenderOptions: readonly SelectOption[] = (lendersQuery.data?.items ?? []).map((row) => ({
    value: row.id,
    label: row.name,
  }));
  const walletOptions: readonly SelectOption[] = (walletsQuery.data?.items ?? [])
    .filter((wallet) => wallet.isActive)
    .map((wallet) => ({ value: wallet.ledgerAccountId, label: `${wallet.code} · ${wallet.name}` }));
  const kindOptions: readonly SelectOption[] = (['bank', 'person', 'other'] as const).map(
    (kind) => ({ value: kind, label: l(KIND_LABEL[kind]) }),
  );
  const methodOptions: readonly SelectOption[] = (['reducing', 'flat'] as const).map((method) => ({
    value: method,
    label: l(METHOD_LABEL[method]),
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={l('loans.title')}
        description={l('loans.subtitle')}
        actions={
          <PermissionGate allowed={mayRecord}>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setLenderOpen(true)}>
                {l('loans.newLender')}
              </Button>
              <Button size="sm" onClick={() => setLoanOpen(true)}>
                {l('loans.newLoan')}
              </Button>
            </div>
          </PermissionGate>
        }
      />

      <section aria-labelledby="loans-heading" className="space-y-3">
        <h2 id="loans-heading" className="text-sm font-medium">
          {l('loans.listHeading')}
        </h2>
        <DataTable<LoanRow>
          caption={l('loans.listCaption')}
          columns={loanColumns}
          data={loansQuery.data?.items ?? []}
          getRowId={(row) => row.id}
          loading={loansQuery.isPending}
          error={loansQuery.error}
          onRetry={() => void loansQuery.refetch()}
          page={SINGLE_PAGE}
          onPageChange={() => undefined}
          sort={null}
          onSortChange={() => undefined}
          labels={tableLabels(t, l, 'loans.emptyTitle', 'loans.emptyDetail')}
        />
      </section>

      <section aria-labelledby="lenders-heading" className="space-y-3">
        <h2 id="lenders-heading" className="text-sm font-medium">
          {l('loans.lendersHeading')}
        </h2>
        <DataTable<LenderRow>
          caption={l('loans.lendersCaption')}
          columns={lenderColumns}
          data={lendersQuery.data?.items ?? []}
          getRowId={(row) => row.id}
          loading={lendersQuery.isPending}
          error={lendersQuery.error}
          onRetry={() => void lendersQuery.refetch()}
          page={SINGLE_PAGE}
          onPageChange={() => undefined}
          sort={null}
          onSortChange={() => undefined}
          labels={tableLabels(t, l, 'loans.lendersEmptyTitle', 'loans.lendersEmptyDetail')}
        />
      </section>

      <Dialog
        open={lenderOpen}
        onOpenChange={setLenderOpen}
        title={l('loans.lenderTitle')}
        description={l('loans.lenderDetail')}
        closeLabel={t('common.close')}
      >
        <Form<LenderForm>
          form={lenderForm}
          onSubmit={(values) => lenderMutation.mutateAsync(values).then(() => undefined)}
          {...(lenderMutation.error === null
            ? {}
            : { submitError: messageOf(lenderMutation.error, t) })}
        >
          <div className="space-y-4">
            <TextField<LenderForm> name="name" label={l('loans.fieldName')} required />
            <SelectField<LenderForm>
              name="kind"
              label={l('loans.fieldKind')}
              required
              options={kindOptions}
              placeholder={l('loans.fieldKind')}
            />
            <TextField<LenderForm> name="notes" label={l('loans.fieldNotes')} />
          </div>
          <div className="mt-5 flex justify-end">
            <Button type="submit" disabled={lenderMutation.isPending}>
              {lenderMutation.isPending ? l('loans.saving') : l('loans.save')}
            </Button>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={loanOpen}
        onOpenChange={(open) => {
          setLoanOpen(open);
          if (!open) setPreview(null);
        }}
        title={l('loans.loanTitle')}
        description={l('loans.loanDetail')}
        closeLabel={t('common.close')}
      >
        <Form<LoanForm>
          form={loanForm}
          onSubmit={(values) => loanMutation.mutateAsync(values).then(() => undefined)}
          {...(loanMutation.error === null
            ? previewMutation.error === null
              ? {}
              : { submitError: messageOf(previewMutation.error, t) }
            : { submitError: messageOf(loanMutation.error, t) })}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField<LoanForm>
              name="lenderId"
              label={l('loans.fieldLender')}
              required
              options={lenderOptions}
              placeholder={l('loans.pickLender')}
            />
            <SelectField<LoanForm>
              name="walletAccountId"
              label={l('loans.fieldWallet')}
              required
              options={walletOptions}
              placeholder={l('loans.pickWallet')}
            />
            <MoneyField<LoanForm>
              name="principalPoisha"
              label={l('loans.fieldPrincipal')}
              required
            />
            <TextField<LoanForm>
              name="ratePercent"
              label={l('loans.fieldRate')}
              hint={l('loans.rateHint')}
              required
            />
            <SelectField<LoanForm>
              name="method"
              label={l('loans.fieldMethod')}
              required
              options={methodOptions}
              placeholder={l('loans.fieldMethod')}
            />
            <TextField<LoanForm> name="tenureMonths" label={l('loans.fieldTenure')} required />
            <TextField<LoanForm>
              name="firstDueOn"
              label={l('loans.fieldFirstDue')}
              hint={l('loans.firstDueHint')}
            />
            <TextField<LoanForm> name="reference" label={l('loans.fieldReference')} />
            <TextField<LoanForm>
              name="reminderDays"
              label={l('loans.fieldReminderDays')}
              required
            />
            <TextField<LoanForm>
              name="reminderPhone"
              label={l('loans.fieldReminderPhone')}
              hint={l('loans.reminderPhoneHint')}
            />
            <TextField<LoanForm> name="memo" label={l('loans.fieldMemo')} />
          </div>

          {preview === null ? null : (
            <section aria-labelledby="loan-preview-heading" className="mt-5 space-y-2">
              <h3 id="loan-preview-heading" className="text-sm font-medium">
                {l('loans.previewHeading')}
              </h3>
              <div className="max-h-64 overflow-y-auto">
                <DataTable<PreviewRow>
                  caption={l('loans.previewCaption')}
                  columns={previewColumns}
                  data={preview.instalments}
                  getRowId={(row) => String(row.seq)}
                  loading={false}
                  error={null}
                  onRetry={() => undefined}
                  page={SINGLE_PAGE}
                  onPageChange={() => undefined}
                  sort={null}
                  onSortChange={() => undefined}
                  labels={tableLabels(t, l, 'loans.emptyTitle', 'loans.emptyDetail')}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                {l('loans.colInterest')}:{' '}
                <Money poisha={preview.totals.interestPoisha} locale={locale} />
              </p>
            </section>
          )}

          <div className="mt-5 flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={previewMutation.isPending}
              onClick={() => {
                // Only the terms need to be valid to see what they produce.
                void loanForm.trigger([...TERM_FIELDS]).then((valid) => {
                  if (valid) previewMutation.mutate(loanForm.getValues());
                });
              }}
            >
              {l('loans.preview')}
            </Button>
            <Button type="submit" disabled={loanMutation.isPending}>
              {loanMutation.isPending ? l('loans.saving') : l('loans.save')}
            </Button>
          </div>
        </Form>
      </Dialog>
    </div>
  );
}
