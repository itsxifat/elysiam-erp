import {
  DataTable,
  DateTime,
  Money,
  PermissionGate,
  Select,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { useMemo } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { useSchemaSearch } from '../orders/paths.js';
import {
  lapsedExportUrl,
  listLapsed,
  RFM_SEGMENTS,
  type LapsedBuyer,
  type LapsedFilters,
  type RfmSegment,
} from './api.js';
import { control, CustomersHeader, customersPath, useTableLabels } from './customers-nav.js';
import { isCustomersKey, useCustomersT } from './messages.js';
import { LAPSED_PAGE_SIZE, lapsedSearchSchema, type LapsedSearch } from './routes.js';

/**
 * Buyers who have not bought for a while, and the file a win-back campaign starts from
 * (M16; §10 "Re-engagement lists"; D-208).
 *
 * `export BuyerExport`, like the buyer list: this is the same kind of list. The count is
 * the server's for the same filters the file will contain, and opted-out numbers are in
 * neither — the subtitle says so, because a marketer comparing it with another list will
 * otherwise go looking for the missing rows.
 */
export function LapsedBuyersPage() {
  const ability = useAbility();
  const t = useCustomersT();
  return (
    <PermissionGate
      allowed={ability.can('export', 'BuyerExport')}
      explain={{
        title: t('customers.lapsed.deniedTitle'),
        detail: t('customers.lapsed.deniedDetail'),
      }}
    >
      <Lapsed />
    </PermissionGate>
  );
}

const DOWNLOAD =
  'inline-flex h-control-sm items-center gap-1.5 rounded-md border border-border px-2.5 text-sm font-medium hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

function Lapsed() {
  const t = useCustomersT();
  const { locale } = useLocale();
  const [search, setSearch] = useSchemaSearch(lapsedSearchSchema);
  const filters: LapsedFilters = {
    days: search.days,
    minDelivered: search.minDelivered,
    segment: search.segment,
  };

  const lapsed = useQuery({
    queryKey: ['customers', 'lapsed', search],
    queryFn: () => listLapsed(filters, LAPSED_PAGE_SIZE, (search.page - 1) * LAPSED_PAGE_SIZE),
  });

  function update(patch: Partial<LapsedSearch>) {
    const next: Record<string, unknown> = { ...search, ...patch, page: patch.page ?? 1 };
    if (next.segment === undefined) delete next.segment;
    setSearch(lapsedSearchSchema.parse(next));
  }

  const segmentLabel = (segment: string) => {
    const key = `customers.segment.${segment}`;
    return isCustomersKey(key) ? t(key) : segment;
  };

  const columns = useMemo<readonly DataTableColumn<LapsedBuyer>[]>(() => {
    const column = dataTableColumns<LapsedBuyer>();
    return column.columns([
      column.accessor('name', {
        header: t('customers.col.name'),
        cell: (cell) => (
          <Link
            to={customersPath(`/customers/${cell.row.original.customerId}`)}
            className="font-medium underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {cell.getValue()}
          </Link>
        ),
      }),
      column.accessor('phone', {
        header: t('customers.col.phone'),
        cell: (cell) => <span className="tabular-nums">{cell.getValue()}</span>,
      }),
      column.accessor('segment', {
        header: t('customers.col.segment'),
        cell: (cell) => {
          const value = cell.getValue();
          return value === null ? '—' : segmentLabel(value);
        },
      }),
      column.accessor('delivered', {
        header: t('customers.col.delivered'),
        meta: { numeric: true },
      }),
      column.accessor('ltvPoisha', {
        header: t('customers.col.ltv'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('lastOrderOn', {
        header: t('customers.col.lastOrder'),
        // A Dhaka calendar date; shown the way every other date on this screen is.
        cell: (cell) => <DateTime value={`${cell.getValue()}T00:00:00+06:00`} dateOnly />,
      }),
    ]);
    // `segmentLabel` closes over `t`, which is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale]);

  const total = lapsed.data?.total ?? null;
  const labels = useTableLabels(
    t('customers.lapsed.emptyTitle'),
    t('customers.lapsed.emptyDetail'),
    search.page,
  );

  return (
    <div className="space-y-5">
      <CustomersHeader
        title={t('customers.lapsed.title')}
        caption={t('customers.lapsed.subtitle')}
        actions={
          <>
            <span
              className="text-sm text-muted-foreground tabular-nums"
              role="status"
              data-testid="lapsed-count"
            >
              {t('customers.lapsed.count')}: {total === null ? '—' : String(total)}
            </span>
            <a href={lapsedExportUrl(filters, 'csv')} className={DOWNLOAD}>
              <Download aria-hidden="true" className="size-4" />
              {t('customers.lapsed.exportCsv')}
            </a>
            <a href={lapsedExportUrl(filters, 'xlsx')} className={DOWNLOAD}>
              <Download aria-hidden="true" className="size-4" />
              {t('customers.lapsed.exportXlsx')}
            </a>
            <a href={lapsedExportUrl(filters, 'meta_audience')} className={DOWNLOAD}>
              <Download aria-hidden="true" className="size-4" />
              {t('customers.lapsed.exportAudience')}
            </a>
          </>
        }
      />

      <DataTable
        columns={columns}
        data={lapsed.data?.items ?? []}
        getRowId={(row) => row.customerId}
        page={{
          page: search.page,
          pageSize: LAPSED_PAGE_SIZE,
          total,
          hasNext: total !== null && search.page * LAPSED_PAGE_SIZE < total,
        }}
        onPageChange={(page) => update({ page })}
        sort={null}
        onSortChange={() => undefined}
        loading={lapsed.isPending}
        error={lapsed.error}
        onRetry={() => void lapsed.refetch()}
        caption={t('customers.lapsed.title')}
        labels={labels}
        toolbar={
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              {t('customers.lapsed.days')}
              <input
                type="number"
                min={1}
                max={3650}
                inputMode="numeric"
                defaultValue={search.days}
                className={`${control} w-20 tabular-nums`}
                onChange={(event) => {
                  const days = Number(event.target.value);
                  if (Number.isInteger(days) && days >= 1 && days <= 3650) update({ days });
                }}
              />
            </label>
            <label className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              {t('customers.lapsed.minDelivered')}
              <input
                type="number"
                min={1}
                max={1000}
                inputMode="numeric"
                defaultValue={search.minDelivered}
                className={`${control} w-16 tabular-nums`}
                onChange={(event) => {
                  const minDelivered = Number(event.target.value);
                  if (Number.isInteger(minDelivered) && minDelivered >= 1) {
                    update({ minDelivered });
                  }
                }}
              />
            </label>
            <Select
              variant="filter"
              aria-label={t('customers.col.segment')}
              value={search.segment ?? ''}
              onValueChange={(value) =>
                update({ segment: (value || undefined) as RfmSegment | undefined })
              }
              options={[
                { value: '', label: t('customers.lapsed.allSegments') },
                ...RFM_SEGMENTS.map((segment) => ({
                  value: segment,
                  label: segmentLabel(segment),
                })),
              ]}
            />
            {lapsed.data === undefined ? null : (
              <span className="text-xs text-muted-foreground">
                {t('customers.lapsed.cutoff')}{' '}
                <DateTime value={`${lapsed.data.lastOrderOnOrBefore}T00:00:00+06:00`} dateOnly />
              </span>
            )}
          </div>
        }
      />
    </div>
  );
}
