import { today, type Locale } from '@elysium/i18n';
import { Button, EmptyState, ErrorState, Money, Skeleton, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { FileText, Info } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import {
  investor,
  type DocumentRow,
  type InvestmentRow,
  type InvestorRow,
  type RequestContext,
  type StatementEntry,
  type WithdrawalRow,
} from './api.js';
import type { PortalMessageKey, Translate } from './messages.js';
import {
  distributionsOf,
  DOCUMENT_KIND_LABEL,
  MOVEMENT_LABEL,
  ownInvestor,
  readableDate,
  STATEMENT_FROM,
  WITHDRAWAL_KIND_LABEL,
  WITHDRAWAL_STATUS_LABEL,
  WITHDRAWAL_STATUS_TONE,
} from './model.js';
import { Section, Table } from './ui.js';

/**
 * One investor's position in one brand (M25, §15): what they hold, the profit declared to
 * them, their withdrawals and where each one is, their statement and their documents.
 *
 * **Nothing here is an action except opening a document.** The `investor` role reads and
 * never writes (D-312): a withdrawal is raised by the brand's accounts team and decided by a
 * second person, so the page says how to ask rather than offering a form the API would
 * refuse.
 *
 * Every query is keyed by the brand, and every list is asked for by the caller's own
 * investor id. The id filter is not what keeps another investor's rows out — the server's
 * `own` scope does that (check 1) — but it keeps a person who is also accounts in the same
 * brand looking at their own position here rather than the brand's.
 */
export function Dashboard({
  t,
  locale,
  context,
  brandName,
}: {
  readonly t: Translate;
  readonly locale: Locale;
  readonly context: RequestContext;
  readonly brandName: string;
}) {
  // Keyed by the person as well as the brand: a cache entry is never somebody else's.
  const { orgId, userId } = context;
  const self = useQuery({
    queryKey: ['investor', userId, orgId, 'self'],
    queryFn: async ({ signal }) => ownInvestor((await investor.list(signal)).items, context.userId),
  });
  const investorId = self.data?.id ?? null;
  const enabled = investorId !== null;

  const investments = useQuery({
    queryKey: ['investor', userId, orgId, 'investments', investorId],
    queryFn: ({ signal }) => investor.investments(investorId ?? '', signal),
    enabled,
  });
  const withdrawals = useQuery({
    queryKey: ['investor', userId, orgId, 'withdrawals', investorId],
    queryFn: ({ signal }) => investor.withdrawals(investorId ?? '', signal),
    enabled,
  });
  const documents = useQuery({
    queryKey: ['investor', userId, orgId, 'documents', investorId],
    queryFn: ({ signal }) => investor.documents(investorId ?? '', signal),
    enabled,
  });
  const statement = useQuery({
    queryKey: ['investor', userId, orgId, 'statement', investorId],
    queryFn: ({ signal }) =>
      investor.statement(investorId ?? '', { from: STATEMENT_FROM, to: today() }, signal),
    enabled,
  });

  if (self.isPending) return <DashboardSkeleton t={t} />;
  if (self.isError) return <LoadFailed t={t} retry={() => void self.refetch()} />;
  if (self.data === null) {
    return (
      <EmptyState
        title={t('portal.investor.noProfileTitle')}
        detail={t('portal.investor.noProfileDetail')}
      />
    );
  }

  const me = self.data;
  const failed = [investments, withdrawals, documents, statement].find((query) => query.isError);
  const retryAll = () => {
    for (const query of [investments, withdrawals, documents, statement]) void query.refetch();
  };

  return (
    <div className="space-y-10">
      <div className="space-y-1">
        <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold tracking-tight">
          {me.name}
          {me.status === 'exited' ? (
            <StatusBadge tone="neutral">{t('investors.statusExited')}</StatusBadge>
          ) : null}
        </h1>
        <p className="text-sm text-muted-foreground">
          {brandName} · {t('investors.colCode')} <span className="tabular-nums">{me.code}</span>
        </p>
      </div>

      <PositionTiles t={t} locale={locale} position={me.position} />

      {failed === undefined ? null : <LoadFailed t={t} retry={retryAll} />}

      <Section
        title={t('portal.investor.distributionsHeading')}
        caption={t('portal.investor.distributionsCaption')}
      >
        <Listing
          query={statement}
          rows={(data) => distributionsOf(data.entries)}
          empty={{
            title: t('portal.investor.distributionsEmptyTitle'),
            detail: t('portal.investor.distributionsEmptyDetail'),
          }}
          render={(rows) => (
            <Table<StatementEntry>
              caption={t('portal.investor.distributionsCaption')}
              rows={rows}
              rowKey={(row) => `${row.reference}-${row.date}`}
              columns={[
                { header: t('investors.colDate'), cell: (row) => readableDate(row.date, locale) },
                {
                  header: t('investors.colAmount'),
                  numeric: true,
                  cell: (row) => <Money poisha={row.amountPoisha} locale={locale} />,
                },
              ]}
            />
          )}
        />
      </Section>

      <Section
        title={t('investors.withdrawalsHeading')}
        caption={t('portal.investor.withdrawalsCaption')}
      >
        <p className="flex items-start gap-2 rounded-lg border border-border bg-muted px-4 py-3 text-sm text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          <span>{t('portal.investor.withdrawHint')}</span>
        </p>
        <Listing
          query={withdrawals}
          rows={(data) => data.items}
          empty={{
            title: t('investors.withdrawalsEmptyTitle'),
            detail: t('portal.investor.withdrawalsEmptyDetail'),
          }}
          render={(rows) => (
            <Table<WithdrawalRow>
              caption={t('portal.investor.withdrawalsCaption')}
              rows={rows}
              rowKey={(row) => row.id}
              columns={[
                {
                  header: t('portal.investor.colRequestedOn'),
                  cell: (row) => readableDate(row.requestedAt, locale),
                },
                {
                  header: t('investors.colKind'),
                  cell: (row) => t(WITHDRAWAL_KIND_LABEL[row.kind]),
                },
                {
                  header: t('investors.colAmount'),
                  numeric: true,
                  cell: (row) => <Money poisha={row.amountPoisha} locale={locale} />,
                },
                {
                  header: t('investors.colStatus'),
                  cell: (row) => (
                    <StatusBadge tone={WITHDRAWAL_STATUS_TONE[row.status]}>
                      {t(WITHDRAWAL_STATUS_LABEL[row.status])}
                    </StatusBadge>
                  ),
                },
                {
                  header: t('portal.investor.colPaidOn'),
                  cell: (row) => (row.paidOn === null ? '—' : readableDate(row.paidOn, locale)),
                },
              ]}
            />
          )}
        />
      </Section>

      <Section
        title={t('portal.investor.contributionsHeading')}
        caption={t('portal.investor.contributionsCaption')}
      >
        <Listing
          query={investments}
          rows={(data) => data.items}
          empty={{
            title: t('portal.investor.contributionsEmptyTitle'),
            detail: t('portal.investor.contributionsEmptyDetail'),
          }}
          render={(rows) => (
            <Table<InvestmentRow>
              caption={t('portal.investor.contributionsCaption')}
              rows={rows}
              rowKey={(row) => row.id}
              columns={[
                {
                  header: t('investors.colDate'),
                  cell: (row) => readableDate(row.businessDate, locale),
                },
                {
                  header: t('investors.colAmount'),
                  numeric: true,
                  cell: (row) => <Money poisha={row.amountPoisha} locale={locale} />,
                },
                {
                  header: t('portal.investor.colLockIn'),
                  cell: (row) =>
                    row.lockInUntil === null
                      ? t('portal.investor.notLocked')
                      : readableDate(row.lockInUntil, locale),
                },
              ]}
            />
          )}
        />
      </Section>

      <Section
        title={t('investors.statementHeading')}
        caption={t('portal.investor.statementCaption')}
      >
        <Listing
          query={statement}
          rows={(data) => data.entries}
          empty={{
            title: t('investors.statementEmptyTitle'),
            detail: t('portal.investor.statementEmptyDetail'),
          }}
          render={(rows) => (
            <Table<StatementEntry>
              caption={t('portal.investor.statementCaption')}
              rows={rows}
              rowKey={(row) => `${row.kind}-${row.reference}-${row.date}`}
              columns={[
                { header: t('investors.colDate'), cell: (row) => readableDate(row.date, locale) },
                { header: t('investors.colMovement'), cell: (row) => t(MOVEMENT_LABEL[row.kind]) },
                {
                  header: t('investors.colAmount'),
                  numeric: true,
                  cell: (row) => <Money poisha={row.amountPoisha} locale={locale} />,
                },
              ]}
            />
          )}
        />
      </Section>

      <Section
        title={t('investors.documentsHeading')}
        caption={t('portal.investor.documentsCaption')}
      >
        <Listing
          query={documents}
          rows={(data) => data.items}
          empty={{
            title: t('investors.documentsEmptyTitle'),
            detail: t('portal.investor.documentsEmptyDetail'),
          }}
          render={(rows) => <Documents t={t} locale={locale} rows={rows} />}
        />
      </Section>
    </div>
  );
}

const POSITION_TILES: readonly { label: PortalMessageKey; field: keyof InvestorRow['position'] }[] =
  [
    { label: 'investors.capitalLabel', field: 'capitalPoisha' },
    { label: 'investors.lockedLabel', field: 'lockedPoisha' },
    { label: 'investors.withdrawableLabel', field: 'withdrawableCapitalPoisha' },
    { label: 'investors.declaredLabel', field: 'declaredPoisha' },
    { label: 'investors.profitPaidLabel', field: 'profitPaidPoisha' },
    { label: 'investors.payableLabel', field: 'payablePoisha' },
  ];

function PositionTiles({
  t,
  locale,
  position,
}: {
  readonly t: Translate;
  readonly locale: Locale;
  readonly position: InvestorRow['position'];
}) {
  return (
    <section aria-label={t('portal.investor.positionHeading')}>
      <h2 className="sr-only">{t('portal.investor.positionHeading')}</h2>
      <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border bg-border md:grid-cols-3">
        {POSITION_TILES.map((tile) => (
          <div key={tile.field} className="space-y-1 bg-card px-4 py-4">
            <dt className="text-xs text-muted-foreground">{t(tile.label)}</dt>
            <dd className="text-lg font-semibold tracking-tight">
              <Money poisha={position[tile.field]} locale={locale} align="start" />
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/**
 * A document opens through a URL minted for this click and nothing else (check 3). The
 * list carries ids only; the signed URL is asked for here, used once, and never stored.
 *
 * The tab is opened inside the click itself and pointed at the URL when it arrives: a
 * window opened after an `await` is no longer the user's gesture, and a phone's popup
 * blocker drops it without a word. The new tab is cut off from this one (`opener = null`),
 * which is what `noopener` would have done. Without a tab at all, the page goes to the URL
 * itself — it is served as an attachment, so the portal stays where it is.
 */
function Documents({
  t,
  locale,
  rows,
}: {
  readonly t: Translate;
  readonly locale: Locale;
  readonly rows: readonly DocumentRow[];
}) {
  const [failed, setFailed] = useState(false);
  const open = useMutation({
    mutationFn: (input: { readonly documentId: string; readonly tab: Window | null }) =>
      investor.documentUrl(input.documentId),
    onSuccess: (signed, { tab }) => {
      setFailed(false);
      if (tab !== null && !tab.closed) tab.location.replace(signed.url);
      else window.location.assign(signed.url);
    },
    onError: (_error, { tab }) => {
      tab?.close();
      setFailed(true);
    },
  });

  function openDocument(documentId: string): void {
    const tab = window.open('', '_blank');
    if (tab !== null) tab.opener = null;
    open.mutate({ documentId, tab });
  }

  return (
    <div className="space-y-2">
      <Table<DocumentRow>
        caption={t('portal.investor.documentsCaption')}
        rows={rows}
        rowKey={(row) => row.id}
        columns={[
          {
            header: t('investors.colTitle'),
            cell: (row) => (
              <span className="flex items-center gap-2">
                <FileText aria-hidden="true" className="size-4 text-muted-foreground" />
                {row.title}
              </span>
            ),
          },
          {
            header: t('investors.colDocumentKind'),
            cell: (row) => t(DOCUMENT_KIND_LABEL[row.kind]),
          },
          { header: t('investors.colDate'), cell: (row) => readableDate(row.uploadedAt, locale) },
          {
            header: t('investors.open'),
            numeric: true,
            cell: (row) => {
              const busy = open.isPending && open.variables.documentId === row.id;
              return (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={open.isPending}
                  aria-label={`${t('investors.open')}: ${row.title}`}
                  onClick={() => openDocument(row.id)}
                >
                  {busy ? t('investors.opening') : t('investors.open')}
                </Button>
              );
            },
          },
        ]}
      />
      <p className="text-xs text-muted-foreground">{t('investors.documentHint')}</p>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t('portal.investor.openFailed')}
        </p>
      ) : null}
    </div>
  );
}

/** A list's three states — loading, empty, rows — drawn the same way for every section. */
function Listing<Data, Row>({
  query,
  rows,
  empty,
  render,
}: {
  readonly query: { readonly data: Data | undefined; readonly isPending: boolean };
  readonly rows: (data: Data) => readonly Row[];
  readonly empty: { readonly title: string; readonly detail: string };
  readonly render: (rows: readonly Row[]) => ReactNode;
}) {
  if (query.data === undefined) {
    return query.isPending ? <Skeleton className="h-24 w-full" /> : null;
  }
  const list = rows(query.data);
  if (list.length === 0) return <EmptyState title={empty.title} detail={empty.detail} />;
  return <>{render(list)}</>;
}

function LoadFailed({ t, retry }: { readonly t: Translate; readonly retry: () => void }) {
  return (
    <ErrorState
      title={t('portal.investor.errorTitle')}
      detail={t('portal.investor.errorDetail')}
      action={
        <Button variant="outline" onClick={retry}>
          {t('portal.investor.retry')}
        </Button>
      }
    />
  );
}

function DashboardSkeleton({ t }: { readonly t: Translate }) {
  return (
    <div className="space-y-6" aria-busy="true">
      <span className="sr-only">{t('common.loading')}</span>
      <Skeleton className="h-7 w-56" />
      <Skeleton className="h-36 w-full" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
