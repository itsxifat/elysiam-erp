import { zodResolver } from '@hookform/resolvers/zod';
import {
  Button,
  DataTable,
  Dialog,
  Form,
  Money,
  MoneyField,
  PermissionGate,
  SelectField,
  StatusBadge,
  TextField,
  dataTableColumns,
  type DataTableColumn,
  type SelectOption,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, Landmark, Smartphone, Wallet } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import { ApiError } from '../../api.js';
import {
  dhakaMonthStart,
  dhakaToday,
  listCashEntries,
  listCategories,
  listClosings,
  listWallets,
  profitAndLoss,
  recordCashEntry,
  recordClosing,
  type CashEntryRow,
  type ClosingRow,
  type WalletRow,
} from './api.js';
import { useAccountsT, type AccountsMessageKey } from './messages.js';

/**
 * The Accounts screen: the cash picture the client's own words point at (M08).
 *
 * Three things on this page are decisions rather than layout:
 *
 * 1. **Every balance on it is derived.** The wallet cards, the total and the
 *    closing's "ledger says" column all come from sums over journal lines on the
 *    server; nothing is cached client-side and nothing is added up here. A screen
 *    that summed the entries it happened to have fetched would disagree with the
 *    cash book the moment a page boundary or a filter got involved.
 * 2. **A held entry is shown as held, not as done.** Petty cash at or above the
 *    org's threshold posts nothing until a checker decides, so the row says
 *    "waiting for a checker" and the wallet balance does not move. Showing it as
 *    posted would make the screen disagree with the ledger on purpose.
 * 3. **The permission gate shows the denied state rather than an empty page.** A
 *    role with no `read Wallet` gets an explanation; §24 asks for absence to be
 *    explained once rather than to look like a bug.
 *
 * Money is `<Money>` everywhere, in tabular numerals, from integer-poisha strings.
 */

const cashEntryFormSchema = z.object({
  walletId: z.string().uuid(),
  kind: z.enum(['cash_in', 'cash_out', 'petty_cash']),
  categoryAccountId: z.string().uuid(),
  amountPoisha: z.string().regex(/^[1-9]\d*$/),
  memo: z.string().trim().max(500).optional(),
});
type CashEntryForm = z.infer<typeof cashEntryFormSchema>;

const closingFormSchema = z.object({
  walletId: z.string().uuid(),
  businessDate: z.string(),
  countedPoisha: z.string().regex(/^(0|[1-9]\d*)$/),
  memo: z.string().trim().max(500).optional(),
});
type ClosingForm = z.infer<typeof closingFormSchema>;

/**
 * One page, no pager.
 *
 * Both tables show a bounded window — this month to date, capped server-side — so
 * there is nothing to page through. `total: null` rather than a count, because the
 * endpoint does not return one and a fabricated total is worse than none.
 */
const SINGLE_PAGE = { page: 1, pageSize: 500, total: null, hasNext: false } as const;

const WALLET_ICONS: Record<string, typeof Wallet> = {
  wallet_cash: Banknote,
  wallet_bank: Landmark,
  wallet_bkash: Smartphone,
  wallet_mfs_other: Smartphone,
};

const WALLET_LABELS: Record<string, AccountsMessageKey> = {
  wallet_cash: 'accounts.kindHandCash',
  wallet_bank: 'accounts.kindBank',
  wallet_bkash: 'accounts.kindBkash',
  wallet_mfs_other: 'accounts.kindMfsOther',
};

const KIND_LABELS: Record<CashEntryRow['kind'], AccountsMessageKey> = {
  cash_in: 'accounts.kindCashIn',
  cash_out: 'accounts.kindCashOut',
  petty_cash: 'accounts.kindPettyCash',
};

const STATUS_LABELS: Record<CashEntryRow['status'], AccountsMessageKey> = {
  posted: 'accounts.statusPosted',
  pending_approval: 'accounts.statusPending',
  rejected: 'accounts.statusRejected',
};

export function AccountsPage() {
  const ability = useAbility();
  const t = useT();
  const a = useAccountsT();
  const { locale } = useLocale();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Wallet');
  const mayWrite = ability.can('update', 'Wallet');
  const mayReadReports = ability.can('read', 'LedgerReport');

  const [entryOpen, setEntryOpen] = useState(false);
  const [closingOpen, setClosingOpen] = useState(false);
  const [notice, setNotice] = useState<AccountsMessageKey | null>(null);

  const today = dhakaToday();
  const monthStart = dhakaMonthStart();

  const walletQuery = useQuery({
    queryKey: ['accounts', 'wallets', today],
    queryFn: () => listWallets(today),
    enabled: mayRead,
  });
  const categoryQuery = useQuery({
    queryKey: ['accounts', 'categories'],
    queryFn: listCategories,
    enabled: mayWrite,
  });
  const entryQuery = useQuery({
    queryKey: ['accounts', 'cash-entries', monthStart, today],
    queryFn: () => listCashEntries({ from: monthStart, to: today }),
    enabled: mayRead,
  });
  const closingQuery = useQuery({
    queryKey: ['accounts', 'closings', monthStart, today],
    queryFn: () => listClosings({ from: monthStart, to: today }),
    enabled: mayRead,
  });
  const pnlQuery = useQuery({
    queryKey: ['accounts', 'pnl', monthStart, today],
    queryFn: () => profitAndLoss({ from: monthStart, to: today }),
    enabled: mayReadReports,
  });

  const walletsById = useMemo(
    () => new Map((walletQuery.data?.items ?? []).map((wallet) => [wallet.id, wallet])),
    [walletQuery.data],
  );

  const entryForm = useForm<CashEntryForm>({
    resolver: zodResolver(cashEntryFormSchema),
    defaultValues: { kind: 'cash_in', amountPoisha: '', memo: '' },
  });
  const closingForm = useForm<ClosingForm>({
    resolver: zodResolver(closingFormSchema),
    defaultValues: { businessDate: today, countedPoisha: '', memo: '' },
  });

  /*
   * `useWatch` rather than `entryForm.watch(...)`. `watch()` returns a new
   * function on every render, so the React Compiler refuses to memoize any
   * component that calls it and says so as a lint warning. `useWatch` subscribes
   * to the one field and re-renders on its value, which is all this needs.
   */
  const kind = useWatch({ control: entryForm.control, name: 'kind' });

  /**
   * Both mutations invalidate rather than patching the cache.
   *
   * The server's answer for a held entry has no journal and no balance change, and
   * the wallet balance is derived — so the only correct next value for every query
   * on this page is the one the server computes. Patching a balance locally is how
   * a screen starts disagreeing with the ledger.
   */
  const entryMutation = useMutation({
    mutationFn: (values: CashEntryForm) =>
      recordCashEntry({
        entryId: crypto.randomUUID(),
        walletId: values.walletId,
        kind: values.kind,
        categoryAccountId: values.categoryAccountId,
        amountPoisha: values.amountPoisha,
        ...(values.memo === undefined || values.memo === '' ? {} : { memo: values.memo }),
      }),
    onSuccess: async (result) => {
      setEntryOpen(false);
      setNotice(result.status === 'pending_approval' ? 'accounts.heldNotice' : null);
      entryForm.reset({ kind: 'cash_in', amountPoisha: '', memo: '' });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const closingMutation = useMutation({
    mutationFn: (values: ClosingForm) =>
      recordClosing({
        closingId: crypto.randomUUID(),
        walletId: values.walletId,
        businessDate: values.businessDate,
        countedPoisha: values.countedPoisha,
        ...(values.memo === undefined || values.memo === '' ? {} : { memo: values.memo }),
      }),
    onSuccess: async (result) => {
      setClosingOpen(false);
      setNotice(result.status === 'pending_approval' ? 'accounts.varianceNotice' : null);
      closingForm.reset({ businessDate: today, countedPoisha: '', memo: '' });
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  const entryColumns = useMemo<readonly DataTableColumn<CashEntryRow>[]>(() => {
    const column = dataTableColumns<CashEntryRow>();
    return column.columns([
      column.accessor('businessDate', { header: a('accounts.colDate') }),
      column.accessor('walletId', {
        header: a('accounts.colWallet'),
        cell: (cell) => walletsById.get(cell.getValue())?.name ?? '—',
      }),
      column.accessor('kind', {
        header: a('accounts.colKind'),
        cell: (cell) => a(KIND_LABELS[cell.getValue()]),
      }),
      column.accessor('categoryName', { header: a('accounts.colCategory') }),
      column.accessor('amountPoisha', {
        header: a('accounts.colAmount'),
        meta: { numeric: true },
        cell: (cell) => {
          const row = cell.row.original;
          return (
            <Money
              poisha={cell.getValue()}
              locale={locale}
              // A cash out is money leaving, and the sign is the only thing that
              // says so: the amount is stored positive and the direction is the
              // kind, so a column of bare positives would read as all income.
              className={row.kind === 'cash_in' ? undefined : 'text-muted-foreground'}
            />
          );
        },
      }),
      column.accessor('status', {
        header: a('accounts.colStatus'),
        cell: (cell) => {
          const value = cell.getValue();
          return (
            <StatusBadge
              tone={
                value === 'posted'
                  ? 'success'
                  : value === 'pending_approval'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {a(STATUS_LABELS[value])}
            </StatusBadge>
          );
        },
      }),
    ]) as readonly DataTableColumn<CashEntryRow>[];
  }, [a, locale, walletsById]);

  const closingColumns = useMemo<readonly DataTableColumn<ClosingRow>[]>(() => {
    const column = dataTableColumns<ClosingRow>();
    return column.columns([
      column.accessor('businessDate', { header: a('accounts.colDate') }),
      column.accessor('walletId', {
        header: a('accounts.colWallet'),
        cell: (cell) => walletsById.get(cell.getValue())?.name ?? '—',
      }),
      column.accessor('expectedPoisha', {
        header: a('accounts.colExpected'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('countedPoisha', {
        header: a('accounts.colCounted'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('variancePoisha', {
        header: a('accounts.colVariance'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('status', {
        header: a('accounts.colStatus'),
        cell: (cell) => {
          const value = cell.getValue();
          return (
            <StatusBadge
              tone={
                value === 'posted' || value === 'balanced'
                  ? 'success'
                  : value === 'pending_approval'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {value === 'balanced'
                ? a('accounts.statusPosted')
                : a(STATUS_LABELS[value === 'rejected' ? 'rejected' : 'pending_approval'])}
            </StatusBadge>
          );
        },
      }),
    ]) as readonly DataTableColumn<ClosingRow>[];
  }, [a, locale, walletsById]);

  if (!mayRead) {
    return (
      <PermissionGate
        allowed={false}
        explain={{ title: a('accounts.deniedTitle'), detail: a('accounts.deniedDetail') }}
      >
        {null}
      </PermissionGate>
    );
  }

  const walletOptions: readonly SelectOption[] = (walletQuery.data?.items ?? [])
    .filter((wallet) => wallet.isActive)
    .map((wallet) => ({ value: wallet.id, label: `${wallet.code} · ${wallet.name}` }));

  const categoryOptions: readonly SelectOption[] = (categoryQuery.data?.items ?? [])
    .filter((category) =>
      kind === 'cash_in' ? category.class === 'income' : category.class === 'expense',
    )
    .map((category) => ({ value: category.id, label: `${category.code} · ${category.name}` }));

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">{a('accounts.title')}</h1>
          <p className="mt-0.5 text-sm text-muted-foreground">{a('accounts.subtitle')}</p>
        </div>
        <PermissionGate allowed={mayWrite}>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setClosingOpen(true)}>
              {a('accounts.countCash')}
            </Button>
            <Button size="sm" onClick={() => setEntryOpen(true)}>
              {a('accounts.recordCash')}
            </Button>
          </div>
        </PermissionGate>
      </header>

      {notice === null ? null : (
        <p
          role="status"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
        >
          {a(notice)}
        </p>
      )}

      <section aria-labelledby="wallets-heading" className="space-y-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="wallets-heading" className="text-sm font-medium">
            {a('accounts.walletsHeading')}
          </h2>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">{a('accounts.totalCash')}</p>
            <p className="text-base font-semibold">
              <Money poisha={walletQuery.data?.totalPoisha ?? '0'} locale={locale} />
            </p>
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(walletQuery.data?.items ?? []).map((wallet) => (
            <WalletCard key={wallet.id} wallet={wallet} locale={locale} label={a} />
          ))}
        </div>
        {walletQuery.data?.items.length === 0 ? (
          <p className="rounded-md border border-border px-3 py-6 text-center text-sm text-muted-foreground">
            {a('accounts.noWalletsDetail')}
          </p>
        ) : null}
      </section>

      {mayReadReports && pnlQuery.data !== undefined ? (
        <section aria-labelledby="pnl-heading" className="space-y-2">
          <h2 id="pnl-heading" className="text-sm font-medium">
            {a('accounts.pnlHeading')}
          </h2>
          <dl className="grid gap-3 sm:grid-cols-3">
            <Tile
              label={a('accounts.pnlIncome')}
              poisha={pnlQuery.data.incomePoisha}
              locale={locale}
            />
            <Tile
              label={a('accounts.pnlExpense')}
              poisha={pnlQuery.data.expensePoisha}
              locale={locale}
            />
            <Tile label={a('accounts.pnlNet')} poisha={pnlQuery.data.netPoisha} locale={locale} />
          </dl>
          {pnlQuery.data.costWithheld ? (
            <p className="text-xs text-muted-foreground">{a('accounts.costWithheld')}</p>
          ) : null}
        </section>
      ) : null}

      <section aria-labelledby="entries-heading" className="space-y-3">
        <h2 id="entries-heading" className="text-sm font-medium">
          {a('accounts.entriesHeading')}
        </h2>
        <DataTable<CashEntryRow>
          caption={a('accounts.entriesCaption')}
          columns={entryColumns}
          data={entryQuery.data?.items ?? []}
          getRowId={(row) => row.id}
          loading={entryQuery.isPending}
          error={entryQuery.error}
          onRetry={() => void entryQuery.refetch()}
          page={SINGLE_PAGE}
          onPageChange={() => undefined}
          sort={null}
          onSortChange={() => undefined}
          labels={{
            columns: t('table.columns'),
            previous: t('table.previous'),
            next: t('table.next'),
            emptyTitle: a('accounts.entriesEmptyTitle'),
            emptyDetail: a('accounts.entriesEmptyDetail'),
            errorTitle: t('table.errorTitle'),
            errorDetail: t('table.errorDetail'),
            retry: t('common.retry'),
            pageStatus: `${t('table.page')} 1`,
            sortAscending: t('table.sortAscending'),
            sortDescending: t('table.sortDescending'),
          }}
        />
      </section>

      <section aria-labelledby="closings-heading" className="space-y-3">
        <h2 id="closings-heading" className="text-sm font-medium">
          {a('accounts.closingsHeading')}
        </h2>
        <DataTable<ClosingRow>
          caption={a('accounts.closingsCaption')}
          columns={closingColumns}
          data={closingQuery.data?.items ?? []}
          getRowId={(row) => row.closingId}
          loading={closingQuery.isPending}
          error={closingQuery.error}
          onRetry={() => void closingQuery.refetch()}
          page={SINGLE_PAGE}
          onPageChange={() => undefined}
          sort={null}
          onSortChange={() => undefined}
          labels={{
            columns: t('table.columns'),
            previous: t('table.previous'),
            next: t('table.next'),
            emptyTitle: a('accounts.closingsEmptyTitle'),
            emptyDetail: a('accounts.closingsEmptyDetail'),
            errorTitle: t('table.errorTitle'),
            errorDetail: t('table.errorDetail'),
            retry: t('common.retry'),
            pageStatus: `${t('table.page')} 1`,
            sortAscending: t('table.sortAscending'),
            sortDescending: t('table.sortDescending'),
          }}
        />
      </section>

      <Dialog
        open={entryOpen}
        onOpenChange={setEntryOpen}
        title={a('accounts.recordCashTitle')}
        description={a('accounts.recordCashDetail')}
        closeLabel={t('common.close')}
      >
        <Form<CashEntryForm>
          form={entryForm}
          onSubmit={(values) => entryMutation.mutateAsync(values).then(() => undefined)}
          {...(entryMutation.error === null ? {} : { submitError: messageOf(entryMutation.error) })}
        >
          <div className="space-y-4">
            <SelectField<CashEntryForm>
              name="kind"
              label={a('accounts.fieldKind')}
              required
              options={[
                { value: 'cash_in', label: a('accounts.kindCashIn') },
                { value: 'cash_out', label: a('accounts.kindCashOut') },
                { value: 'petty_cash', label: a('accounts.kindPettyCash') },
              ]}
              placeholder={a('accounts.fieldKind')}
            />
            <SelectField<CashEntryForm>
              name="walletId"
              label={a('accounts.fieldWallet')}
              required
              options={walletOptions}
              placeholder={a('accounts.pickWallet')}
            />
            <SelectField<CashEntryForm>
              name="categoryAccountId"
              label={a('accounts.fieldCategory')}
              required
              options={categoryOptions}
              placeholder={a('accounts.pickCategory')}
            />
            <MoneyField<CashEntryForm>
              name="amountPoisha"
              label={a('accounts.fieldAmount')}
              required
            />
            <TextField<CashEntryForm> name="memo" label={a('accounts.fieldMemo')} />
            {kind === 'petty_cash' ? (
              /*
               * The receipt is uploaded on the entry screen in M08's console slice
               * as a follow-up: the server already requires a private,
               * petty-cash-purpose file id and refuses without one, and wiring
               * `<FileUpload>` here needs the ticket flow this page does not yet
               * carry. Until then the hint says what the server will ask for,
               * rather than the form pretending the field is optional.
               */
              <p className="text-xs text-muted-foreground">{a('accounts.receiptHint')}</p>
            ) : null}
          </div>
          <div className="mt-5 flex justify-end">
            <Button type="submit" disabled={entryMutation.isPending}>
              {entryMutation.isPending ? a('accounts.saving') : a('accounts.save')}
            </Button>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={closingOpen}
        onOpenChange={setClosingOpen}
        title={a('accounts.countCashTitle')}
        description={a('accounts.countCashDetail')}
        closeLabel={t('common.close')}
      >
        <Form<ClosingForm>
          form={closingForm}
          onSubmit={(values) => closingMutation.mutateAsync(values).then(() => undefined)}
          {...(closingMutation.error === null
            ? {}
            : { submitError: messageOf(closingMutation.error) })}
        >
          <div className="space-y-4">
            <SelectField<ClosingForm>
              name="walletId"
              label={a('accounts.fieldWallet')}
              required
              options={walletOptions}
              placeholder={a('accounts.pickWallet')}
            />
            <MoneyField<ClosingForm>
              name="countedPoisha"
              label={a('accounts.fieldCounted')}
              required
            />
            <TextField<ClosingForm> name="memo" label={a('accounts.fieldMemo')} />
          </div>
          <div className="mt-5 flex justify-end">
            <Button type="submit" disabled={closingMutation.isPending}>
              {closingMutation.isPending ? a('accounts.saving') : a('accounts.save')}
            </Button>
          </div>
        </Form>
      </Dialog>
    </div>
  );
}

function WalletCard({
  wallet,
  locale,
  label,
}: {
  readonly wallet: WalletRow;
  readonly locale: 'en' | 'bn';
  readonly label: (key: AccountsMessageKey) => string;
}) {
  const Icon = WALLET_ICONS[wallet.subtype] ?? Wallet;
  const kindKey = WALLET_LABELS[wallet.subtype];

  return (
    <article className="rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Icon aria-hidden="true" className="size-4 text-muted-foreground" />
          {wallet.name}
        </div>
        {wallet.isActive ? null : (
          <StatusBadge tone="neutral">{label('accounts.inactive')}</StatusBadge>
        )}
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {kindKey === undefined ? wallet.subtype : label(kindKey)}
        {wallet.accountRefMasked === null ? '' : ` · ${wallet.accountRefMasked}`}
      </p>
      <p className="mt-2 text-lg font-semibold">
        <Money poisha={wallet.balancePoisha} locale={locale} />
      </p>
    </article>
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

/** The server's message, never a stack trace, and never the raw error object (§23). */
function messageOf(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'The server could not be reached.';
}
