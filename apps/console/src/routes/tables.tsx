import {
  Button,
  DataTable,
  DateTime,
  Money,
  PageHeader,
  SearchInput,
  Select,
  StatusBadge,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { getRouteApi } from '@tanstack/react-router';
import { useMemo } from 'react';

import { useLocale, useT } from '../i18n/locale.js';
import { formatSort, mergeSearch, parseSort } from '../lib/table-search.js';
import { queryDemoRows, type DemoRow } from './tables-data.js';

/**
 * The DataTable demo (M05 check 2, and the subject of checks 6, 7 and 10).
 *
 * Its job is to be the page the acceptance checks drive: filters, sort and page in
 * the URL and surviving a reload; a keyboard path to every control; an axe scan
 * with no serious violations; a screenshot in both themes.
 *
 * It runs against a fixed in-process dataset rather than a live endpoint, and that
 * is deliberate — the check is about the *table*, and a demo whose rows depend on
 * seed data makes a failing assertion ambiguous between "the URL state broke" and
 * "the fixture changed". What it does not fake is the shape of the contract:
 * `queryDemoRows` takes a filter, a sort and a page and returns one page plus a
 * total, exactly as a server-paginated endpoint does, so nothing in the table is
 * relying on having every row in hand.
 */

const route = getRouteApi('/tables');

export function TablesPage() {
  const t = useT();
  const { locale } = useLocale();
  const search = route.useSearch();
  const navigate = route.useNavigate();

  const result = useMemo(
    () =>
      queryDemoRows({
        query: search.q,
        status: search.status,
        sort: parseSort(search.sort),
        page: search.page,
        pageSize: search.pageSize,
      }),
    [search.q, search.status, search.sort, search.page, search.pageSize],
  );

  const columns = useMemo<readonly DataTableColumn<DemoRow>[]>(() => {
    const column = dataTableColumns<DemoRow>();
    return column.columns([
      column.accessor('reference', {
        header: t('demo.colReference'),
        meta: { sortable: true },
        cell: (cell) => <span className="font-mono text-xs">{String(cell.getValue())}</span>,
      }),
      column.accessor('channel', {
        header: t('demo.colChannel'),
        cell: (cell) => {
          const channel = cell.getValue();
          return t(`demo.channel.${channel}`);
        },
      }),
      column.accessor('status', {
        header: t('demo.colStatus'),
        cell: (cell) => {
          const status = cell.getValue();
          return (
            <StatusBadge
              tone={status === 'settled' ? 'success' : status === 'returned' ? 'danger' : 'info'}
            >
              {t(`demo.status.${status}`)}
            </StatusBadge>
          );
        },
      }),
      column.accessor('totalPoisha', {
        header: t('demo.colAmount'),
        // `numeric` is what puts `data-numeric` on the cell, which the base
        // stylesheet turns into tabular numerals and right alignment (check 9).
        meta: { numeric: true, sortable: true },
        cell: (cell) => <Money poisha={String(cell.getValue())} locale={locale} />,
      }),
      column.accessor('placedAt', {
        header: t('demo.colPlacedAt'),
        meta: { sortable: true },
        cell: (cell) => <DateTime value={String(cell.getValue())} />,
      }),
    ]) as readonly DataTableColumn<DemoRow>[];
  }, [t, locale]);

  const filtered = search.q !== undefined || search.status !== undefined;

  return (
    <div className="space-y-5">
      <PageHeader title={t('demo.title')} description={t('demo.subtitle')} />

      <DataTable<DemoRow>
        caption={t('demo.caption')}
        columns={columns}
        data={result.rows}
        getRowId={(row) => row.id}
        page={{
          page: search.page,
          pageSize: search.pageSize,
          total: result.total,
          hasNext: search.page * search.pageSize < result.total,
        }}
        onPageChange={(page) => void navigate({ search: mergeSearch(search, { page }) })}
        sort={parseSort(search.sort)}
        onSortChange={(sort) =>
          void navigate({ search: mergeSearch(search, { sort: formatSort(sort) }) })
        }
        toolbar={
          <>
            <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
              <span className="sr-only">{t('table.search')}</span>
              <SearchInput
                value={search.q ?? ''}
                placeholder={t('table.search')}
                className="sm:w-56"
                onChange={(event) =>
                  void navigate({
                    search: mergeSearch(search, {
                      q: event.target.value === '' ? undefined : event.target.value,
                    }),
                  })
                }
              />
            </label>

            <Select
              variant="filter"
              aria-label={t('table.filterStatus')}
              value={search.status ?? ''}
              onValueChange={(value) =>
                void navigate({
                  search: mergeSearch(search, {
                    status: value === '' ? undefined : value,
                  }),
                })
              }
              options={[
                { value: '', label: t('common.all') },
                { value: 'open', label: t('demo.status.open') },
                { value: 'settled', label: t('demo.status.settled') },
                { value: 'returned', label: t('demo.status.returned') },
              ]}
            />

            {filtered ? (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void navigate({
                    search: mergeSearch(search, { q: undefined, status: undefined, page: 1 }),
                  })
                }
              >
                {t('table.clearFilters')}
              </Button>
            ) : null}
          </>
        }
        labels={{
          columns: t('table.columns'),
          previous: t('table.previous'),
          next: t('table.next'),
          emptyTitle: t('table.emptyTitle'),
          emptyDetail: t('table.emptyDetail'),
          errorTitle: t('table.errorTitle'),
          errorDetail: t('table.errorDetail'),
          retry: t('common.retry'),
          pageStatus: `${t('table.page')} ${search.page} · ${result.total}`,
          sortAscending: t('table.sortAscending'),
          sortDescending: t('table.sortDescending'),
        }}
      />
    </div>
  );
}
