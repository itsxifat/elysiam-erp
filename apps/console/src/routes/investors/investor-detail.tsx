import {
  Button,
  DataTable,
  ErrorState,
  Money,
  PermissionGate,
  StatusBadge,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { useMemo, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import {
  documentUrl,
  getInvestor,
  listDocuments,
  statement,
  type DocumentRow,
  type StatementEntry,
} from './api.js';
import { messageOf, tableLabels } from './investors-page.js';
import { useInvestorsT, type InvestorsMessageKey } from './messages.js';
import { dhakaToday } from './share.js';

/**
 * One investor: their position, their statement and their documents (M25, §15).
 *
 * This is the screen an investor themselves sees — the same component, serving
 * their own row. Three things follow from that:
 *
 * 1. **Nothing on it is an action.** Recording capital, declaring profit and
 *    reviewing a withdrawal all live on the list page behind `PermissionGate`. An
 *    investor holds `read Investor` and nothing else, so a detail page full of
 *    disabled buttons would be a page that mostly explains what they cannot do.
 * 2. **A document opens through a freshly signed URL, one click at a time.** No
 *    URL is stored, cached or rendered into the table: a signed URL is a bearer
 *    token, and one left in a React Query cache is a link that works for whoever
 *    finds it until it expires (§22, D-115, check 3).
 * 3. **The statement is the ledger's own story.** Every entry names the journal
 *    behind it, so a question about any line is answerable in the day book.
 */

const MOVEMENT_LABELS: Record<StatementEntry['kind'], InvestorsMessageKey> = {
  contribution: 'investors.movementContribution',
  distribution: 'investors.movementDistribution',
  profit_paid: 'investors.movementProfitPaid',
  capital_withdrawal: 'investors.movementCapitalWithdrawal',
};

const DOCUMENT_KINDS: Record<DocumentRow['kind'], InvestorsMessageKey> = {
  kyc: 'investors.documentKindKyc',
  agreement: 'investors.documentKindAgreement',
  other: 'investors.documentKindOther',
};

const SINGLE_PAGE = { page: 1, pageSize: 500, total: null, hasNext: false } as const;

/** The whole history. A range filter is a follow-up; nothing here needs one yet. */
const FROM = '2000-01-01';

export function InvestorDetailPage() {
  const { investorId } = useParams({ from: '/investors/$investorId' });
  const ability = useAbility();
  const t = useT();
  const a = useInvestorsT();
  const { locale } = useLocale();

  const mayRead = ability.can('read', 'Investor');
  const [openError, setOpenError] = useState<string | null>(null);

  const investorQuery = useQuery({
    queryKey: ['investors', 'detail', investorId],
    queryFn: () => getInvestor(investorId),
    enabled: mayRead,
  });
  const statementQuery = useQuery({
    queryKey: ['investors', 'statement', investorId],
    queryFn: () => statement(investorId, { from: FROM, to: dhakaToday() }),
    enabled: mayRead,
  });
  const documentQuery = useQuery({
    queryKey: ['investors', 'documents', investorId],
    queryFn: () => listDocuments(investorId),
    enabled: mayRead,
  });

  /**
   * Fetch a signed URL and hand it to the browser.
   *
   * `noopener` on purpose: the document opens in a tab that cannot reach back into
   * this one through `window.opener`, which for a link whose host is a storage
   * bucket is the difference between a download and a tab that can navigate the
   * console.
   */
  const openMutation = useMutation({
    mutationFn: (documentId: string) => documentUrl(documentId),
    onSuccess: (signed) => {
      setOpenError(null);
      window.open(signed.url, '_blank', 'noopener,noreferrer');
    },
    onError: (error: unknown) => {
      setOpenError(messageOf(error, t));
    },
  });

  const statementColumns = useMemo<readonly DataTableColumn<StatementEntry>[]>(() => {
    const column = dataTableColumns<StatementEntry>();
    return column.columns([
      column.accessor('date', { header: a('investors.colDate') }),
      column.accessor('kind', {
        header: a('investors.colMovement'),
        cell: (cell) => a(MOVEMENT_LABELS[cell.getValue()]),
      }),
      column.accessor('amountPoisha', {
        header: a('investors.colAmount'),
        meta: { numeric: true },
        cell: (cell) => {
          const kind = cell.row.original.kind;
          const out = kind === 'profit_paid' || kind === 'capital_withdrawal';
          return (
            <Money
              poisha={cell.getValue()}
              locale={locale}
              // Money leaving is the muted one. Every amount is stored positive
              // and the direction is the movement, so a column of bare positives
              // would read as if nothing had ever been paid out.
              className={out ? 'text-muted-foreground' : undefined}
            />
          );
        },
      }),
      column.accessor('note', {
        header: a('investors.fieldMemo'),
        cell: (cell) => cell.getValue() ?? '—',
      }),
    ]) as readonly DataTableColumn<StatementEntry>[];
  }, [a, locale]);

  const documentColumns = useMemo<readonly DataTableColumn<DocumentRow>[]>(() => {
    const column = dataTableColumns<DocumentRow>();
    return column.columns([
      column.accessor('title', { header: a('investors.colTitle') }),
      column.accessor('kind', {
        header: a('investors.colDocumentKind'),
        cell: (cell) => a(DOCUMENT_KINDS[cell.getValue()]),
      }),
      column.display({
        id: 'open',
        header: '',
        cell: (cell) => (
          <Button
            variant="outline"
            size="sm"
            disabled={openMutation.isPending}
            onClick={() => openMutation.mutate(cell.row.original.id)}
          >
            {openMutation.isPending ? a('investors.opening') : a('investors.open')}
          </Button>
        ),
      }),
    ]) as readonly DataTableColumn<DocumentRow>[];
  }, [a, openMutation]);

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

  const investor = investorQuery.data;
  if (investorQuery.isError) {
    // ErrorState, not EmptyState: a failed load is announced (`role="alert"`) and
    // styled as a failure. Rendered as an empty state it read as "this investor has
    // nothing", which on a page of money balances is the most misleading thing a
    // screen can say.
    return (
      <ErrorState
        title={a('investors.errorTitle')}
        detail={messageOf(investorQuery.error, t)}
        action={
          <Button variant="outline" size="sm" onClick={() => void investorQuery.refetch()}>
            {t('common.retry')}
          </Button>
        }
      />
    );
  }

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <Link
          to="/investors"
          className="text-xs font-medium text-muted-foreground underline-offset-4 hover:underline"
        >
          {a('investors.back')}
        </Link>
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-lg font-semibold tracking-tight">
            {investor?.name ?? a('investors.title')}
          </h1>
          {investor === undefined ? null : (
            <>
              <span className="text-sm text-muted-foreground">{investor.code}</span>
              <StatusBadge tone={investor.status === 'active' ? 'success' : 'neutral'}>
                {a(
                  investor.status === 'active'
                    ? 'investors.statusActive'
                    : 'investors.statusExited',
                )}
              </StatusBadge>
            </>
          )}
        </div>
      </header>

      <section aria-labelledby="position-heading" className="space-y-3">
        <h2 id="position-heading" className="text-sm font-medium">
          {a('investors.detailHeading')}
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Tile
            label={a('investors.contributedLabel')}
            poisha={investor?.position.contributedPoisha ?? '0'}
            locale={locale}
          />
          <Tile
            label={a('investors.capitalLabel')}
            poisha={investor?.position.capitalPoisha ?? '0'}
            locale={locale}
          />
          <Tile
            label={a('investors.lockedLabel')}
            poisha={investor?.position.lockedPoisha ?? '0'}
            locale={locale}
          />
          <Tile
            label={a('investors.withdrawableLabel')}
            poisha={investor?.position.withdrawableCapitalPoisha ?? '0'}
            locale={locale}
          />
          <Tile
            label={a('investors.declaredLabel')}
            poisha={investor?.position.declaredPoisha ?? '0'}
            locale={locale}
          />
          <Tile
            label={a('investors.profitPaidLabel')}
            poisha={investor?.position.profitPaidPoisha ?? '0'}
            locale={locale}
          />
          <Tile
            label={a('investors.payableLabel')}
            poisha={investor?.position.payablePoisha ?? '0'}
            locale={locale}
          />
          <Tile
            label={a('investors.withdrawnLabel')}
            poisha={investor?.position.capitalWithdrawnPoisha ?? '0'}
            locale={locale}
          />
        </dl>
      </section>

      <section aria-labelledby="statement-heading" className="space-y-3">
        <h2 id="statement-heading" className="text-sm font-medium">
          {a('investors.statementHeading')}
        </h2>
        <DataTable<StatementEntry>
          caption={a('investors.statementCaption')}
          columns={statementColumns}
          data={statementQuery.data?.entries ?? []}
          getRowId={(row) => `${row.kind}:${row.reference}`}
          loading={statementQuery.isPending}
          error={statementQuery.error}
          onRetry={() => void statementQuery.refetch()}
          page={SINGLE_PAGE}
          onPageChange={() => undefined}
          sort={null}
          onSortChange={() => undefined}
          labels={tableLabels(
            t,
            a,
            'investors.statementEmptyTitle',
            'investors.statementEmptyDetail',
          )}
        />
      </section>

      <section aria-labelledby="documents-heading" className="space-y-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="documents-heading" className="text-sm font-medium">
            {a('investors.documentsHeading')}
          </h2>
          <p className="text-xs text-muted-foreground">{a('investors.documentHint')}</p>
        </div>
        {openError === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {openError}
          </p>
        )}
        <DataTable<DocumentRow>
          caption={a('investors.documentsCaption')}
          columns={documentColumns}
          data={documentQuery.data?.items ?? []}
          getRowId={(row) => row.id}
          loading={documentQuery.isPending}
          error={documentQuery.error}
          onRetry={() => void documentQuery.refetch()}
          page={SINGLE_PAGE}
          onPageChange={() => undefined}
          sort={null}
          onSortChange={() => undefined}
          labels={tableLabels(
            t,
            a,
            'investors.documentsEmptyTitle',
            'investors.documentsEmptyDetail',
          )}
        />
      </section>
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
