import {
  Button,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Money,
  PermissionGate,
  Skeleton,
  StatusBadge,
  takaToPoisha,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import {
  branchProfitAndLoss,
  branchSummary,
  closeBranchDay,
  dhakaMonthStart,
  dhakaToday,
  listBranchClosings,
  listReviews,
  listShifts,
  resolveReview,
  type BranchClosingResult,
  type BranchSummary,
  type RegisterRow,
  type ReviewRow,
} from './api.js';
import { useBranchesT, type BranchesMessageKey } from './messages.js';
import { DatePicker } from '../../ui/date-picker.js';

/**
 * One showroom: what it sold, how it was paid, what is waiting, and the day close
 * (M23; architecture §14, D-014).
 *
 * Three things shape this screen.
 *
 * 1. **Every figure is the server's.** Nothing is added up here: a total computed
 *    in the browser is a second opinion about the ledger, and the two disagree the
 *    first time a rounding rule changes.
 * 2. **Cost is present or absent, never zero.** `cogsPoisha` and
 *    `grossProfitPoisha` are stripped by the server for a role without `read:cost`
 *    (D-014). The tiles are left out and a line says why, because a margin tile
 *    reading ৳0 would be a wrong number on a money screen.
 * 3. **A held document is resolved by someone else.** The server refuses the person
 *    who rang a sale up, and refuses a manager whose own discount limit does not
 *    cover it. Both refusals get their own sentence here rather than a generic
 *    failure, because each tells the manager who to hand it to.
 *
 * The range lives in the URL (`?range=month`), so a link to "this month at Gulshan"
 * opens on this month.
 */

type Range = 'today' | 'month';

const REASON_KEYS: Record<ReviewRow['reasons'][number], BranchesMessageKey> = {
  stock_shortfall: 'branch.reviews.reason.stock_shortfall',
  price_mismatch: 'branch.reviews.reason.price_mismatch',
  discount_above_ceiling: 'branch.reviews.reason.discount_above_ceiling',
  shift_closed: 'branch.reviews.reason.shift_closed',
  outside_posting_window: 'branch.reviews.reason.outside_posting_window',
  sku_unavailable: 'branch.reviews.reason.sku_unavailable',
  sale_not_posted: 'branch.reviews.reason.sale_not_posted',
  return_mismatch: 'branch.reviews.reason.return_mismatch',
  outside_shift: 'branch.reviews.reason.outside_shift',
  exchange_mismatch: 'branch.reviews.reason.exchange_mismatch',
};

const CLOSING_STATUS: Record<
  BranchClosingResult['wallets'][number]['status'],
  { key: BranchesMessageKey; tone: 'success' | 'warning' | 'neutral' }
> = {
  balanced: { key: 'branch.closing.resultBalanced', tone: 'success' },
  pending_approval: { key: 'branch.closing.resultPending', tone: 'warning' },
  posted: { key: 'branch.closing.resultPosted', tone: 'neutral' },
};

export function BranchDetailPage() {
  const { branchId } = useParams({ from: '/branches/$branchId' });
  const search = useSearch({ from: '/branches/$branchId' });
  const navigate = useNavigate();
  const t = useBranchesT();
  const { locale } = useLocale();
  const ability = useAbility();

  const mayRead = ability.can('read', 'LedgerReport');
  const mayReadTill = ability.can('read', 'Wallet');
  const mayWrite = ability.can('update', 'Wallet');

  const range: Range = search.range === 'month' ? 'month' : 'today';
  const today = dhakaToday();
  const dates = { from: range === 'month' ? dhakaMonthStart() : today, to: today };

  const summary = useQuery({
    queryKey: ['pos', 'branch', branchId, 'summary', dates.from, dates.to],
    queryFn: () => branchSummary(branchId, dates),
    enabled: mayRead,
  });
  const pnl = useQuery({
    queryKey: ['pos', 'branch', branchId, 'pnl', dates.from, dates.to],
    queryFn: () => branchProfitAndLoss(branchId, dates),
    enabled: mayRead,
  });
  const shifts = useQuery({
    queryKey: ['pos', 'branch', branchId, 'shifts', dates.from, dates.to],
    queryFn: () => listShifts(branchId, dates),
    enabled: mayReadTill,
  });
  const reviews = useQuery({
    queryKey: ['pos', 'branch', branchId, 'reviews'],
    queryFn: () => listReviews(branchId),
    enabled: mayReadTill,
  });
  const closings = useQuery({
    queryKey: ['pos', 'branch', branchId, 'closings', dhakaMonthStart(), today],
    queryFn: () => listBranchClosings(branchId, { from: dhakaMonthStart(), to: today }),
    enabled: mayReadTill,
  });

  if (!mayRead) {
    return (
      <PermissionGate
        allowed={false}
        explain={{ title: t('branches.deniedTitle'), detail: t('branches.deniedDetail') }}
      >
        {null}
      </PermissionGate>
    );
  }

  const setRange = (next: Range) => {
    void navigate({
      to: '/branches/$branchId',
      params: { branchId },
      search: next === 'month' ? { range: 'month' } : {},
      replace: true,
    });
  };

  return (
    <div className="space-y-6">
      <header className="space-y-3">
        <Link
          to="/branches"
          className="inline-flex items-center gap-1 rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          {t('branch.back')}
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">
              {summary.data?.branch.name ?? t('branches.title')}
            </h1>
            {summary.data === undefined ? null : (
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                {summary.data.branch.code}
              </p>
            )}
          </div>
          <div role="group" aria-label={t('branch.range')} className="flex gap-1">
            <Button
              size="sm"
              variant={range === 'today' ? 'primary' : 'outline'}
              aria-pressed={range === 'today'}
              onClick={() => setRange('today')}
            >
              {t('branch.rangeToday')}
            </Button>
            <Button
              size="sm"
              variant={range === 'month' ? 'primary' : 'outline'}
              aria-pressed={range === 'month'}
              onClick={() => setRange('month')}
            >
              {t('branch.rangeMonth')}
            </Button>
          </div>
        </div>
      </header>

      {summary.isPending ? (
        <div className="grid gap-3 sm:grid-cols-3" aria-hidden>
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-20 w-full" />
        </div>
      ) : summary.isError ? (
        <ErrorState
          title={t('branch.errorTitle')}
          action={
            <Button variant="outline" size="sm" onClick={() => void summary.refetch()}>
              {t('branch.retry')}
            </Button>
          }
        />
      ) : (
        <SummaryTiles summary={summary.data} />
      )}

      {summary.data === undefined ? null : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Section title={t('branch.topHeading')}>
            {summary.data.topSkus.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">{t('branch.topEmpty')}</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th scope="col" className="h-row px-4 text-left font-medium">
                      {t('branch.colItem')}
                    </th>
                    <th scope="col" className="h-row px-4 text-right font-medium">
                      {t('branch.colQty')}
                    </th>
                    <th scope="col" className="h-row px-4 text-right font-medium">
                      {t('branch.colAmount')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {summary.data.topSkus.map((sku) => (
                    <tr key={sku.skuId} className="border-b border-border last:border-0">
                      <td className="h-row px-4">
                        {sku.name}
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {sku.skuCode}
                        </span>
                      </td>
                      <td className="h-row px-4 text-right tabular-nums">{sku.qty}</td>
                      <td className="h-row px-4 text-right">
                        <Money poisha={sku.netPoisha} locale={locale} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>

          <Section title={t('branch.pnlHeading')}>
            {pnl.isPending ? (
              <div className="space-y-2 p-4" aria-hidden>
                <Skeleton className="h-row w-full" />
                <Skeleton className="h-row w-full" />
              </div>
            ) : pnl.isError ? (
              <p className="px-4 py-3 text-sm text-muted-foreground" role="alert">
                {t('branch.errorTitle')}
              </p>
            ) : pnl.data.income.length === 0 && pnl.data.expense.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">{t('branch.pnlEmpty')}</p>
            ) : (
              <dl className="divide-y divide-border text-sm">
                <PnlGroup
                  label={t('branch.pnlIncome')}
                  rows={pnl.data.income}
                  total={pnl.data.incomePoisha}
                />
                <PnlGroup
                  label={t('branch.pnlExpense')}
                  rows={pnl.data.expense}
                  total={pnl.data.expensePoisha}
                />
                <div className="flex h-row items-center justify-between px-4 font-medium">
                  <dt>{t('branch.pnlNet')}</dt>
                  <dd>
                    <Money poisha={pnl.data.netPoisha} locale={locale} />
                  </dd>
                </div>
                {pnl.data.costWithheld ? (
                  <p className="px-4 py-2 text-xs text-muted-foreground">
                    {t('branch.costWithheld')}
                  </p>
                ) : null}
              </dl>
            )}
          </Section>
        </div>
      )}

      {mayReadTill ? (
        <>
          <ReviewsSection
            branchId={branchId}
            reviews={reviews.data?.items}
            loading={reviews.isPending}
            failed={reviews.isError}
            mayWrite={mayWrite}
          />

          <Section title={t('branch.shifts.heading')}>
            {shifts.isPending ? (
              <div className="space-y-2 p-4" aria-hidden>
                <Skeleton className="h-row w-full" />
                <Skeleton className="h-row w-full" />
              </div>
            ) : shifts.isError ? (
              <p className="px-4 py-3 text-sm text-muted-foreground" role="alert">
                {t('branch.errorTitle')}
              </p>
            ) : shifts.data.items.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">{t('branch.shifts.empty')}</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-xs text-muted-foreground">
                    <tr className="border-b border-border">
                      <th scope="col" className="h-row px-4 text-left font-medium">
                        {t('branch.shifts.colRegister')}
                      </th>
                      <th scope="col" className="h-row px-4 text-right font-medium">
                        {t('branch.shifts.colShift')}
                      </th>
                      <th scope="col" className="h-row px-4 text-left font-medium">
                        {t('branch.shifts.colStatus')}
                      </th>
                      <th scope="col" className="h-row px-4 text-right font-medium">
                        {t('branch.shifts.colFloat')}
                      </th>
                      <th scope="col" className="h-row px-4 text-right font-medium">
                        {t('branch.shifts.colCounted')}
                      </th>
                      <th scope="col" className="h-row px-4 text-right font-medium">
                        {t('branch.shifts.colVariance')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {shifts.data.items.map((shift) => (
                      <tr key={shift.id} className="border-b border-border last:border-0">
                        <td className="h-row px-4 font-mono text-xs">{shift.registerCode}</td>
                        <td className="h-row px-4 text-right tabular-nums">{shift.shiftNo}</td>
                        <td className="h-row px-4">
                          <StatusBadge tone={shift.status === 'open' ? 'info' : 'neutral'}>
                            {t(
                              shift.status === 'open'
                                ? 'branch.shifts.statusOpen'
                                : 'branch.shifts.statusClosed',
                            )}
                          </StatusBadge>
                        </td>
                        <td className="h-row px-4 text-right">
                          <Money poisha={shift.openingFloatPoisha} locale={locale} />
                        </td>
                        <td className="h-row px-4 text-right">
                          {shift.countedCashPoisha === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Money poisha={shift.countedCashPoisha} locale={locale} />
                          )}
                        </td>
                        <td className="h-row px-4 text-right">
                          {shift.variancePoisha === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Money poisha={shift.variancePoisha} locale={locale} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>

          {mayWrite && summary.data !== undefined ? (
            <ClosingSection branchId={branchId} registers={summary.data.registers} />
          ) : null}

          <Section title={t('branch.closing.historyHeading')}>
            {closings.isPending ? (
              <div className="space-y-2 p-4" aria-hidden>
                <Skeleton className="h-row w-full" />
              </div>
            ) : closings.isError || closings.data.items.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                {t('branch.closing.historyEmpty')}
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr className="border-b border-border">
                    <th scope="col" className="h-row px-4 text-left font-medium">
                      {t('branch.closing.date')}
                    </th>
                    <th scope="col" className="h-row px-4 text-right font-medium">
                      {t('branch.sales')}
                    </th>
                    <th scope="col" className="h-row px-4 text-right font-medium">
                      {t('branches.colNet')}
                    </th>
                    <th scope="col" className="h-row px-4 text-right font-medium">
                      {t('branch.refunds')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {closings.data.items.map((closing) => (
                    <tr key={closing.id} className="border-b border-border last:border-0">
                      <td className="h-row px-4 tabular-nums">{closing.businessDate}</td>
                      <td className="h-row px-4 text-right tabular-nums">{closing.salesCount}</td>
                      <td className="h-row px-4 text-right">
                        <Money poisha={closing.netSalesPoisha} locale={locale} />
                      </td>
                      <td className="h-row px-4 text-right">
                        <Money poisha={closing.refundsPoisha} locale={locale} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
        </>
      ) : null}
    </div>
  );
}

/** A titled, hairline-bordered block. Separation is a border, never a shadow (§24). */
function Section({
  title,
  caption,
  children,
}: {
  readonly title: string;
  readonly caption?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {caption === undefined ? null : (
          <p className="mt-0.5 text-xs text-muted-foreground">{caption}</p>
        )}
      </div>
      {children}
    </section>
  );
}

function Tile({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="bg-card px-4 py-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-base font-semibold text-foreground tabular-nums">{children}</dd>
    </div>
  );
}

function SummaryTiles({ summary }: { readonly summary: BranchSummary }) {
  const t = useBranchesT();
  const { locale } = useLocale();
  const hasCost = summary.grossProfitPoisha !== undefined && summary.cogsPoisha !== undefined;

  return (
    <div className="space-y-3">
      <dl className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-2 lg:grid-cols-5">
        <Tile label={t('branch.netRevenue')}>
          <Money poisha={summary.netRevenuePoisha} locale={locale} />
        </Tile>
        <Tile label={t('branch.sales')}>{summary.salesCount}</Tile>
        <Tile label={t('branch.discounts')}>
          <Money poisha={summary.discountPoisha} locale={locale} />
        </Tile>
        <Tile label={t('branch.refunds')}>
          <Money poisha={summary.refundsPoisha} locale={locale} />
        </Tile>
        <Tile label={t('branch.averageBasket')}>
          <Money poisha={summary.averageBasketPoisha} locale={locale} />
        </Tile>
      </dl>

      <dl className="grid gap-px overflow-hidden rounded-lg border border-border bg-border sm:grid-cols-3 lg:grid-cols-5">
        <Tile label={t('branch.tenderCash')}>
          <Money poisha={summary.tenders.cashPoisha} locale={locale} />
        </Tile>
        <Tile label={t('branch.tenderBkash')}>
          <Money poisha={summary.tenders.bkashPoisha} locale={locale} />
        </Tile>
        <Tile label={t('branch.tenderCard')}>
          <Money poisha={summary.tenders.cardPoisha} locale={locale} />
        </Tile>
        {hasCost ? (
          <>
            <Tile label={t('branch.costOfSales')}>
              <Money poisha={summary.cogsPoisha ?? '0'} locale={locale} />
            </Tile>
            <Tile label={t('branch.grossProfit')}>
              <Money poisha={summary.grossProfitPoisha ?? '0'} locale={locale} />
            </Tile>
          </>
        ) : null}
      </dl>

      {hasCost ? null : <p className="text-xs text-muted-foreground">{t('branch.costWithheld')}</p>}
    </div>
  );
}

function PnlGroup({
  label,
  rows,
  total,
}: {
  readonly label: string;
  readonly rows: readonly { code: string; name: string; amountPoisha: string }[];
  readonly total: string;
}) {
  const { locale } = useLocale();
  return (
    <div>
      <div className="flex h-row items-center justify-between bg-muted px-4 text-xs font-medium text-muted-foreground">
        <dt>{label}</dt>
        <dd>
          <Money poisha={total} locale={locale} />
        </dd>
      </div>
      {rows.map((row) => (
        <div key={row.code} className="flex h-row items-center justify-between px-4">
          <dt>
            <span className="mr-2 font-mono text-xs text-muted-foreground">{row.code}</span>
            {row.name}
          </dt>
          <dd>
            <Money poisha={row.amountPoisha} locale={locale} />
          </dd>
        </div>
      ))}
    </div>
  );
}

/** Which sentence a refused resolution gets. The code is the server's (§23). */
function resolveFailure(error: unknown): BranchesMessageKey {
  if (error instanceof ApiError) {
    if (error.code === 'POS_REVIEW_SELF_RESOLVE') return 'branch.reviews.selfResolve';
    if (error.code === 'POS_DISCOUNT_ABOVE_CEILING') return 'branch.reviews.aboveCeiling';
  }
  return 'branch.reviews.failed';
}

function ReviewsSection({
  branchId,
  reviews,
  loading,
  failed,
  mayWrite,
}: {
  readonly branchId: string;
  readonly reviews: readonly ReviewRow[] | undefined;
  readonly loading: boolean;
  readonly failed: boolean;
  readonly mayWrite: boolean;
}) {
  const t = useBranchesT();
  const { locale } = useLocale();
  const queryClient = useQueryClient();
  const noteId = useId();
  const [pending, setPending] = useState<{ review: ReviewRow; action: 'post' | 'void' } | null>(
    null,
  );
  const [note, setNote] = useState('');
  const [message, setMessage] = useState<BranchesMessageKey | null>(null);

  /*
   * Invalidate, never patch. A posted document moves stock, a wallet and the
   * day's totals, so the only correct next value for every query on this page is
   * the one the server computes.
   */
  const resolve = useMutation({
    mutationFn: (input: { reviewId: string; action: 'post' | 'void'; note: string }) =>
      resolveReview(input.reviewId, { action: input.action, note: input.note }),
    onSuccess: async (result) => {
      setPending(null);
      setNote('');
      setMessage(result.outcome === 'held' ? 'branch.reviews.stillHeld' : null);
      await queryClient.invalidateQueries({ queryKey: ['pos', 'branch', branchId] });
      await queryClient.invalidateQueries({ queryKey: ['pos', 'branches'] });
    },
    onError: (error: unknown) => {
      setPending(null);
      setMessage(resolveFailure(error));
    },
  });

  return (
    <Section title={t('branch.reviews.heading')} caption={t('branch.reviews.caption')}>
      {message === null ? null : (
        <p role="status" className="border-b border-border px-4 py-2 text-sm text-foreground">
          {t(message)}
        </p>
      )}
      {loading ? (
        <div className="space-y-2 p-4" aria-hidden>
          <Skeleton className="h-row w-full" />
        </div>
      ) : failed ? (
        <p className="px-4 py-3 text-sm text-muted-foreground" role="alert">
          {t('branch.errorTitle')}
        </p>
      ) : reviews === undefined || reviews.length === 0 ? (
        <EmptyState title={t('branch.reviews.empty')} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="h-row px-4 text-left font-medium">
                  {t('branch.reviews.colReceipt')}
                </th>
                <th scope="col" className="h-row px-4 text-left font-medium">
                  {t('branch.reviews.colKind')}
                </th>
                <th scope="col" className="h-row px-4 text-right font-medium">
                  {t('branch.reviews.colAmount')}
                </th>
                <th scope="col" className="h-row px-4 text-left font-medium">
                  {t('branch.reviews.colWhy')}
                </th>
                {mayWrite ? (
                  <th scope="col" className="h-row px-4 text-right font-medium">
                    {t('branch.reviews.colActions')}
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {reviews.map((review) => (
                <tr key={review.id} className="border-b border-border last:border-0">
                  <td className="h-row px-4 font-mono text-xs">{review.receiptNo}</td>
                  <td className="h-row px-4">
                    {t(
                      review.kind === 'sale'
                        ? 'branch.reviews.kindSale'
                        : 'branch.reviews.kindReturn',
                    )}
                  </td>
                  <td className="h-row px-4 text-right">
                    <Money poisha={review.amountPoisha} locale={locale} />
                  </td>
                  <td className="px-4 py-1.5">
                    <span className="flex flex-wrap gap-1">
                      {review.reasons.map((reason) => (
                        <StatusBadge key={reason} tone="warning">
                          {t(REASON_KEYS[reason])}
                        </StatusBadge>
                      ))}
                    </span>
                  </td>
                  {mayWrite ? (
                    <td className="h-row px-4">
                      <span className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`${t('branch.reviews.post')}: ${review.receiptNo}`}
                          onClick={() => {
                            setMessage(null);
                            setPending({ review, action: 'post' });
                          }}
                        >
                          {t('branch.reviews.post')}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          aria-label={`${t('branch.reviews.void')}: ${review.receiptNo}`}
                          onClick={() => {
                            setMessage(null);
                            setPending({ review, action: 'void' });
                          }}
                        >
                          {t('branch.reviews.void')}
                        </Button>
                      </span>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pending === null ? null : (
        <Dialog
          open
          onOpenChange={(open) => {
            if (!open) setPending(null);
          }}
          title={`${t(
            pending.action === 'post' ? 'branch.reviews.postTitle' : 'branch.reviews.voidTitle',
          )} · ${pending.review.receiptNo}`}
          description={t(
            pending.action === 'post' ? 'branch.reviews.postDetail' : 'branch.reviews.voidDetail',
          )}
          closeLabel={t('branch.reviews.close')}
          footer={
            <>
              <Button variant="outline" onClick={() => setPending(null)}>
                {t('branch.reviews.cancel')}
              </Button>
              <Button
                variant={pending.action === 'void' ? 'destructive' : 'primary'}
                disabled={note.trim() === '' || resolve.isPending}
                onClick={() =>
                  resolve.mutate({
                    reviewId: pending.review.id,
                    action: pending.action,
                    note: note.trim(),
                  })
                }
              >
                {t(
                  pending.action === 'post'
                    ? 'branch.reviews.confirmPost'
                    : 'branch.reviews.confirmVoid',
                )}
              </Button>
            </>
          }
        >
          <div className="space-y-1.5">
            <Label htmlFor={noteId} required>
              {t('branch.reviews.note')}
            </Label>
            <Input
              id={noteId}
              value={note}
              maxLength={500}
              aria-describedby={`${noteId}-hint`}
              onChange={(event) => setNote(event.target.value)}
            />
            <p id={`${noteId}-hint`} className="text-xs text-muted-foreground">
              {t('branch.reviews.noteHint')}
            </p>
          </div>
        </Dialog>
      )}
    </Section>
  );
}

/** Why the server refused to close the day, as a sentence the manager can act on. */
function closingFailure(error: unknown): BranchesMessageKey {
  if (error instanceof ApiError) {
    if (error.code === 'POS_BRANCH_DAY_NOT_READY') return 'branch.closing.notReady';
    if (error.code === 'CLOSING_ALREADY_RECORDED') return 'branch.closing.alreadyClosed';
  }
  return 'branch.closing.failed';
}

/**
 * The day close: one count per hand-cash wallet the branch's active tills use.
 *
 * The count is typed in taka and converted by `takaToPoisha`, which is integer
 * arithmetic and answers null for anything that is not taka with at most two
 * decimals (invariant 1). Nothing here knows the expected balance: the server
 * derives it from the ledger and answers with the difference, so a manager
 * cannot count towards a number the screen showed them.
 */
function ClosingSection({
  branchId,
  registers,
}: {
  readonly branchId: string;
  readonly registers: readonly RegisterRow[];
}) {
  const t = useBranchesT();
  const { locale } = useLocale();
  const queryClient = useQueryClient();
  const formId = useId();
  const today = dhakaToday();

  // Several tills can pay into one drawer; each drawer is counted once.
  const wallets = new Map<string, string[]>();
  for (const register of registers.filter((entry) => entry.isActive)) {
    wallets.set(register.cashWalletId, [
      ...(wallets.get(register.cashWalletId) ?? []),
      register.code,
    ]);
  }

  const [businessDate, setBusinessDate] = useState(today);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [problem, setProblem] = useState<BranchesMessageKey | null>(null);
  const [result, setResult] = useState<BranchClosingResult | null>(null);
  // One id per attempt at a day: a retry after a dropped connection repeats it, so
  // the server answers with the closing it already recorded.
  const [closingId, setClosingId] = useState(() => crypto.randomUUID());

  const close = useMutation({
    mutationFn: (input: { counts: { walletId: string; countedPoisha: string }[] }) =>
      closeBranchDay(branchId, {
        closingId,
        businessDate,
        counts: input.counts,
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: async (closed) => {
      setResult(closed);
      setProblem(null);
      setCounts({});
      setNote('');
      setClosingId(crypto.randomUUID());
      await queryClient.invalidateQueries({ queryKey: ['pos', 'branch', branchId] });
      await queryClient.invalidateQueries({ queryKey: ['pos', 'branches'] });
    },
    onError: (error: unknown) => {
      setResult(null);
      setProblem(closingFailure(error));
    },
  });

  if (wallets.size === 0) {
    return (
      <Section title={t('branch.closing.heading')}>
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('branch.closing.noRegisters')}</p>
      </Section>
    );
  }

  const submit = () => {
    const parsed: { walletId: string; countedPoisha: string }[] = [];
    for (const walletId of wallets.keys()) {
      const poisha = takaToPoisha(counts[walletId] ?? '');
      if (poisha === null) {
        setProblem('branch.closing.countInvalid');
        return;
      }
      parsed.push({ walletId, countedPoisha: poisha });
    }
    close.mutate({ counts: parsed });
  };

  return (
    <Section title={t('branch.closing.heading')} caption={t('branch.closing.caption')}>
      <form
        className="space-y-4 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-date`} required>
              {t('branch.closing.date')}
            </Label>
            <DatePicker
              id={`${formId}-date`}
              max={today}
              value={businessDate}
              onValueChange={(next) => {
                setBusinessDate(next);
                // A different day is a different closing, never a retry of this one.
                setClosingId(crypto.randomUUID());
              }}
            />
          </div>
          {[...wallets.entries()].map(([walletId, codes]) => (
            <div key={walletId} className="space-y-1.5">
              <Label htmlFor={`${formId}-${walletId}`} required>
                {`${t('branch.closing.wallet')} · ${codes.join(', ')}`}
              </Label>
              <Input
                id={`${formId}-${walletId}`}
                inputMode="decimal"
                className="text-right tabular-nums"
                value={counts[walletId] ?? ''}
                aria-invalid={problem === 'branch.closing.countInvalid'}
                onChange={(event) => {
                  setCounts((current) => ({ ...current, [walletId]: event.target.value }));
                  // A different count is a different closing, never a retry of this one.
                  setClosingId(crypto.randomUUID());
                }}
              />
            </div>
          ))}
          <div className="space-y-1.5 sm:col-span-2 lg:col-span-3">
            <Label htmlFor={`${formId}-note`}>{t('branch.closing.note')}</Label>
            <Input
              id={`${formId}-note`}
              value={note}
              maxLength={500}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        </div>

        {problem === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {t(problem)}
          </p>
        )}

        <Button type="submit" disabled={close.isPending}>
          {t('branch.closing.submit')}
        </Button>
      </form>

      {result === null ? null : (
        <div className="border-t border-border" role="status">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b border-border">
                <th scope="col" className="h-row px-4 text-right font-medium">
                  {t('branch.closing.expected')}
                </th>
                <th scope="col" className="h-row px-4 text-right font-medium">
                  {t('branch.closing.counted')}
                </th>
                <th scope="col" className="h-row px-4 text-right font-medium">
                  {t('branch.closing.variance')}
                </th>
                <th scope="col" className="h-row px-4 text-left font-medium">
                  {t('branch.shifts.colStatus')}
                </th>
              </tr>
            </thead>
            <tbody>
              {result.wallets.map((wallet) => (
                <tr key={wallet.walletId} className="border-b border-border last:border-0">
                  <td className="h-row px-4 text-right">
                    <Money poisha={wallet.expectedPoisha} locale={locale} />
                  </td>
                  <td className="h-row px-4 text-right">
                    <Money poisha={wallet.countedPoisha} locale={locale} />
                  </td>
                  <td className="h-row px-4 text-right">
                    <Money poisha={wallet.variancePoisha} locale={locale} />
                  </td>
                  <td className="h-row px-4">
                    <StatusBadge tone={CLOSING_STATUS[wallet.status].tone}>
                      {t(CLOSING_STATUS[wallet.status].key)}
                    </StatusBadge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}
