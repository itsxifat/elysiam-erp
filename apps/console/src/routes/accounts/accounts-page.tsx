import { zodResolver } from '@hookform/resolvers/zod';
import {
  Button,
  DataTable,
  Dialog,
  FileUpload,
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
import { Banknote, Landmark, Plus, Smartphone, Wallet } from 'lucide-react';
import { scopeFilterFor, uniformBranchScope } from '@elysium/contracts';
import { useId, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { z } from 'zod';

import { useAbility, useSession } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import { ApiError } from '../../api.js';
import {
  dhakaMonthStart,
  dhakaToday,
  finalizeUpload,
  listCashEntries,
  listCategories,
  listClosings,
  listWallets,
  profitAndLoss,
  receiptUploadTicket,
  recordCashEntry,
  recordClosing,
  type CashEntryRow,
  type ClosingRow,
  type WalletRow,
} from './api.js';
import { AccountsNav } from './accounts-parts.js';
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

/**
 * The cash-entry form, built with its one translated message.
 *
 * A function rather than a constant because the kit's `FormField` shows the
 * schema's message as written, and "attach the receipt" is a sentence a person
 * reads — so it arrives already in the screen's language. The server's rule is
 * the same one (`wallets.schemas.ts` refuses petty cash without a receipt); this
 * catches it before the round trip.
 */
function cashEntryFormSchema(receiptRequired: string, cashOutNeedsReceipt: boolean) {
  return z
    .object({
      walletId: z.string().uuid(),
      kind: z.enum(['cash_in', 'cash_out', 'petty_cash']),
      categoryAccountId: z.string().uuid(),
      amountPoisha: z.string().regex(/^[1-9]\d*$/),
      receiptFileId: z.string().uuid().optional(),
      memo: z.string().trim().max(500).optional(),
    })
    .superRefine((value, context) => {
      if (needsReceipt(value.kind, cashOutNeedsReceipt) && value.receiptFileId === undefined) {
        context.addIssue({ code: 'custom', path: ['receiptFileId'], message: receiptRequired });
      }
    });
}
type CashEntryForm = z.infer<ReturnType<typeof cashEntryFormSchema>>;

/**
 * Whether this movement needs a receipt: petty cash always, and a cash out when the person
 * reaches only their own branch's wallets (M30, D-362), as the server rules.
 */
function needsReceipt(kind: string | undefined, cashOutNeedsReceipt: boolean): boolean {
  return kind === 'petty_cash' || (kind === 'cash_out' && cashOutNeedsReceipt);
}

/** A blank entry: what the dialog shows every time it opens. */
const ENTRY_DEFAULTS = { kind: 'cash_in', amountPoisha: '', memo: '' } as const;

/** Photos and scans: the types the files module accepts for a receipt. */
const RECEIPT_TYPES = 'image/jpeg,image/png,image/webp,application/pdf';

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
  const session = useSession();
  /*
   * A branch manager's cash out follows petty cash's rules (D-362). The scope comes from
   * the shared matrix, so the form asks for the receipt exactly where the server will.
   */
  const cashOutNeedsReceipt =
    session.context !== null &&
    scopeFilterFor(
      {
        roles: session.roles,
        isSuperAdmin: session.context.isSuperAdmin,
        userId: session.context.userId,
        branchIds: session.context.branchIds,
        branchIdsByRole: uniformBranchScope(session.roles, session.context.branchIds),
      },
      'update',
      'Wallet',
    ).kind !== 'all';
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

  const receiptRequired = a('accounts.receiptRequired');
  const entrySchema = useMemo(
    () => cashEntryFormSchema(receiptRequired, cashOutNeedsReceipt),
    [receiptRequired, cashOutNeedsReceipt],
  );
  const entryForm = useForm<CashEntryForm>({
    resolver: zodResolver(entrySchema),
    defaultValues: ENTRY_DEFAULTS,
  });
  const receiptLabelId = useId();
  const receiptError = entryForm.formState.errors.receiptFileId?.message;
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
        ...(values.receiptFileId === undefined ? {} : { receiptFileId: values.receiptFileId }),
        ...(values.memo === undefined || values.memo === '' ? {} : { memo: values.memo }),
      }),
    onSuccess: async (result) => {
      setEntryOpen(false);
      setNotice(result.status === 'pending_approval' ? 'accounts.heldNotice' : null);
      entryForm.reset(ENTRY_DEFAULTS);
      await queryClient.invalidateQueries({ queryKey: ['accounts'] });
    },
  });

  /*
   * The form outlives the dialog (Radix unmounts the content, not the form), so
   * every open and every close starts it again. Otherwise a receipt uploaded for
   * an entry that was then abandoned stays in the form while the picker comes
   * back empty, and posts as the evidence for the next, different entry.
   */
  const setEntryDialog = (open: boolean) => {
    entryForm.reset(ENTRY_DEFAULTS);
    entryMutation.reset();
    setEntryOpen(open);
  };

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
      <PageHeader
        title={a('accounts.title')}
        description={a('accounts.subtitle')}
        actions={
          <PermissionGate allowed={mayWrite}>
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setClosingOpen(true)}>
                {a('accounts.countCash')}
              </Button>
              <Button onClick={() => setEntryDialog(true)}>
                <Plus aria-hidden="true" />
                {a('accounts.recordCash')}
              </Button>
            </div>
          </PermissionGate>
        }
        tabs={<AccountsNav />}
      />

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
          <h2 id="wallets-heading" className="text-base font-semibold tracking-tight">
            {a('accounts.walletsHeading')}
          </h2>
          <div className="text-right">
            <p className="text-xs text-muted-foreground">{a('accounts.totalCash')}</p>
            <p className="text-xl font-medium">
              <Money poisha={walletQuery.data?.totalPoisha ?? '0'} locale={locale} compact />
            </p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
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
          <h2 id="pnl-heading" className="text-base font-semibold tracking-tight">
            {a('accounts.pnlHeading')}
          </h2>
          <dl className="grid overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-border">
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
        <h2 id="entries-heading" className="text-base font-semibold tracking-tight">
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
        <h2 id="closings-heading" className="text-base font-semibold tracking-tight">
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
        onOpenChange={setEntryDialog}
        title={a('accounts.recordCashTitle')}
        description={a('accounts.recordCashDetail')}
        closeLabel={t('common.close')}
      >
        <Form<CashEntryForm>
          form={entryForm}
          onSubmit={(values) => entryMutation.mutateAsync(values).then(() => undefined)}
          {...(entryMutation.error === null
            ? {}
            : { submitError: messageOf(entryMutation.error, t('error.unreachable')) })}
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
            {/*
             * Offered for every movement and required for petty cash, which is the
             * server's rule too. Private and `petty-cash-receipt`, the only kind of
             * file an entry accepts: the files module reads that purpose through
             * `Wallet` and refuses to make it public, so the photo is seen by the
             * people who approve and audit the spend and by nobody holding a
             * guessable URL.
             */}
            <div role="group" aria-labelledby={receiptLabelId} className="space-y-1.5">
              <p id={receiptLabelId} className="text-sm font-medium text-foreground">
                {a('accounts.fieldReceipt')}
                {needsReceipt(kind, cashOutNeedsReceipt) ? (
                  <span className="ml-0.5 text-destructive" aria-hidden="true">
                    *
                  </span>
                ) : null}
              </p>
              <FileUpload
                accept={RECEIPT_TYPES}
                createTicket={receiptUploadTicket}
                finalize={finalizeUpload}
                onUploaded={(file) => {
                  entryForm.setValue('receiptFileId', file.id, { shouldValidate: true });
                }}
                onRemoved={() => {
                  entryForm.setValue('receiptFileId', undefined, { shouldValidate: true });
                }}
                labels={{
                  choose: a('accounts.receiptChoose'),
                  uploading: t('upload.uploading'),
                  uploaded: t('upload.uploaded'),
                  remove: t('upload.remove'),
                  failed: t('upload.failed'),
                  tooLarge: t('upload.tooLarge'),
                }}
              />
              <p className="text-xs text-muted-foreground">
                {a(
                  needsReceipt(kind, cashOutNeedsReceipt)
                    ? 'accounts.receiptHint'
                    : 'accounts.receiptOptionalHint',
                )}
              </p>
              {receiptError === undefined ? null : (
                <p role="alert" className="text-xs font-medium text-destructive">
                  {receiptError}
                </p>
              )}
            </div>
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
            : { submitError: messageOf(closingMutation.error, t('error.unreachable')) })}
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
  readonly locale: 'en';
  readonly label: (key: AccountsMessageKey) => string;
}) {
  const Icon = WALLET_ICONS[wallet.subtype] ?? Wallet;
  const kindKey = WALLET_LABELS[wallet.subtype];

  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
            <Icon aria-hidden="true" className="size-4" />
          </span>
          {/* The wallet's own history: every line, with what it was against. */}
          <Link
            to="/accounts/wallets/$accountId"
            params={{ accountId: wallet.ledgerAccountId }}
            aria-label={`${label('accounts.book.open')}: ${wallet.name}`}
            className="rounded-sm underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {wallet.name}
          </Link>
        </div>
        {wallet.isActive ? null : (
          <StatusBadge tone="neutral">{label('accounts.inactive')}</StatusBadge>
        )}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        {kindKey === undefined ? wallet.subtype : label(kindKey)}
        {wallet.accountRefMasked === null ? '' : ` · ${wallet.accountRefMasked}`}
      </p>
      <p className="mt-1 text-xl font-medium">
        <Money poisha={wallet.balancePoisha} locale={locale} align="start" compact />
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
  readonly locale: 'en';
}) {
  return (
    <div className="px-5 py-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-medium">
        <Money poisha={poisha} locale={locale} align="start" compact />
      </dd>
    </div>
  );
}

/** The server's message, never a stack trace, and never the raw error object (§23). */
function messageOf(error: unknown, unreachable: string): string {
  if (error instanceof ApiError) return error.message;
  // Translated by the caller: this sentence was the one English string on the page.
  return unreachable;
}
