import { APPROVAL_TYPES } from '@elysium/contracts';
import {
  Button,
  ConfirmDialog,
  DataTable,
  Money,
  PageHeader,
  PermissionGate,
  Select,
  StatusBadge,
  cn,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi } from '@tanstack/react-router';
import { Radio } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useAbility } from '../auth/session.js';
import { listApprovals, decideApproval, type ApprovalRow } from '../api/approvals.js';
import { useLocale, useT } from '../i18n/locale.js';
import { useStaffNames } from '../staff-names.js';
import {
  APPROVAL_STATUS_OPTIONS,
  approvalTypeLabel,
  statusTone,
  statusKey,
} from './approvals-status.js';
import { formatSort, mergeSearch, parseSort, keysetPage } from '../lib/table-search.js';
import { useRealtime } from '../realtime/use-realtime.js';

/**
 * The approvals inbox — the first real screen, and the reason it is this one
 * (M05 plan, "Out of scope").
 *
 * It is the only page in the milestone that exercises the whole frame at once:
 * permission-gated (a role with no `read ApprovalRequest` sees the denied state,
 * not an empty table), money-bearing (integer poisha through `<Money>`, with the
 * withheld case that invariant 5 produces), realtime (a request raised elsewhere
 * appears without a refresh), and URL-driven (the status filter survives a
 * reload and travels in a link).
 *
 * The one thing it deliberately does **not** do is patch its own cache from the
 * realtime payload. §19 sends ids and a minimum of fields chosen to be safe for
 * the widest recipient role; the row this table renders has been through
 * `serializeFor()` for *this* role. Merging the first into the second is how a
 * cost-valued amount that was withheld from the response arrives anyway, through
 * the socket. So an event invalidates the query and the server answers again.
 */

const route = getRouteApi('/approvals');

export function ApprovalsPage() {
  const ability = useAbility();
  const t = useT();
  const { locale } = useLocale();
  const search = route.useSearch();
  const navigate = route.useNavigate();
  const queryClient = useQueryClient();

  const [pending, setPending] = useState<{
    readonly row: ApprovalRow;
    readonly decision: 'approved' | 'rejected';
  } | null>(null);

  const mayRead = ability.can('read', 'ApprovalRequest');
  const mayDecide = ability.can('approve', 'ApprovalRequest');

  /*
   * The cursor is derived from the page number by walking forward, because §23's
   * endpoint is keyset-paginated and a keyset cursor cannot be computed from "page
   * 4" — it is the last row of page 3. React Query caches each page under its own
   * key, so paging forward is one request and paging back is none.
   *
   * Page 1 has no cursor, which is the only page this screen can reach cold. That
   * is a real limitation of keyset pagination and the honest thing to do with it
   * is what the pager does: offer Previous and Next rather than page numbers, so
   * the URL's `page` is a position in a walk rather than a claim about the table.
   */
  const cursors = useCursorWalk();
  const cursor = cursors.get(search.page);

  const query = useQuery({
    queryKey: ['approvals', search.status, search.type, search.pageSize, cursor ?? null],
    queryFn: () =>
      listApprovals({
        status: search.status,
        type: search.type,
        limit: search.pageSize,
        cursor,
      }),
    enabled: mayRead && (search.page === 1 || cursor !== undefined),
  });

  if (query.data?.nextCursor != null) cursors.remember(search.page + 1, query.data.nextCursor);

  const status = useRealtime({
    events: ['approval.requested', 'approval.decided'],
    enabled: mayRead,
    onEvent: () => {
      // Invalidate, never patch. See the note at the top of the file.
      void queryClient.invalidateQueries({ queryKey: ['approvals'] });
    },
  });

  const staff = useStaffNames((query.data?.rows ?? []).map((row) => row.requestedBy));

  const columns = useMemo<readonly DataTableColumn<ApprovalRow>[]>(() => {
    const column = dataTableColumns<ApprovalRow>();
    return column.columns([
      column.accessor('type', {
        header: t('approvals.colType'),
        meta: { sortable: true },
        cell: (cell) => approvalTypeLabel(cell.getValue(), t),
      }),
      column.accessor('status', {
        header: t('approvals.colStatus'),
        cell: (cell) => {
          const value = cell.getValue();
          return <StatusBadge tone={statusTone(value)}>{t(statusKey(value))}</StatusBadge>;
        },
      }),
      column.accessor('amountPoisha', {
        header: t('approvals.colAmount'),
        meta: { numeric: true },
        cell: (cell) => {
          const row = cell.row.original;
          /*
           * Three distinct states, and collapsing any two of them is a lie:
           *   - withheld: this role may not see the amount (invariant 5)
           *   - null:     the type has no amount at all
           *   - a string: integer poisha
           * A `0` in a money column is a fact; an em dash with no explanation
           * reads as one.
           */
          if (row.amountWithheld) return <Money poisha="0" locale={locale} withheld />;
          if (row.amountPoisha === null)
            return <span className="text-muted-foreground">&mdash;</span>;
          return <Money poisha={row.amountPoisha} locale={locale} />;
        },
      }),
      column.accessor('requestedBy', {
        header: t('approvals.colRequestedBy'),
        // D-898: the person by name, never a piece of their id.
        cell: (cell) => (
          <span className="text-muted-foreground">{staff(cell.getValue()) ?? '—'}</span>
        ),
      }),
      column.accessor('branchId', {
        header: t('approvals.colBranch'),
        cell: (cell) =>
          cell.getValue() === null ? (
            <span className="text-muted-foreground">{t('approvals.wholeOrg')}</span>
          ) : (
            <span className="font-mono text-xs">{String(cell.getValue()).slice(0, 8)}</span>
          ),
      }),
      column.display({
        id: 'decision',
        header: t('approvals.colActions'),
        cell: (cell) => {
          const row = cell.row.original;
          // Only a pending request can be decided, and only by a checker. The
          // gate is a kindness, not the control: the route's
          // `@RequireAbility('approve', 'ApprovalRequest')` is what actually
          // refuses, and the service checks the type against CHECKER_TYPES.
          if (row.status !== 'pending') return null;
          return (
            <PermissionGate allowed={mayDecide}>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setPending({ row, decision: 'approved' })}
                >
                  {t('approvals.approve')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPending({ row, decision: 'rejected' })}
                >
                  {t('approvals.reject')}
                </Button>
              </div>
            </PermissionGate>
          );
        },
      }),
    ]) as readonly DataTableColumn<ApprovalRow>[];
  }, [t, locale, mayDecide, staff]);

  if (!mayRead) {
    return (
      <PermissionGate
        allowed={false}
        explain={{ title: t('approvals.deniedTitle'), detail: t('approvals.deniedDetail') }}
      >
        {null}
      </PermissionGate>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('approvals.title')}
        description={t('approvals.subtitle')}
        meta={
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <Radio
              aria-hidden="true"
              className={cn(
                'size-3.5',
                status === 'connected' ? 'text-success' : 'text-muted-foreground',
              )}
            />
            {status === 'connected' ? t('approvals.live') : t('approvals.reconnecting')}
          </span>
        }
      />

      <DataTable<ApprovalRow>
        caption={t('approvals.caption')}
        columns={columns}
        data={query.data?.rows ?? []}
        getRowId={(row) => row.id}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        page={keysetPage(search, query.data?.nextCursor != null)}
        onPageChange={(page) => void navigate({ search: mergeSearch(search, { page }) })}
        sort={parseSort(search.sort)}
        onSortChange={(sort) =>
          void navigate({ search: mergeSearch(search, { sort: formatSort(sort) }) })
        }
        toolbar={
          <>
            <FilterSelect
              label={t('table.filterStatus')}
              value={search.status ?? ''}
              options={APPROVAL_STATUS_OPTIONS.map((value) => ({
                value,
                label: t(statusKey(value)),
              }))}
              allLabel={t('common.all')}
              onChange={(value) =>
                void navigate({
                  search: mergeSearch(search, { status: value === '' ? undefined : value }),
                })
              }
            />
            <FilterSelect
              label={t('table.filterType')}
              value={search.type ?? ''}
              options={APPROVAL_TYPES.map((value) => ({
                value,
                label: approvalTypeLabel(value, t),
              }))}
              allLabel={t('common.all')}
              onChange={(value) =>
                void navigate({
                  search: mergeSearch(search, { type: value === '' ? undefined : value }),
                })
              }
            />
            {search.status === undefined && search.type === undefined ? null : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() =>
                  void navigate({
                    search: mergeSearch(search, { status: undefined, type: undefined, page: 1 }),
                  })
                }
              >
                {t('table.clearFilters')}
              </Button>
            )}
          </>
        }
        labels={{
          columns: t('table.columns'),
          previous: t('table.previous'),
          next: t('table.next'),
          emptyTitle: t('approvals.emptyTitle'),
          emptyDetail: t('approvals.emptyDetail'),
          errorTitle: t('table.errorTitle'),
          errorDetail: t('table.errorDetail'),
          retry: t('common.retry'),
          pageStatus: `${t('table.page')} ${search.page}`,
          sortAscending: t('table.sortAscending'),
          sortDescending: t('table.sortDescending'),
        }}
      />

      <ConfirmDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
        destructive={pending?.decision === 'rejected'}
        title={t(
          pending?.decision === 'rejected' ? 'approvals.rejectTitle' : 'approvals.approveTitle',
        )}
        description={t(
          pending?.decision === 'rejected' ? 'approvals.rejectDetail' : 'approvals.approveDetail',
        )}
        confirmLabel={t(
          pending?.decision === 'rejected' ? 'approvals.reject' : 'approvals.approve',
        )}
        cancelLabel={t('common.cancel')}
        closeLabel={t('common.close')}
        onConfirm={async () => {
          if (pending === null) return;
          await decideApproval(pending.row.id, pending.decision);
          await queryClient.invalidateQueries({ queryKey: ['approvals'] });
          setPending(null);
        }}
      >
        {pending === null ? null : (
          <dl className="space-y-1.5 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('approvals.colType')}</dt>
              <dd className="font-medium">{approvalTypeLabel(pending.row.type, t)}</dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-muted-foreground">{t('approvals.colAmount')}</dt>
              <dd>
                {pending.row.amountWithheld ? (
                  <Money poisha="0" locale={locale} withheld />
                ) : pending.row.amountPoisha === null ? (
                  <span className="text-muted-foreground">&mdash;</span>
                ) : (
                  <Money poisha={pending.row.amountPoisha} locale={locale} />
                )}
              </dd>
            </div>
          </dl>
        )}
      </ConfirmDialog>
    </div>
  );
}

/**
 * The cursors seen so far, by page number.
 *
 * A plain `Map` in a ref rather than state: remembering a cursor must not cause a
 * render, or the render that discovered it would loop. Losing the map on reload is
 * correct — a cold load of `?page=4` has no cursor for page 4 and cannot invent
 * one, so the query is disabled and the pager starts the walk again.
 */
function useCursorWalk() {
  const [store] = useState(() => new Map<number, string>());
  return {
    get: (page: number) => (page === 1 ? undefined : store.get(page)),
    remember: (page: number, cursor: string) => store.set(page, cursor),
  };
}

/** A list filter: the kit's select, its name printed inside it (D-443). */
function FilterSelect({
  label,
  value,
  options,
  allLabel,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly options: readonly { value: string; label: string }[];
  readonly allLabel: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <Select
      variant="filter"
      aria-label={label}
      value={value}
      onValueChange={onChange}
      leading={<span className="text-xs font-medium">{label}</span>}
      options={[{ value: '', label: allLabel }, ...options]}
    />
  );
}
