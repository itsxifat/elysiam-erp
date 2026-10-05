import {
  Button,
  ConfirmDialog,
  controlClassName,
  DateTime,
  Dialog,
  Money,
  PageHeader,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ImageOff, Smartphone } from 'lucide-react';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/packing.js';
import { CopyButton } from '../../ui/copy-button.js';
import { ScanField } from '../catalog/scan-field.js';
import {
  listDevices,
  lookupShipment,
  pairDevice,
  revokeDevice,
  type PackingOrder,
  type ScannerDevice,
} from './packing-api.js';
import { OrdersNav, OrderStatusBadge } from './parts.js';
import { ordersPath } from './paths.js';
import type { OrderStatus } from './api.js';

/**
 * Orders → Scan (M35b, D-554): what goes in the parcel.
 *
 * Scan a parcel's code (the courier's consignment or tracking code) or an order number, with a
 * USB scanner, the phone's camera or by hand, and the packing list opens: who it goes to, what
 * to collect, and every item with its picture, size and colour. The same answer the packing
 * scanner app gets, in the caller's own scope.
 *
 * Below, the phones signed in to the scanner app: one's own, or everyone's for someone who
 * manages staff. A phone can be paired from here with a one-time code instead of a password.
 */
export function OrderScanPage() {
  const t = useT();
  const [result, setResult] = useState<
    | { readonly kind: 'found'; readonly order: PackingOrder }
    | { readonly kind: 'missing'; readonly code: string }
    | { readonly kind: 'error'; readonly message: string }
    | null
  >(null);
  const lookup = useMutation({
    mutationFn: (code: string) => lookupShipment(code),
    onSuccess: (answer) =>
      setResult(
        answer.found
          ? { kind: 'found', order: answer.order }
          : { kind: 'missing', code: answer.code },
      ),
    onError: (error) =>
      setResult({
        kind: 'error',
        message: error instanceof ApiError ? error.message : t('pk.scan.failed'),
      }),
  });

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('pk.scan.title')}
        description={t('pk.scan.description')}
        tabs={<OrdersNav />}
      />
      <section aria-labelledby="scan-lookup" className="space-y-4">
        <h2 id="scan-lookup" className="sr-only">
          {t('pk.scan.title')}
        </h2>
        <ScanField
          label={t('pk.scan.label')}
          hint={t('pk.scan.hint')}
          onCode={(code) => lookup.mutate(code)}
          message={
            lookup.isPending
              ? t('pk.scan.looking')
              : result?.kind === 'missing'
                ? `${t('pk.scan.notFound')} ${result.code}`
                : result?.kind === 'error'
                  ? result.message
                  : null
          }
          tone={result !== null && result.kind !== 'found' ? 'error' : 'neutral'}
          className="max-w-xl"
        />
        {result?.kind === 'found' ? <PackingList order={result.order} /> : null}
      </section>
      <Devices />
    </div>
  );
}

function PackingList({ order }: { readonly order: PackingOrder }) {
  const t = useT();
  const { locale } = useLocale();
  return (
    <article
      aria-label={`${t('pk.scan.order')} ${order.orderNumber}`}
      data-testid="packing-list"
      className="rounded-lg border border-border bg-card"
    >
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="space-y-1">
          <Link
            to={ordersPath(`/orders/${order.id}`)}
            className="text-lg font-semibold tracking-tight underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            {order.orderNumber}
          </Link>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <OrderStatusBadge status={order.status as OrderStatus} />
            <DateTime value={order.createdAt} />
            {order.courier === null ? null : (
              <span>
                {order.courier}
                {order.consignmentId === null ? '' : ` · ${order.consignmentId}`}
                {order.trackingCode === '' ? '' : ` · ${order.trackingCode}`}
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          {order.paid ? (
            <StatusBadge tone="success">{t('pk.scan.paid')}</StatusBadge>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">{t('pk.scan.collect')}</p>
              <p className="text-xl font-semibold tabular-nums">
                <Money poisha={order.cod.poisha} locale={locale} />
              </p>
            </>
          )}
        </div>
      </header>
      <div className="grid gap-4 px-5 py-4 sm:grid-cols-2">
        <dl className="space-y-1 text-sm">
          <dt className="text-xs text-muted-foreground">{t('pk.scan.recipient')}</dt>
          <dd className="font-medium">{order.recipient.name}</dd>
          <dd className="tabular-nums">{order.recipient.phone}</dd>
          <dd className="text-muted-foreground">{order.recipient.address}</dd>
        </dl>
        <dl className="space-y-1 text-sm">
          <dt className="text-xs text-muted-foreground">{t('pk.scan.contents')}</dt>
          <dd className="tabular-nums">
            {`${String(order.totalUnits)} ${t('pk.scan.units')} · ${String(order.itemCount)} ${t('pk.scan.lines')}`}
          </dd>
          {order.notes === '' ? null : (
            <>
              <dt className="pt-2 text-xs text-muted-foreground">{t('pk.scan.notes')}</dt>
              <dd>{order.notes}</dd>
            </>
          )}
        </dl>
      </div>
      <ul className="divide-y divide-border border-t border-border">
        {order.items.map((item) => (
          <li key={item.skuId} className="flex items-center gap-4 px-5 py-3">
            <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-muted">
              {item.image === '' ? (
                <ImageOff aria-hidden className="size-5 text-muted-foreground" />
              ) : (
                <img src={item.image} alt="" className="size-full object-cover" />
              )}
            </div>
            <div className="min-w-0 flex-1 text-sm">
              <p className="truncate font-medium">{item.name}</p>
              <p className="text-xs text-muted-foreground">
                {[item.size, item.color].filter((part) => part !== '').join(' / ')}
              </p>
              <p className="font-mono text-xs text-muted-foreground">
                {item.sku}
                {item.barcode === null ? '' : ` · ${item.barcode}`}
              </p>
            </div>
            <p className="text-2xl font-semibold tabular-nums" aria-label={t('pk.scan.quantity')}>
              {`× ${String(item.quantity)}`}
            </p>
          </li>
        ))}
      </ul>
    </article>
  );
}

function Devices() {
  const t = useT();
  const queryClient = useQueryClient();
  const devices = useQuery({ queryKey: ['scanner', 'devices'], queryFn: listDevices });
  const [pairing, setPairing] = useState(false);
  const [revoking, setRevoking] = useState<ScannerDevice | null>(null);
  const items = devices.data?.items ?? [];
  return (
    <section
      aria-labelledby="scanner-devices"
      className="rounded-lg border border-border bg-card text-card-foreground"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
        <div className="min-w-0 space-y-0.5">
          <h2 id="scanner-devices" className="text-base font-semibold tracking-tight">
            {t('pk.devices.title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('pk.devices.description')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setPairing(true)}>
          <Smartphone aria-hidden />
          {t('pk.devices.pair')}
        </Button>
      </div>
      <div className="px-5 pb-5">
        {devices.isPending ? (
          <p className="text-sm text-muted-foreground">{t('pk.loading')}</p>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('pk.devices.none')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
              <caption className="sr-only">{t('pk.devices.title')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="font-medium">{t('pk.devices.name')}</th>
                  {devices.data?.everyone === true ? (
                    <th className="font-medium">{t('pk.devices.person')}</th>
                  ) : null}
                  <th className="font-medium">{t('pk.devices.lastUsed')}</th>
                  <th className="font-medium">{t('pk.devices.expires')}</th>
                  <th className="font-medium">{t('pk.devices.state')}</th>
                  <th className="font-medium">
                    <span className="sr-only">{t('pk.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {items.map((device) => (
                  <tr key={device.id} className="h-row border-b border-border last:border-b-0">
                    <td className="font-medium">
                      {device.label}
                      <span className="ml-2 text-xs text-muted-foreground">
                        {device.via === 'console'
                          ? t('pk.devices.viaCode')
                          : t('pk.devices.viaPassword')}
                      </span>
                    </td>
                    {devices.data?.everyone === true ? <td>{device.userName ?? '—'}</td> : null}
                    <td>
                      {device.lastUsedAt === null ? (
                        t('pk.devices.never')
                      ) : (
                        <DateTime value={device.lastUsedAt} />
                      )}
                    </td>
                    <td>
                      {device.expiresAt === null ? null : <DateTime value={device.expiresAt} />}
                    </td>
                    <td>
                      <StatusBadge tone={device.active ? 'success' : 'neutral'}>
                        {device.active
                          ? t('pk.devices.active')
                          : device.revokedAt === null
                            ? t('pk.devices.expired')
                            : t('pk.devices.revoked')}
                      </StatusBadge>
                    </td>
                    <td className="text-right">
                      {device.active ? (
                        <Button size="sm" variant="ghost" onClick={() => setRevoking(device)}>
                          {t('pk.devices.revoke')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {pairing ? <PairDialog onClose={() => setPairing(false)} /> : null}
      {revoking === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setRevoking(null);
          }}
          title={t('pk.devices.revokeTitle')}
          description={t('pk.devices.revokeDetail')}
          confirmLabel={t('pk.devices.revoke')}
          cancelLabel={t('pk.cancel')}
          closeLabel={t('pk.close')}
          destructive
          onConfirm={async () => {
            await revokeDevice(revoking.id);
            setRevoking(null);
            await queryClient.invalidateQueries({ queryKey: ['scanner', 'devices'] });
          }}
        />
      )}
    </section>
  );
}

function PairDialog({ onClose }: { readonly onClose: () => void }) {
  const t = useT();
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState('');
  const pair = useMutation({
    mutationFn: () => pairDevice(name.trim()),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scanner', 'devices'] }),
  });
  const issued = pair.data;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('pk.devices.pairTitle')}
      description={issued === undefined ? t('pk.devices.pairHelp') : t('pk.devices.codeHelp')}
      closeLabel={t('pk.close')}
      footer={
        issued === undefined ? (
          <>
            <Button variant="outline" onClick={onClose}>
              {t('pk.cancel')}
            </Button>
            <Button disabled={pair.isPending} onClick={() => pair.mutate()}>
              {t('pk.devices.makeCode')}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>{t('pk.done')}</Button>
        )
      }
    >
      {issued === undefined ? (
        <div className="space-y-1.5 text-sm">
          <label htmlFor={`${id}-name`} className="block font-medium">
            {t('pk.devices.name')}
          </label>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={80}
            placeholder={t('pk.devices.namePlaceholder')}
            className={`${controlClassName} w-full`}
            onChange={(event) => setName(event.target.value)}
          />
          {pair.error === null ? null : (
            <p role="alert" className="text-sm text-destructive">
              {pair.error instanceof ApiError ? pair.error.message : t('pk.scan.failed')}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted p-3">
            <code data-testid="pair-code" className="min-w-0 flex-1 font-mono text-xs break-all">
              {issued.token}
            </code>
            <CopyButton text={issued.token} label={t('pk.devices.copyCode')} />
          </div>
          {issued.device.expiresAt === null ? null : (
            <p className="text-xs text-muted-foreground">
              {t('pk.devices.validUntil')} <DateTime value={issued.device.expiresAt} />
            </p>
          )}
        </div>
      )}
    </Dialog>
  );
}
