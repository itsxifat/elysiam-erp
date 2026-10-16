import type { MessageKey } from '@elysium/i18n';
import {
  Button,
  Checkbox,
  DateTime,
  EmptyState,
  ErrorState,
  Money,
  PageHeader,
  PermissionGate,
  Skeleton,
  TabList,
  cn,
  tabActiveClassName,
  tabClassName,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PackageCheck } from 'lucide-react';
import { z } from 'zod';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/pack-station.js';
import { IpCamerasSettings } from '../orders/pack-cameras.js';
import { PackStation } from '../orders/pack-station.js';
import { packingSettings, savePackingSettings } from '../orders/pack-station-api.js';
import { ordersPath, useSchemaSearch } from '../orders/paths.js';
import { listQueue, type QueuedOrder } from '../orders/workflow-api.js';
import { HandoverPanel } from './handover-panel.js';
import { LocationSelect, ThisComputer, useHubLocations, useLabelEvents } from './parts.js';
import { TerminalsPanel } from './terminals-panel.js';

/**
 * Packaging (M46, D-800): the packing terminals' own area. To pack (labels printed), the
 * packing station of this terminal, packed parcels, the courier's handover lot by lot, the
 * packing terminals with their live cards, and the IP cameras (moved from Orders → Pack →
 * Settings). M41's hub stages live here now, at the person's hub location.
 */

const TABS = ['topack', 'packing', 'packed', 'handover', 'terminals', 'cameras'] as const;
type Tab = (typeof TABS)[number];

const searchSchema = z.object({
  tab: z.enum(TABS).catch('topack'),
  order: z.string().uuid().optional().catch(undefined),
  location: z.string().uuid().optional().catch(undefined),
});

export function PackagingPage() {
  const ability = useAbility();
  const t = useT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'PackingTerminal')}
      explain={{ title: t('lb.packaging.title'), detail: t('lb.labels.denied') }}
    >
      <Packaging />
    </PermissionGate>
  );
}

function Packaging() {
  const t = useT();
  const [search, setSearch] = useSchemaSearch(searchSchema);
  const { hub } = useHubLocations();
  useLabelEvents({ sounds: false });
  const location = search.location ?? hub ?? '';
  const go = (next: Partial<z.infer<typeof searchSchema>>) => {
    const merged = { ...search, ...next };
    setSearch({
      tab: merged.tab,
      ...(merged.order === undefined ? {} : { order: merged.order }),
      ...(merged.location === undefined ? {} : { location: merged.location }),
    });
  };
  return (
    <div className="space-y-5">
      <PageHeader
        title={t('lb.packaging.title')}
        description={t('lb.packaging.subtitle')}
        actions={
          <div className="flex flex-wrap items-center gap-3">
            <ThisComputer />
            <LocationSelect
              value={location}
              onChange={(value) => go({ location: value === '' ? undefined : value })}
            />
          </div>
        }
      />
      <TabList label={t('lb.packaging.title')}>
        {TABS.map((value) => (
          <button
            key={value}
            type="button"
            aria-current={search.tab === value ? 'page' : undefined}
            data-testid={`packaging-tab-${value}`}
            className={cn(tabClassName, search.tab === value ? tabActiveClassName : null)}
            onClick={() =>
              go({ tab: value, order: value === 'packing' ? search.order : undefined })
            }
          >
            {t(`lb.ptab.${value}` as MessageKey)}
          </button>
        ))}
      </TabList>
      <Body
        tab={search.tab}
        order={search.order}
        locationId={location === '' ? undefined : location}
        onPack={(order) => go({ tab: 'packing', order })}
        onOrder={(order) => go({ tab: 'packing', order })}
      />
    </div>
  );
}

function Body({
  tab,
  order,
  locationId,
  onPack,
  onOrder,
}: {
  readonly tab: Tab;
  readonly order: string | undefined;
  readonly locationId: string | undefined;
  readonly onPack: (orderId: string) => void;
  readonly onOrder: (orderId: string | undefined) => void;
}) {
  switch (tab) {
    case 'topack':
      return <Stage queue="hub_packing" locationId={locationId} onPack={onPack} />;
    case 'packing':
      return <PackStation order={order} onOrder={onOrder} />;
    case 'packed':
      return <Stage queue="hub_packed" locationId={locationId} onPack={undefined} />;
    case 'handover':
      return <HandoverPanel locationId={locationId} />;
    case 'terminals':
      return <TerminalsPanel kind="packing" />;
    case 'cameras':
      return <Cameras />;
  }
}

function Stage({
  queue,
  locationId,
  onPack,
}: {
  readonly queue: 'hub_packing' | 'hub_packed';
  readonly locationId: string | undefined;
  readonly onPack: ((orderId: string) => void) | undefined;
}) {
  const t = useT();
  const { locale } = useLocale();
  const orders = useQuery({
    queryKey: ['orders', 'hub', queue, locationId ?? 'all'],
    queryFn: () => listQueue(queue, { locationId }),
    refetchInterval: 30_000,
  });
  if (orders.isPending) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label={t('lb.loading')}>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-row w-full" />
        ))}
      </div>
    );
  }
  if (orders.isError) {
    return (
      <ErrorState
        title={t('lb.failed')}
        action={
          <Button variant="outline" size="sm" onClick={() => void orders.refetch()}>
            {t('lb.retry')}
          </Button>
        }
      />
    );
  }
  const items: readonly QueuedOrder[] = orders.data.items;
  if (items.length === 0) {
    return queue === 'hub_packing' ? (
      <EmptyState title={t('lb.topack.empty')} detail={t('lb.topack.emptyDetail')} />
    ) : (
      <EmptyState title={t('lb.packed.empty')} detail={t('lb.packed.emptyDetail')} />
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm" data-testid={`stage-${queue}`}>
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">{t('lb.col.order')}</th>
            <th className="px-3 py-2 font-medium">{t('lb.col.customer')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('lb.col.items')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('lb.col.cod')}</th>
            <th className="px-3 py-2 font-medium">{t('lb.col.waiting')}</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {items.map((order) => (
            <tr key={order.id} className="h-row border-b border-border last:border-b-0">
              <td className="px-3">
                <Link
                  to={ordersPath(`/orders/${order.id}`)}
                  className="font-medium tabular-nums underline-offset-4 hover:underline"
                >
                  {order.orderNo}
                </Link>
              </td>
              <td className="px-3">{order.customer.name}</td>
              <td className="px-3 text-right tabular-nums">{order.itemCount}</td>
              <td className="px-3 text-right">
                <Money poisha={order.amounts.codAmountPoisha} locale={locale} />
              </td>
              <td className="px-3">
                <DateTime
                  value={
                    order.slipPrintedAt ??
                    order.timestamps.confirmedAt ??
                    order.timestamps.createdAt
                  }
                />
              </td>
              <td className="px-3 py-1 text-right">
                {onPack === undefined ? null : (
                  <Button size="sm" variant="outline" onClick={() => onPack(order.id)}>
                    <PackageCheck aria-hidden />
                    {t('lb.pack')}
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Packaging → Cameras: the brand's recording switch and its IP cameras (M38c, D-668). */
function Cameras() {
  const t = useT();
  const queryClient = useQueryClient();
  const settings = useQuery({ queryKey: ['packing', 'settings'], queryFn: packingSettings });
  const save = useMutation({
    mutationFn: savePackingSettings,
    onSuccess: (next) => queryClient.setQueryData(['packing', 'settings'], next),
  });
  return (
    <div className="space-y-5">
      {settings.data === undefined ? null : (
        <section className="space-y-2 rounded-lg border border-border bg-card p-5">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox
              checked={settings.data.videoEnabled}
              disabled={!settings.data.canEdit || save.isPending}
              onCheckedChange={(value) => save.mutate(value === true)}
            />
            {t('ps.settings.video')}
          </label>
          <p className="text-xs text-muted-foreground">{t('ps.settings.videoHelp')}</p>
        </section>
      )}
      <IpCamerasSettings />
    </div>
  );
}
