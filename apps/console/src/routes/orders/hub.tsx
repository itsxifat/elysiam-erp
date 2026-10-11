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
  Select,
  Skeleton,
  TabList,
  buttonVariants,
  cn,
  controlClassName,
  tabActiveClassName,
  tabClassName,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { PackageCheck, Printer, ScanLine, Tag, Truck, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { z } from 'zod';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/workflow.js';
import { useScanHandler } from '../../lib/scanner.js';
import { listLocations } from '../courier/api.js';
import { bulkTransition, documentsUrl } from './api.js';
import { LiveIndicator, OrdersNav, useOrderEvents } from './parts.js';
import { ordersPath, useSchemaSearch } from './paths.js';
import { listQueue, markPrinted, myDesk, type QueuedOrder } from './workflow-api.js';
import { addToHandover, type HandoverEntry } from './workflow-logic.js';

/**
 * The fulfilment hub (M41, D-719): confirmed orders at the hub's stock location, stage by stage.
 *
 * **To print**: select and print the packing slips (the existing documents endpoint, which stays
 * a read), then they are marked printed and move to **Packing**, where each opens in the packing
 * station. **Packed** parcels are handed to the courier from a scan list: scan each slip as the
 * parcel goes, then hand them all over through the ship transition. **Handed to courier** is
 * today's. The hub's location comes from the person's desk profile; one without a hub picks.
 */

const HUB_TABS = ['hub_print', 'hub_packing', 'hub_packed', 'hub_handed'] as const;
type HubTab = (typeof HUB_TABS)[number];

const hubSearchSchema = z.object({
  tab: z.enum(HUB_TABS).catch('hub_print'),
  location: z.string().uuid().optional().catch(undefined),
});

const TAB_LABEL: Readonly<Record<HubTab, MessageKey>> = {
  hub_print: 'wf.hub.to_print',
  hub_packing: 'wf.hub.packing',
  hub_packed: 'wf.hub.packed',
  hub_handed: 'wf.hub.handed_over',
};

export function HubPage() {
  const ability = useAbility();
  const t = useT();
  return (
    <PermissionGate
      allowed={ability.can('update', 'Order')}
      explain={{ title: t('wf.hubPage.title'), detail: t('wf.hubPage.denied') }}
    >
      <Hub />
    </PermissionGate>
  );
}

function Hub() {
  const t = useT();
  const id = useId();
  const live = useOrderEvents();
  const [search, setSearch] = useSchemaSearch(hubSearchSchema);
  const desk = useQuery({ queryKey: ['team', 'me'], queryFn: myDesk });
  const locations = useQuery({ queryKey: ['inventory', 'locations'], queryFn: listLocations });
  const hub = desk.data?.profile.hubLocationId ?? null;
  const location = search.location ?? hub ?? '';
  const options = [
    ...(hub === null ? [{ value: '', label: t('wf.hubPage.allLocations') }] : []),
    ...(locations.data?.items ?? [])
      .filter((place) => place.isActive && ['warehouse', 'showroom'].includes(place.kind))
      .map((place) => ({ value: place.id, label: place.name })),
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('wf.hubPage.title')}
        description={t('wf.hubPage.subtitle')}
        meta={<LiveIndicator status={live} />}
        tabs={<OrdersNav />}
        actions={
          <label className="flex items-center gap-2 text-sm" htmlFor={`${id}-location`}>
            <span className="text-muted-foreground">{t('wf.hubPage.location')}</span>
            <Select
              id={`${id}-location`}
              size="sm"
              value={location}
              onValueChange={(value) =>
                setSearch({ tab: search.tab, ...(value === '' ? {} : { location: value }) })
              }
              options={options}
              placeholder={t('wf.hubPage.allLocations')}
            />
          </label>
        }
      />
      <TabList label={t('wf.hubPage.title')}>
        {HUB_TABS.map((value) => (
          <button
            key={value}
            type="button"
            aria-current={search.tab === value ? 'page' : undefined}
            data-testid={`hub-tab-${value}`}
            className={cn(tabClassName, search.tab === value ? tabActiveClassName : null)}
            onClick={() =>
              setSearch({
                tab: value,
                ...(search.location === undefined ? {} : { location: search.location }),
              })
            }
          >
            {t(TAB_LABEL[value])}
          </button>
        ))}
      </TabList>
      <Stage tab={search.tab} locationId={location === '' ? undefined : location} />
    </div>
  );
}

function Stage({
  tab,
  locationId,
}: {
  readonly tab: HubTab;
  readonly locationId: string | undefined;
}) {
  const t = useT();
  const queue = useQuery({
    queryKey: ['orders', 'hub', tab, locationId ?? 'all'],
    queryFn: () => listQueue(tab, { locationId }),
    refetchInterval: 30_000,
  });

  if (queue.isPending) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label={t('wf.loading')}>
        {[0, 1, 2].map((row) => (
          <Skeleton key={row} className="h-row w-full" />
        ))}
      </div>
    );
  }
  if (queue.isError) {
    return (
      <ErrorState
        title={t('wf.failed')}
        action={
          <Button variant="outline" size="sm" onClick={() => void queue.refetch()}>
            {t('wf.retry')}
          </Button>
        }
      />
    );
  }
  const items = queue.data.items;
  if (tab === 'hub_print') return <ToPrint items={items} />;
  if (tab === 'hub_packed') return <Handover items={items} />;
  if (items.length === 0) {
    return <EmptyState title={t('wf.hubPage.emptyTitle')} detail={t('wf.hubPage.emptyDetail')} />;
  }
  return <HubTable items={items} action={tab === 'hub_packing' ? 'pack' : null} />;
}

function HubTable({
  items,
  action,
  selected,
  onToggle,
}: {
  readonly items: readonly QueuedOrder[];
  readonly action: 'pack' | null;
  readonly selected?: ReadonlySet<string>;
  readonly onToggle?: (id: string) => void;
}) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-sm" data-testid="hub-table">
        <thead>
          <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
            {selected === undefined ? null : <th className="w-10 px-3 py-2" />}
            <th className="px-3 py-2 font-medium">{t('wf.order')}</th>
            <th className="px-3 py-2 font-medium">{t('wf.customer')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('wf.items')}</th>
            <th className="px-3 py-2 text-right font-medium">{t('wf.cod')}</th>
            <th className="px-3 py-2 font-medium">{t('wf.waitingSince')}</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody>
          {items.map((order) => (
            <tr
              key={order.id}
              className="h-row border-b border-border last:border-b-0"
              data-order-id={order.id}
            >
              {selected === undefined || onToggle === undefined ? null : (
                <td className="px-3">
                  <Checkbox
                    checked={selected.has(order.id)}
                    onCheckedChange={() => onToggle(order.id)}
                    aria-label={`${t('wf.hubPage.select')} ${order.orderNo}`}
                  />
                </td>
              )}
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
                <DateTime value={order.timestamps.confirmedAt ?? order.timestamps.createdAt} />
              </td>
              <td className="px-3 py-1 text-right">
                {action === 'pack' ? (
                  <Link
                    to={ordersPath('/orders/packing')}
                    search={{ order: order.id } as never}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    <PackageCheck aria-hidden="true" />
                    {t('wf.hubPage.pack')}
                  </Link>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ToPrint({ items }: { readonly items: readonly QueuedOrder[] }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const ids = items.filter((order) => selected.has(order.id)).map((order) => order.id);
  const every = items.length > 0 && ids.length === items.length;

  const printed = useMutation({
    mutationFn: (chosen: readonly string[]) => markPrinted(chosen),
    onSuccess: async () => {
      setSelected(new Set());
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  if (items.length === 0) {
    return <EmptyState title={t('wf.hubPage.emptyTitle')} detail={t('wf.hubPage.emptyDetail')} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={every}
            onCheckedChange={() =>
              setSelected(every ? new Set() : new Set(items.map((order) => order.id)))
            }
            aria-label={t('wf.hubPage.selectAll')}
          />
          {t('wf.hubPage.selectAll')}
        </label>
        <span className="text-sm text-muted-foreground tabular-nums">
          {ids.length} {t('wf.hubPage.selected')}
        </span>
        <Button
          size="sm"
          disabled={ids.length === 0 || printed.isPending}
          data-testid="print-slips"
          onClick={() => {
            // The slips open as one PDF for the print dialog; then they move on to Packing.
            window.open(documentsUrl(ids, 'packing_slip'), '_blank', 'noopener');
            printed.mutate(ids);
          }}
        >
          <Printer aria-hidden="true" />
          {t('wf.hubPage.printSlips')}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={ids.length === 0}
          onClick={() => window.open(documentsUrl(ids, 'label'), '_blank', 'noopener')}
        >
          <Tag aria-hidden="true" />
          {t('wf.hubPage.printLabels')}
        </Button>
      </div>
      <HubTable
        items={items}
        action={null}
        selected={selected}
        onToggle={(id) =>
          setSelected((current) => {
            const next = new Set(current);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          })
        }
      />
    </div>
  );
}

function Handover({ items }: { readonly items: readonly QueuedOrder[] }) {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [code, setCode] = useState('');
  const [list, setList] = useState<readonly HandoverEntry[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const packed = useMemo(
    () => items.map((order) => ({ id: order.id, orderNo: order.orderNo })),
    [items],
  );

  const add = (raw: string) => {
    const result = addToHandover(list, raw, packed);
    if (result.ok) {
      setList(result.list);
      setNotice(null);
    } else {
      setNotice(
        `${result.code} ${result.reason === 'already' ? t('wf.hubPage.already') : t('wf.hubPage.notPacked')}`,
      );
    }
    setCode('');
  };
  // A barcode scanner types the slip's number and Enter anywhere on the page.
  useScanHandler(add);

  const ship = useMutation({
    mutationFn: () =>
      bulkTransition(
        list.map((entry) => entry.id),
        'ship',
      ),
    onSuccess: async (result) => {
      const refused = result.results.filter((row) => !row.ok);
      setNotice(
        `${String(result.moved)} ${t('wf.hubPage.parcels')} ${t('wf.hubPage.handedOver')}` +
          (refused.length === 0 ? '' : ` ${String(refused.length)} ${t('wf.hubPage.refused')}`),
      );
      setList((current) => current.filter((entry) => refused.some((row) => row.id === entry.id)));
      await queryClient.invalidateQueries({ queryKey: ['orders'] });
    },
  });

  return (
    <div className="space-y-4">
      <section
        aria-labelledby={`${id}-title`}
        className="space-y-3 rounded-lg border border-border bg-card p-5"
        data-testid="handover"
      >
        <h2 id={`${id}-title`} className="flex items-center gap-2 text-base font-semibold">
          <Truck aria-hidden="true" className="size-4" />
          {t('wf.hubPage.handover')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('wf.hubPage.scanHint')}</p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.trim() !== '') add(code);
          }}
        >
          <label className="block min-w-64 flex-1 space-y-1.5 text-sm" htmlFor={`${id}-code`}>
            <span className="font-medium">{t('wf.hubPage.scan')}</span>
            <input
              id={`${id}-code`}
              value={code}
              autoComplete="off"
              className={`${controlClassName} w-full tabular-nums`}
              onChange={(event) => setCode(event.target.value)}
            />
          </label>
          <Button type="submit" variant="outline" size="md">
            <ScanLine aria-hidden="true" />
            {t('wf.hubPage.add')}
          </Button>
        </form>
        {notice === null ? null : (
          <p role="status" className="text-sm text-muted-foreground" data-testid="handover-notice">
            {notice}
          </p>
        )}
        {list.length === 0 ? null : (
          <ul
            className="divide-y divide-border rounded-md border border-border text-sm"
            data-testid="handover-list"
          >
            {list.map((entry) => (
              <li key={entry.id} className="flex h-row items-center justify-between px-3">
                <span className="font-medium tabular-nums">{entry.orderNo}</span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${t('wf.hubPage.remove')} ${entry.orderNo}`}
                  onClick={() => setList((current) => current.filter((one) => one.id !== entry.id))}
                >
                  <X aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <Button
          disabled={list.length === 0 || ship.isPending}
          data-testid="hand-over"
          onClick={() => ship.mutate()}
        >
          <Truck aria-hidden="true" />
          {t('wf.hubPage.handOverN')} {list.length} {t('wf.hubPage.parcels')}
        </Button>
      </section>
      {items.length === 0 ? (
        <EmptyState title={t('wf.hubPage.emptyTitle')} detail={t('wf.hubPage.emptyDetail')} />
      ) : (
        <HubTable items={items} action={null} />
      )}
    </div>
  );
}
