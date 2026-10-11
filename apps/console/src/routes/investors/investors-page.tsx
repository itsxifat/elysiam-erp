import type { MessageKey } from '@elysium/i18n';
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
import { useMemo, useState } from 'react';
import { useForm } from 'react-hook-form';
import { z } from 'zod';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import { ApiError } from '../../api.js';
import {
  createInvestor,
  declareDistribution,
  linkInvestorLogin,
  listDistributions,
  listInvestorLogins,
  listInvestors,
  listWalletAccounts,
  listWithdrawals,
  payWithdrawal,
  recordInvestment,
  requestWithdrawal,
  reviewWithdrawal,
  type DistributionRow,
  type InvestorRow,
  type WithdrawalRow,
} from './api.js';
import { useInvestorsT, type InvestorsMessageKey } from './messages.js';
import { bpsFromPercent, dhakaToday, lastFinishedMonth, percentOfBps } from './share.js';

/**
 * The Investors screen (M25).
 *
 * Four things on this page are decisions rather than layout:
 *
 * 1. **Every figure on it is derived.** Capital, locked capital and profit owed all
 *    come from sums over posted journals on the server; nothing is cached here and
 *    nothing is added up in the browser. A screen that summed the rows it happened
 *    to have fetched would disagree with the ledger the moment a filter or a page
 *    boundary got involved.
 * 2. **A declared distribution is shown as waiting, not as done.** Nothing posts
 *    until a checker decides, so the row says "waiting for a checker" and no
 *    position moves. Showing it as declared would make the screen disagree with the
 *    ledger on purpose.
 * 3. **The withdrawal actions follow the state, one step each.** Review appears on
 *    a requested row, Pay on an approved one, and neither appears on anything else
 *    — the server refuses out-of-order calls anyway, and a button that produces a
 *    409 teaches people to distrust the screen.
 * 4. **The same page serves an investor and the finance team.** An investor holds
 *    `read Investor` at `own` scope, so the list they see has one row — their own —
 *    and every action is hidden behind `PermissionGate`. The server is the only
 *    real check; this is what stops them being offered something they cannot do.
 */

const investorFormSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z][0-9A-Za-z-]{0,31}$/),
  name: z.string().trim().min(1).max(160),
  // Percent in the form, basis points on the wire: 12.5% is exact as 1250 and
  // inexact as a float, which is the same reason money is poisha.
  sharePercent: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/),
  joinedOn: z.string(),
  phone: z.string().trim().optional(),
  email: z.string().trim().optional(),
  notes: z.string().trim().max(2_000).optional(),
});
type InvestorForm = z.infer<typeof investorFormSchema>;

const investmentFormSchema = z.object({
  investorId: z.string().uuid(),
  walletAccountId: z.string().uuid(),
  amountPoisha: z.string().regex(/^[1-9]\d*$/),
  lockInUntil: z.string().optional(),
  terms: z.string().trim().max(2_000).optional(),
  memo: z.string().trim().max(500).optional(),
});
type InvestmentForm = z.infer<typeof investmentFormSchema>;

const distributionFormSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  totalPoisha: z.string().regex(/^[1-9]\d*$/),
  basis: z.enum(['share_bps', 'capital']),
  memo: z.string().trim().max(500).optional(),
});
type DistributionForm = z.infer<typeof distributionFormSchema>;

const withdrawalFormSchema = z.object({
  investorId: z.string().uuid(),
  kind: z.enum(['capital', 'profit']),
  amountPoisha: z.string().regex(/^[1-9]\d*$/),
  reason: z.string().trim().max(500).optional(),
});
type WithdrawalForm = z.infer<typeof withdrawalFormSchema>;

/** The portal sign-in an investor reads their own rows through (D-419). */
const linkFormSchema = z.object({
  userId: z.string().min(1),
});
type LinkForm = z.infer<typeof linkFormSchema>;

const reviewFormSchema = z.object({
  walletAccountId: z.string().uuid(),
  note: z.string().trim().max(500).optional(),
});
type ReviewForm = z.infer<typeof reviewFormSchema>;

/**
 * One page, no pager.
 *
 * Every table here shows a bounded set — an org has a handful of investors, a
 * distribution a month, and the server caps the rest — so there is nothing to page
 * through. `total: null` rather than a count, because the endpoints do not return
 * one and a fabricated total is worse than none.
 */
const SINGLE_PAGE = { page: 1, pageSize: 500, total: null, hasNext: false } as const;

const DISTRIBUTION_STATUS: Record<DistributionRow['status'], InvestorsMessageKey> = {
  pending_approval: 'investors.statusPendingApproval',
  declared: 'investors.statusDeclared',
  rejected: 'investors.statusRejected',
};

const WITHDRAWAL_STATUS: Record<WithdrawalRow['status'], InvestorsMessageKey> = {
  requested: 'investors.statusRequested',
  reviewed: 'investors.statusReviewed',
  approved: 'investors.statusApproved',
  paid: 'investors.statusPaid',
  rejected: 'investors.statusRejected',
};

export function InvestorsPage() {
  const ability = useAbility();
  const t = useT();
  const a = useInvestorsT();
  const { locale } = useLocale();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Investor');
  const mayRecord = ability.can('create', 'Investor');
  const mayDecide = ability.can('update', 'Investor');
  /*
   * `read LedgerReport`, not `read Investor`, for the distributions section — the
   * same distinction M05's navigation makes for Accounts. A distribution is the
   * org's profit rather than one investor's position, so the server refuses anyone
   * whose reach is narrower than the org, and `LedgerReport` is the grant §6 gives
   * to exactly those org-wide finance roles: org_admin and accounts hold it, an
   * investor holds nothing of the kind. Asking for it as an investor would be a
   * guaranteed 403 rendered as a broken table.
   */
  const seesOrgFinance = ability.can('read', 'LedgerReport');

  const [addOpen, setAddOpen] = useState(false);
  const [capitalOpen, setCapitalOpen] = useState(false);
  const [declareOpen, setDeclareOpen] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);
  const [reviewing, setReviewing] = useState<WithdrawalRow | null>(null);
  const [linking, setLinking] = useState<InvestorRow | null>(null);
  const [notice, setNotice] = useState<InvestorsMessageKey | null>(null);

  const investorQuery = useQuery({
    queryKey: ['investors', 'list'],
    queryFn: () => listInvestors(true),
    enabled: mayRead,
  });
  const distributionQuery = useQuery({
    queryKey: ['investors', 'distributions'],
    queryFn: listDistributions,
    enabled: seesOrgFinance,
  });
  const withdrawalQuery = useQuery({
    queryKey: ['investors', 'withdrawals'],
    queryFn: () => listWithdrawals(),
    enabled: mayRead,
  });
  /*
   * `update Investor`, the grant the link itself needs; loaded only while the dialog is open,
   * so a page visit by anyone else asks for nothing it would be refused.
   */
  const loginQuery = useQuery({
    queryKey: ['investors', 'login-options'],
    queryFn: listInvestorLogins,
    enabled: mayDecide && linking !== null,
  });
  const walletQuery = useQuery({
    queryKey: ['investors', 'wallet-accounts'],
    queryFn: listWalletAccounts,
    // `create Investor`, which an investor does not hold: asking for it as them
    // would be a guaranteed 403 on every page load.
    enabled: mayRecord,
  });

  // Memoized rather than defaulted inline: `?? []` is a new array on every render,
  // so every `useMemo` below it would recompute and the React Compiler says so.
  const investors = useMemo(() => investorQuery.data?.items ?? [], [investorQuery.data]);
  const activeInvestors = useMemo(
    () => investors.filter((investor) => investor.status === 'active'),
    [investors],
  );

  const totals = useMemo(
    () =>
      investors.reduce(
        (sum, investor) => ({
          // Strings in, string out: BigInt, never Number. A crore-scale total is
          // past 2^53 and a float would drop its last digits silently.
          capital: sum.capital + BigInt(investor.position.capitalPoisha),
          payable: sum.payable + BigInt(investor.position.payablePoisha),
          locked: sum.locked + BigInt(investor.position.lockedPoisha),
        }),
        { capital: 0n, payable: 0n, locked: 0n },
      ),
    [investors],
  );

  const investorForm = useForm<InvestorForm>({
    resolver: zodResolver(investorFormSchema),
    defaultValues: { sharePercent: '0', joinedOn: dhakaToday(), code: '', name: '' },
  });
  const capitalForm = useForm<InvestmentForm>({
    resolver: zodResolver(investmentFormSchema),
    defaultValues: { amountPoisha: '', memo: '' },
  });
  const declareForm = useForm<DistributionForm>({
    resolver: zodResolver(distributionFormSchema),
    defaultValues: { month: lastFinishedMonth(), totalPoisha: '', basis: 'share_bps', memo: '' },
  });
  const withdrawalForm = useForm<WithdrawalForm>({
    resolver: zodResolver(withdrawalFormSchema),
    defaultValues: { kind: 'profit', amountPoisha: '', reason: '' },
  });
  const linkForm = useForm<LinkForm>({
    resolver: zodResolver(linkFormSchema),
    defaultValues: { userId: '' },
  });
  const reviewForm = useForm<ReviewForm>({
    resolver: zodResolver(reviewFormSchema),
    defaultValues: { note: '' },
  });

  /**
   * Every mutation invalidates rather than patching the cache.
   *
   * A position is derived on the server, and a declaration that is waiting has moved
   * nothing at all — so the only correct next value for every query on this page is
   * the one the server computes. Patching a balance locally is how a screen starts
   * disagreeing with the ledger.
   */
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['investors'] });
  };

  const addMutation = useMutation({
    mutationFn: (values: InvestorForm) =>
      createInvestor({
        code: values.code,
        name: values.name,
        joinedOn: values.joinedOn,
        shareBps: bpsFromPercent(values.sharePercent),
        ...(values.phone === undefined || values.phone === '' ? {} : { phone: values.phone }),
        ...(values.email === undefined || values.email === '' ? {} : { email: values.email }),
        ...(values.notes === undefined || values.notes === '' ? {} : { notes: values.notes }),
      }),
    onSuccess: async () => {
      setAddOpen(false);
      investorForm.reset({ sharePercent: '0', joinedOn: dhakaToday(), code: '', name: '' });
      await refresh();
    },
  });

  const capitalMutation = useMutation({
    mutationFn: (values: InvestmentForm) =>
      recordInvestment({
        investmentId: crypto.randomUUID(),
        investorId: values.investorId,
        walletAccountId: values.walletAccountId,
        amountPoisha: values.amountPoisha,
        ...(values.lockInUntil === undefined || values.lockInUntil === ''
          ? {}
          : { lockInUntil: values.lockInUntil }),
        ...(values.terms === undefined || values.terms === '' ? {} : { terms: values.terms }),
        ...(values.memo === undefined || values.memo === '' ? {} : { memo: values.memo }),
      }),
    onSuccess: async () => {
      setCapitalOpen(false);
      capitalForm.reset({ amountPoisha: '', memo: '' });
      await refresh();
    },
  });

  const declareMutation = useMutation({
    mutationFn: (values: DistributionForm) =>
      declareDistribution({
        distributionId: crypto.randomUUID(),
        month: values.month,
        totalPoisha: values.totalPoisha,
        basis: values.basis,
        ...(values.memo === undefined || values.memo === '' ? {} : { memo: values.memo }),
      }),
    onSuccess: async () => {
      setDeclareOpen(false);
      setNotice('investors.declaredNotice');
      declareForm.reset({
        month: lastFinishedMonth(),
        totalPoisha: '',
        basis: 'share_bps',
        memo: '',
      });
      await refresh();
    },
  });

  const requestMutation = useMutation({
    mutationFn: (values: WithdrawalForm) =>
      requestWithdrawal({
        withdrawalId: crypto.randomUUID(),
        investorId: values.investorId,
        kind: values.kind,
        amountPoisha: values.amountPoisha,
        ...(values.reason === undefined || values.reason === '' ? {} : { reason: values.reason }),
      }),
    onSuccess: async () => {
      setRequestOpen(false);
      withdrawalForm.reset({ kind: 'profit', amountPoisha: '', reason: '' });
      await refresh();
    },
  });

  const reviewMutation = useMutation({
    mutationFn: (values: ReviewForm & { withdrawalId: string }) =>
      reviewWithdrawal(values.withdrawalId, {
        walletAccountId: values.walletAccountId,
        ...(values.note === undefined || values.note === '' ? {} : { note: values.note }),
      }),
    onSuccess: async () => {
      setReviewing(null);
      setNotice('investors.reviewedNotice');
      reviewForm.reset({ note: '' });
      await refresh();
    },
  });

  const linkMutation = useMutation({
    mutationFn: (values: LinkForm & { investorId: string }) =>
      linkInvestorLogin(values.investorId, values.userId),
    onSuccess: async () => {
      setLinking(null);
      setNotice('investors.linkedNotice');
      linkForm.reset({ userId: '' });
      await refresh();
    },
  });

  const payMutation = useMutation({
    mutationFn: (withdrawalId: string) => payWithdrawal(withdrawalId),
    onSuccess: async () => {
      setNotice('investors.paidNotice');
      await refresh();
    },
  });

  const investorColumns = useMemo<readonly DataTableColumn<InvestorRow>[]>(() => {
    const column = dataTableColumns<InvestorRow>();
    return column.columns([
      column.accessor('code', {
        header: a('investors.colCode'),
        cell: (cell) => (
          <Link
            to="/investors/$investorId"
            params={{ investorId: cell.row.original.id }}
            className="font-medium text-primary underline-offset-4 hover:underline"
          >
            {cell.getValue()}
          </Link>
        ),
      }),
      column.accessor('name', { header: a('investors.colName') }),
      column.accessor('shareBps', {
        header: a('investors.colShare'),
        meta: { numeric: true },
        // Basis points are the stored unit; a person reads a percentage. Formatted
        // by integer division rather than `/ 100` and `toFixed`: the lint rule bans
        // binary rounding on anything that looks like an amount, and it is right to
        // — 1250 bps is exactly 12.50%, and a float is the only way to get that
        // wrong.
        cell: (cell) => percentOfBps(cell.getValue()),
      }),
      column.accessor((row) => row.position.capitalPoisha, {
        id: 'capital',
        header: a('investors.colCapital'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue<string>()} locale={locale} />,
      }),
      column.accessor((row) => row.position.lockedPoisha, {
        id: 'locked',
        header: a('investors.colLocked'),
        meta: { numeric: true },
        cell: (cell) => (
          <Money
            poisha={cell.getValue<string>()}
            locale={locale}
            className="text-muted-foreground"
          />
        ),
      }),
      column.accessor((row) => row.position.payablePoisha, {
        id: 'payable',
        header: a('investors.colPayable'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue<string>()} locale={locale} />,
      }),
      column.accessor('status', {
        header: a('investors.colStatus'),
        cell: (cell) => (
          <StatusBadge tone={cell.getValue() === 'active' ? 'success' : 'neutral'}>
            {a(cell.getValue() === 'active' ? 'investors.statusActive' : 'investors.statusExited')}
          </StatusBadge>
        ),
      }),
      column.display({
        id: 'portal',
        header: a('investors.colPortal'),
        cell: (cell) => {
          const row = cell.row.original;
          const linked = row.userId !== null;
          if (!mayDecide) {
            return (
              <span className="text-xs text-muted-foreground">
                {a(linked ? 'investors.portalLinked' : 'investors.portalNotLinked')}
              </span>
            );
          }
          return (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                linkForm.reset({ userId: row.userId ?? '' });
                linkMutation.reset();
                setLinking(row);
              }}
            >
              {a(linked ? 'investors.portalChange' : 'investors.portalLink')}
            </Button>
          );
        },
      }),
    ]) as readonly DataTableColumn<InvestorRow>[];
  }, [a, locale, mayDecide, linkForm, linkMutation]);

  const distributionColumns = useMemo<readonly DataTableColumn<DistributionRow>[]>(() => {
    const column = dataTableColumns<DistributionRow>();
    return column.columns([
      column.accessor('periodStartsOn', {
        header: a('investors.colPeriod'),
        cell: (cell) => cell.getValue().slice(0, 7),
      }),
      column.accessor('totalPoisha', {
        header: a('investors.colTotal'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('basis', {
        header: a('investors.colBasis'),
        cell: (cell) =>
          a(cell.getValue() === 'capital' ? 'investors.basisCapital' : 'investors.basisShare'),
      }),
      column.accessor('status', {
        header: a('investors.colStatus'),
        cell: (cell) => {
          const value = cell.getValue();
          return (
            <StatusBadge
              tone={
                value === 'declared'
                  ? 'success'
                  : value === 'pending_approval'
                    ? 'warning'
                    : 'neutral'
              }
            >
              {a(DISTRIBUTION_STATUS[value])}
            </StatusBadge>
          );
        },
      }),
    ]) as readonly DataTableColumn<DistributionRow>[];
  }, [a, locale]);

  const withdrawalColumns = useMemo<readonly DataTableColumn<WithdrawalRow>[]>(() => {
    const column = dataTableColumns<WithdrawalRow>();
    return column.columns([
      column.accessor('investorCode', { header: a('investors.colCode') }),
      column.accessor('kind', {
        header: a('investors.colKind'),
        cell: (cell) =>
          a(cell.getValue() === 'capital' ? 'investors.kindCapital' : 'investors.kindProfit'),
      }),
      column.accessor('amountPoisha', {
        header: a('investors.colAmount'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('status', {
        header: a('investors.colStatus'),
        cell: (cell) => {
          const value = cell.getValue();
          return (
            <StatusBadge
              tone={
                value === 'paid'
                  ? 'success'
                  : value === 'rejected'
                    ? 'neutral'
                    : value === 'approved'
                      ? 'info'
                      : 'warning'
              }
            >
              {a(WITHDRAWAL_STATUS[value])}
            </StatusBadge>
          );
        },
      }),
      column.display({
        id: 'actions',
        header: '',
        cell: (cell) => {
          const row = cell.row.original;
          if (!mayDecide) return null;
          // One action per state, and none on the rest: the server refuses
          // out-of-order calls, and a button that always 409s teaches people to
          // distrust the screen.
          if (row.status === 'requested') {
            return (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setReviewing(row);
                  reviewForm.reset({ note: '' });
                }}
              >
                {a('investors.review')}
              </Button>
            );
          }
          if (row.status === 'approved') {
            return (
              <Button
                size="sm"
                disabled={payMutation.isPending}
                onClick={() => payMutation.mutate(row.id)}
              >
                {payMutation.isPending ? a('investors.saving') : a('investors.pay')}
              </Button>
            );
          }
          return null;
        },
      }),
    ]) as readonly DataTableColumn<WithdrawalRow>[];
  }, [a, locale, mayDecide, payMutation, reviewForm]);

  if (!mayRead) {
    return (
      <PermissionGate
        allowed={false}
        explain={{ title: a('investors.deniedTitle'), detail: a('investors.deniedDetail') }}
      >
        {null}
      </PermissionGate>
    );
  }

  const investorOptions: readonly SelectOption[] = activeInvestors.map((investor) => ({
    value: investor.id,
    label: `${investor.code} · ${investor.name}`,
  }));
  /*
   * The sign-ins on offer: a person already linked to a different investor is shown but
   * cannot be chosen, because one login is one investor's view of their own rows.
   */
  const loginOptions: readonly SelectOption[] = (loginQuery.data?.items ?? []).map((login) => {
    const elsewhere = login.linkedInvestorId !== null && login.linkedInvestorId !== linking?.id;
    return {
      value: login.userId,
      label: `${login.name} · ${login.emailMasked}${
        elsewhere ? ` (${a('investors.portalLinkedElsewhere')})` : ''
      }`,
      disabled: elsewhere,
    };
  });
  const currentLogin = (loginQuery.data?.items ?? []).find(
    (login) => linking !== null && login.userId === linking.userId,
  );
  const walletOptions: readonly SelectOption[] = (walletQuery.data?.items ?? []).map((wallet) => ({
    value: wallet.id,
    label: `${wallet.code} · ${wallet.name}`,
  }));

  return (
    <div className="space-y-6">
      <PageHeader
        title={a('investors.title')}
        description={a('investors.subtitle')}
        actions={
          <PermissionGate allowed={mayRecord}>
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setAddOpen(true)}>
                {a('investors.add')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setCapitalOpen(true)}>
                {a('investors.recordCapital')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => setRequestOpen(true)}>
                {a('investors.request')}
              </Button>
              <Button size="sm" onClick={() => setDeclareOpen(true)}>
                {a('investors.declare')}
              </Button>
            </div>
          </PermissionGate>
        }
      />

      {notice === null ? null : (
        <p
          role="status"
          className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
        >
          {a(notice)}
        </p>
      )}

      <dl className="grid gap-3 sm:grid-cols-3">
        <Tile
          label={a('investors.totalCapital')}
          poisha={totals.capital.toString()}
          locale={locale}
        />
        <Tile
          label={a('investors.totalPayable')}
          poisha={totals.payable.toString()}
          locale={locale}
        />
        <Tile
          label={a('investors.totalLocked')}
          poisha={totals.locked.toString()}
          locale={locale}
        />
      </dl>

      <section aria-labelledby="investors-heading" className="space-y-3">
        <h2 id="investors-heading" className="text-sm font-medium">
          {a('investors.listHeading')}
        </h2>
        <DataTable<InvestorRow>
          caption={a('investors.listCaption')}
          columns={investorColumns}
          data={investors}
          getRowId={(row) => row.id}
          loading={investorQuery.isPending}
          error={investorQuery.error}
          onRetry={() => void investorQuery.refetch()}
          page={SINGLE_PAGE}
          onPageChange={() => undefined}
          sort={null}
          onSortChange={() => undefined}
          labels={tableLabels(t, a, 'investors.emptyTitle', 'investors.emptyDetail')}
        />
      </section>

      {!seesOrgFinance ? null : (
        <section aria-labelledby="distributions-heading" className="space-y-3">
          <h2 id="distributions-heading" className="text-sm font-medium">
            {a('investors.distributionsHeading')}
          </h2>
          <DataTable<DistributionRow>
            caption={a('investors.distributionsCaption')}
            columns={distributionColumns}
            data={distributionQuery.data?.items ?? []}
            getRowId={(row) => row.id}
            loading={distributionQuery.isPending}
            error={distributionQuery.error}
            onRetry={() => void distributionQuery.refetch()}
            page={SINGLE_PAGE}
            onPageChange={() => undefined}
            sort={null}
            onSortChange={() => undefined}
            labels={tableLabels(
              t,
              a,
              'investors.distributionsEmptyTitle',
              'investors.distributionsEmptyDetail',
            )}
          />
        </section>
      )}

      <section aria-labelledby="withdrawals-heading" className="space-y-3">
        <h2 id="withdrawals-heading" className="text-sm font-medium">
          {a('investors.withdrawalsHeading')}
        </h2>
        <DataTable<WithdrawalRow>
          caption={a('investors.withdrawalsCaption')}
          columns={withdrawalColumns}
          data={withdrawalQuery.data?.items ?? []}
          getRowId={(row) => row.id}
          loading={withdrawalQuery.isPending}
          error={withdrawalQuery.error}
          onRetry={() => void withdrawalQuery.refetch()}
          page={SINGLE_PAGE}
          onPageChange={() => undefined}
          sort={null}
          onSortChange={() => undefined}
          labels={tableLabels(
            t,
            a,
            'investors.withdrawalsEmptyTitle',
            'investors.withdrawalsEmptyDetail',
          )}
        />
      </section>

      <Dialog
        open={addOpen}
        onOpenChange={setAddOpen}
        title={a('investors.addTitle')}
        description={a('investors.addDetail')}
        closeLabel={t('common.close')}
      >
        <Form<InvestorForm>
          form={investorForm}
          onSubmit={(values) => addMutation.mutateAsync(values).then(() => undefined)}
          {...(addMutation.error === null ? {} : { submitError: messageOf(addMutation.error, t) })}
        >
          <div className="space-y-4">
            <TextField<InvestorForm> name="code" label={a('investors.fieldCode')} required />
            <TextField<InvestorForm> name="name" label={a('investors.fieldName')} required />
            <TextField<InvestorForm>
              name="sharePercent"
              label={a('investors.fieldShare')}
              required
            />
            <TextField<InvestorForm>
              name="joinedOn"
              label={a('investors.fieldJoinedOn')}
              required
            />
            <TextField<InvestorForm>
              name="phone"
              label={a('investors.fieldPhone')}
              hint={a('investors.phoneHint')}
            />
            <TextField<InvestorForm> name="email" label={a('investors.fieldEmail')} />
            <TextField<InvestorForm> name="notes" label={a('investors.fieldNotes')} />
          </div>
          <div className="mt-5 flex justify-end">
            <Button type="submit" disabled={addMutation.isPending}>
              {addMutation.isPending ? a('investors.saving') : a('investors.save')}
            </Button>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={capitalOpen}
        onOpenChange={setCapitalOpen}
        title={a('investors.recordCapitalTitle')}
        description={a('investors.recordCapitalDetail')}
        closeLabel={t('common.close')}
      >
        <Form<InvestmentForm>
          form={capitalForm}
          onSubmit={(values) => capitalMutation.mutateAsync(values).then(() => undefined)}
          {...(capitalMutation.error === null
            ? {}
            : { submitError: messageOf(capitalMutation.error, t) })}
        >
          <div className="space-y-4">
            <SelectField<InvestmentForm>
              name="investorId"
              label={a('investors.fieldInvestor')}
              required
              options={investorOptions}
              placeholder={a('investors.pickInvestor')}
            />
            <SelectField<InvestmentForm>
              name="walletAccountId"
              label={a('investors.fieldWallet')}
              required
              options={walletOptions}
              placeholder={a('investors.pickWallet')}
            />
            <MoneyField<InvestmentForm>
              name="amountPoisha"
              label={a('investors.fieldAmount')}
              required
            />
            <TextField<InvestmentForm>
              name="lockInUntil"
              label={a('investors.fieldLockIn')}
              hint={a('investors.lockInHint')}
            />
            <TextField<InvestmentForm> name="terms" label={a('investors.fieldTerms')} />
            <TextField<InvestmentForm> name="memo" label={a('investors.fieldMemo')} />
          </div>
          <div className="mt-5 flex justify-end">
            <Button type="submit" disabled={capitalMutation.isPending}>
              {capitalMutation.isPending ? a('investors.saving') : a('investors.save')}
            </Button>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={declareOpen}
        onOpenChange={setDeclareOpen}
        title={a('investors.declareTitle')}
        description={a('investors.declareDetail')}
        closeLabel={t('common.close')}
      >
        <Form<DistributionForm>
          form={declareForm}
          onSubmit={(values) => declareMutation.mutateAsync(values).then(() => undefined)}
          {...(declareMutation.error === null
            ? {}
            : { submitError: messageOf(declareMutation.error, t) })}
        >
          <div className="space-y-4">
            <TextField<DistributionForm> name="month" label={a('investors.fieldMonth')} required />
            <MoneyField<DistributionForm>
              name="totalPoisha"
              label={a('investors.fieldAmount')}
              required
            />
            <SelectField<DistributionForm>
              name="basis"
              label={a('investors.fieldBasis')}
              required
              options={[
                { value: 'share_bps', label: a('investors.basisShare') },
                { value: 'capital', label: a('investors.basisCapital') },
              ]}
              placeholder={a('investors.fieldBasis')}
            />
            <TextField<DistributionForm> name="memo" label={a('investors.fieldMemo')} />
          </div>
          <div className="mt-5 flex justify-end">
            <Button type="submit" disabled={declareMutation.isPending}>
              {declareMutation.isPending ? a('investors.saving') : a('investors.save')}
            </Button>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={requestOpen}
        onOpenChange={setRequestOpen}
        title={a('investors.requestTitle')}
        description={a('investors.requestDetail')}
        closeLabel={t('common.close')}
      >
        <Form<WithdrawalForm>
          form={withdrawalForm}
          onSubmit={(values) => requestMutation.mutateAsync(values).then(() => undefined)}
          {...(requestMutation.error === null
            ? {}
            : { submitError: messageOf(requestMutation.error, t) })}
        >
          <div className="space-y-4">
            <SelectField<WithdrawalForm>
              name="investorId"
              label={a('investors.fieldInvestor')}
              required
              options={investorOptions}
              placeholder={a('investors.pickInvestor')}
            />
            <SelectField<WithdrawalForm>
              name="kind"
              label={a('investors.colKind')}
              required
              options={[
                { value: 'profit', label: a('investors.kindProfit') },
                { value: 'capital', label: a('investors.kindCapital') },
              ]}
              placeholder={a('investors.colKind')}
            />
            <MoneyField<WithdrawalForm>
              name="amountPoisha"
              label={a('investors.fieldAmount')}
              required
            />
            <TextField<WithdrawalForm> name="reason" label={a('investors.fieldReason')} />
          </div>
          <div className="mt-5 flex justify-end">
            <Button type="submit" disabled={requestMutation.isPending}>
              {requestMutation.isPending ? a('investors.saving') : a('investors.save')}
            </Button>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={linking !== null}
        onOpenChange={(open) => {
          if (!open) setLinking(null);
        }}
        title={a('investors.portalTitle')}
        description={a('investors.portalDetail')}
        closeLabel={t('common.close')}
      >
        <Form<LinkForm>
          form={linkForm}
          onSubmit={(values) =>
            linkMutation
              .mutateAsync({ ...values, investorId: linking?.id ?? '' })
              .then(() => undefined)
          }
          {...(linkMutation.error === null
            ? {}
            : { submitError: messageOf(linkMutation.error, t) })}
        >
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground" role="status">
              {linking === null
                ? null
                : `${linking.code} · ${linking.name}: ${
                    linking.userId === null
                      ? a('investors.portalNotLinked')
                      : currentLogin === undefined
                        ? a('investors.portalLinked')
                        : `${a('investors.portalLinked')} (${currentLogin.name} · ${currentLogin.emailMasked})`
                  }`}
            </p>
            <SelectField<LinkForm>
              name="userId"
              label={a('investors.fieldPortalLogin')}
              required
              options={loginOptions}
              placeholder={a('investors.pickPortalLogin')}
              hint={a('investors.portalHint')}
            />
            {loginQuery.isSuccess && loginOptions.length === 0 ? (
              <p className="text-sm text-muted-foreground">{a('investors.portalNoLogins')}</p>
            ) : null}
          </div>
          <div className="mt-5 flex justify-end">
            <Button type="submit" disabled={linkMutation.isPending}>
              {linkMutation.isPending ? a('investors.saving') : a('investors.save')}
            </Button>
          </div>
        </Form>
      </Dialog>

      <Dialog
        open={reviewing !== null}
        onOpenChange={(open) => {
          if (!open) setReviewing(null);
        }}
        title={a('investors.reviewTitle')}
        description={a('investors.reviewDetail')}
        closeLabel={t('common.close')}
      >
        <Form<ReviewForm>
          form={reviewForm}
          onSubmit={(values) =>
            reviewMutation
              .mutateAsync({ ...values, withdrawalId: reviewing?.id ?? '' })
              .then(() => undefined)
          }
          {...(reviewMutation.error === null
            ? {}
            : { submitError: messageOf(reviewMutation.error, t) })}
        >
          <div className="space-y-4">
            <SelectField<ReviewForm>
              name="walletAccountId"
              label={a('investors.fieldWallet')}
              required
              options={walletOptions}
              placeholder={a('investors.pickWallet')}
            />
            <TextField<ReviewForm> name="note" label={a('investors.fieldReason')} />
          </div>
          <div className="mt-5 flex justify-end">
            <Button type="submit" disabled={reviewMutation.isPending}>
              {reviewMutation.isPending ? a('investors.saving') : a('investors.review')}
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
  readonly locale: 'en';
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

/** The table chrome every list on this page shares, so the strings stay in one place. */
export function tableLabels(
  t: ReturnType<typeof useT>,
  a: (key: InvestorsMessageKey) => string,
  emptyTitle: InvestorsMessageKey,
  emptyDetail: InvestorsMessageKey,
) {
  return {
    columns: t('table.columns'),
    previous: t('table.previous'),
    next: t('table.next'),
    emptyTitle: a(emptyTitle),
    emptyDetail: a(emptyDetail),
    errorTitle: t('table.errorTitle'),
    errorDetail: t('table.errorDetail'),
    retry: t('common.retry'),
    pageStatus: `${t('table.page')} 1`,
    sortAscending: t('table.sortAscending'),
    sortDescending: t('table.sortDescending'),
  };
}

/** The server's message, never a stack trace, and never the raw error object (§23). */
/**
 * What to tell the user when a request fails.
 *
 * The server's problem+json `detail` is written to be shown (the problem filter
 * turns every 500 into "Something went wrong on our side"), so it is passed
 * through. Anything else never reached the server — and that sentence goes
 * through the catalogue, because a Bangla screen with one English error line is
 * the screen someone photographs and sends to support. It is not `error.offline`:
 * that one promises queued work is kept, which is true for the POS and not here.
 */
export function messageOf(error: unknown, t: (key: MessageKey) => string): string {
  if (error instanceof ApiError) return error.message;
  return t('error.unreachable');
}
