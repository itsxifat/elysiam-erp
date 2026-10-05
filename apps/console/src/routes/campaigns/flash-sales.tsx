import {
  Button,
  buttonVariants,
  DataTable,
  PermissionGate,
  StatusBadge,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useMemo } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import {
  duplicateFlashSale,
  listFlashSales,
  setFlashSaleEnabled,
  type FlashSaleStatus,
  type FlashSaleSummary,
} from './api.js';
import {
  CampaignsHeader,
  campaignsPath,
  singlePage,
  useCampaignTableLabels,
} from './campaigns-nav.js';
import { dhakaText } from './dhaka-time.js';
import { useCampaignsT, type CampaignsMessageKey } from './messages.js';

/**
 * Flash sales (M35a, D-542): the list, switching a sale on or off, and starting the next one
 * from a copy. The editor is `flash-sale-editor.tsx`.
 *
 * The same `LandingPage` grant as the discounts: marketing and org_admin read and change
 * them. Sold counts are what checkout has claimed; a cancelled or returned order's units
 * are back in them.
 */
export function FlashSalesPage() {
  const ability = useAbility();
  const t = useCampaignsT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'LandingPage')}
      explain={{
        title: t('campaigns.flash.deniedTitle'),
        detail: t('campaigns.codes.deniedDetail'),
      }}
    >
      <FlashSales />
    </PermissionGate>
  );
}

export const FLASH_TONE: Record<FlashSaleStatus, 'success' | 'info' | 'neutral' | 'warning'> = {
  live: 'success',
  scheduled: 'info',
  draft: 'neutral',
  ended: 'warning',
};

function FlashSales() {
  const t = useCampaignsT();
  const { locale } = useLocale();
  const ability = useAbility();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canUpdate = ability.can('update', 'LandingPage');
  const canCreate = ability.can('create', 'LandingPage');

  const sales = useQuery({
    queryKey: ['campaigns', 'flash-sales'],
    queryFn: listFlashSales,
    // Units sell while the list is open; keep the counts honest.
    refetchInterval: 30_000,
  });

  const toggle = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      setFlashSaleEnabled(id, enabled),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['campaigns', 'flash-sales'] });
    },
  });

  const duplicate = useMutation({
    mutationFn: (id: string) => duplicateFlashSale(id),
    onSuccess: async (copy) => {
      await queryClient.invalidateQueries({ queryKey: ['campaigns', 'flash-sales'] });
      await navigate({ to: campaignsPath(`/campaigns/flash-sales/${copy.id}`) });
    },
  });

  const columns = useMemo<readonly DataTableColumn<FlashSaleSummary>[]>(() => {
    const column = dataTableColumns<FlashSaleSummary>();
    return column.columns([
      column.display({
        id: 'title',
        header: t('campaigns.flash.col.sale'),
        cell: (cell) => (
          <span className="flex flex-col">
            <Link
              to={campaignsPath(`/campaigns/flash-sales/${cell.row.original.id}`)}
              className="font-medium text-foreground underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {cell.row.original.title}
            </Link>
            <span className="font-mono text-xs text-muted-foreground">
              /{cell.row.original.slug}
            </span>
          </span>
        ),
      }),
      column.accessor('status', {
        header: t('campaigns.codes.col.status'),
        cell: (cell) => (
          <StatusBadge tone={FLASH_TONE[cell.getValue()]}>
            {t(`campaigns.flash.status.${cell.getValue()}` as CampaignsMessageKey)}
          </StatusBadge>
        ),
      }),
      column.display({
        id: 'window',
        header: t('campaigns.flash.col.window'),
        cell: (cell) => {
          const { startsAt, endsAt } = cell.row.original;
          if (startsAt === null && endsAt === null) return t('campaigns.flash.noEnd');
          return (
            <span className="tabular-nums">
              {startsAt === null ? '…' : dhakaText(startsAt, locale)} –{' '}
              {endsAt === null ? '…' : dhakaText(endsAt, locale)}
            </span>
          );
        },
      }),
      column.accessor('skus', {
        header: t('campaigns.flash.col.skus'),
        meta: { numeric: true },
        cell: (cell) => <span className="tabular-nums">{cell.getValue()}</span>,
      }),
      column.display({
        id: 'sold',
        header: t('campaigns.flash.col.sold'),
        meta: { numeric: true },
        cell: (cell) => {
          const { unitsSold, unitsOffered } = cell.row.original;
          return (
            <span className="tabular-nums">
              {unitsSold} / {unitsOffered ?? t('campaigns.flash.allStock')}
            </span>
          );
        },
      }),
      column.display({
        id: 'actions',
        header: t('campaigns.codes.col.actions'),
        cell: (cell) => {
          const sale = cell.row.original;
          const busy =
            (toggle.isPending && toggle.variables.id === sale.id) ||
            (duplicate.isPending && duplicate.variables === sale.id);
          return (
            <span className="inline-flex gap-1">
              {canUpdate ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy || (!sale.enabled && sale.skus === 0)}
                  onClick={() => toggle.mutate({ id: sale.id, enabled: !sale.enabled })}
                >
                  {sale.enabled ? t('campaigns.flash.switchOff') : t('campaigns.flash.switchOn')}
                </Button>
              ) : null}
              {canCreate ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => duplicate.mutate(sale.id)}
                >
                  {t('campaigns.flash.duplicate')}
                </Button>
              ) : null}
            </span>
          );
        },
      }),
    ]);
  }, [t, locale, canUpdate, canCreate, toggle, duplicate]);

  const labels = useCampaignTableLabels(
    t('campaigns.flash.emptyTitle'),
    t('campaigns.flash.emptyDetail'),
  );

  return (
    <div className="space-y-5">
      <CampaignsHeader
        title={t('campaigns.nav.flash')}
        caption={t('campaigns.flash.subtitle')}
        actions={
          canCreate ? (
            <Link
              to={campaignsPath('/campaigns/flash-sales/new')}
              className={buttonVariants({ variant: 'primary', size: 'sm' })}
            >
              <Plus aria-hidden="true" />
              {t('campaigns.flash.new')}
            </Link>
          ) : undefined
        }
      />
      <DataTable
        columns={columns}
        data={sales.data?.items ?? []}
        getRowId={(row) => row.id}
        page={singlePage(sales.data?.items.length ?? 0)}
        onPageChange={() => undefined}
        sort={null}
        onSortChange={() => undefined}
        loading={sales.isPending}
        error={sales.error}
        onRetry={() => void sales.refetch()}
        caption={t('campaigns.nav.flash')}
        labels={labels}
      />
    </div>
  );
}
