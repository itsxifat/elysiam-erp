import type { MarketplaceSettingsInput } from '@elysium/contracts';
import type { MessageKey } from '@elysium/i18n';
import { Button, Checkbox, ConfirmDialog, DateTime, Money, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useId, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/web-marketing.js';
import { CopyButton } from '../../ui/copy-button.js';
import {
  getMarketplace,
  listHolds,
  listNcomOrders,
  releaseHold,
  saveMarketplace,
  type MarketplaceView,
  type NcomHold,
  type NcomOrderRow,
} from './marketing-api.js';
import { useWebsiteT } from './messages.js';
import {
  control,
  Empty,
  Field,
  Loadable,
  NamedSection,
  Problem,
  WebsitePage,
  websitePath,
} from './parts.js';
import { SecretInput, secretField, type Secret } from './marketing-parts.js';

/**
 * Website → Marketplace (M35b, D-553): the brand's connection to ncom.bd.
 *
 * ncom reads the brand's products and stock through the connector (contract 1, HMAC-signed),
 * holds stock while a shopper checks out on one of its pages, and hands its orders over. The
 * keys and secrets are an org admin's to set (`update WebsiteCredentials`), sealed on the
 * server; everyone who reads the website sees the addresses to give ncom, the activity, the
 * holds and the orders handed over.
 */
export function WebsiteMarketplacePage() {
  const query = useQuery({ queryKey: ['website', 'marketplace'], queryFn: getMarketplace });
  return (
    <WebsitePage tab="/website/marketplace" wide>
      <Loadable query={query}>
        {(value) => (
          <>
            <SettingsForm value={value} />
            <Addresses value={value} />
          </>
        )}
      </Loadable>
      <Holds />
      <HandedOver />
    </WebsitePage>
  );
}

const KEEP: Secret = { mode: 'keep' };

function SettingsForm({ value }: { readonly value: MarketplaceView }) {
  const t = useT();
  const w = useWebsiteT();
  const id = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayUpdate = ability.can('update', 'WebsiteCredentials');
  const s = value.settings;
  const [flags, setFlags] = useState({
    enabled: s.enabled,
    acceptOrders: s.acceptOrders,
    includeDrafts: s.includeDrafts,
    allowSearch: s.allowSearch,
    allowCategories: s.allowCategories,
    allowReserve: s.allowReserve,
  });
  const [weight, setWeight] = useState(String(s.defaultWeightGrams));
  const [publicBaseUrl, setPublicBaseUrl] = useState(s.publicBaseUrl);
  const [baseUrl, setBaseUrl] = useState(s.baseUrl);
  const [connectorKeyId, setConnectorKeyId] = useState(s.connectorKeyId);
  const [orderKeyId, setOrderKeyId] = useState(s.orderKeyId);
  const [connectorSecret, setConnectorSecret] = useState<Secret>(KEEP);
  const [orderSecret, setOrderSecret] = useState<Secret>(KEEP);
  const [apiKey, setApiKey] = useState<Secret>(KEEP);
  const [webhookSecret, setWebhookSecret] = useState<Secret>(KEEP);
  const [saved, setSaved] = useState(false);

  const weightValid = /^\d{1,6}$/.test(weight) && Number(weight) <= 100_000;
  const save = useMutation({
    mutationFn: () => {
      // A secret left alone is not sent at all: the stored one stays.
      const secret = <K extends string>(key: K, value: Secret) => {
        const field = secretField(value);
        return field === undefined ? {} : ({ [key]: field } as Record<K, string | null>);
      };
      const input: MarketplaceSettingsInput = {
        ...flags,
        defaultWeightGrams: Number(weight),
        publicBaseUrl: publicBaseUrl.trim(),
        baseUrl: baseUrl.trim(),
        connectorKeyId: connectorKeyId.trim(),
        orderKeyId: orderKeyId.trim(),
        ...secret('connectorSecret', connectorSecret),
        ...secret('orderSecret', orderSecret),
        ...secret('apiKey', apiKey),
        ...secret('webhookSecret', webhookSecret),
      };
      return saveMarketplace(input);
    },
    onMutate: () => setSaved(false),
    onSuccess: (next) => {
      queryClient.setQueryData(['website', 'marketplace'], next);
      for (const reset of [setConnectorSecret, setOrderSecret, setApiKey, setWebhookSecret]) {
        reset(KEEP);
      }
      setSaved(true);
    },
  });

  const flag = (key: keyof typeof flags, label: MessageKey) => (
    <label key={key} className="flex items-center gap-2 text-sm">
      <Checkbox
        checked={flags[key]}
        onCheckedChange={(next) => setFlags({ ...flags, [key]: next === true })}
      />
      {t(label)}
    </label>
  );

  return (
    <NamedSection
      title={t('wm.mkt.title')}
      description={t('wm.mkt.description')}
      actions={
        mayUpdate ? (
          <div className="flex items-center gap-3">
            {saved ? (
              <span role="status" className="text-xs text-muted-foreground">
                {w('web.saved')}
              </span>
            ) : null}
            <Button
              size="sm"
              disabled={save.isPending || !weightValid || baseUrl.trim() === ''}
              onClick={() => save.mutate()}
            >
              {w('web.save')}
            </Button>
          </div>
        ) : null
      }
    >
      {value.credentialsKey ? null : (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {t('wm.mkt.noKey')}
        </p>
      )}
      <fieldset disabled={!mayUpdate} className="space-y-5">
        <div className="grid gap-2 sm:grid-cols-2">
          {flag('enabled', 'wm.mkt.enabled')}
          {flag('acceptOrders', 'wm.mkt.acceptOrders')}
          {flag('includeDrafts', 'wm.mkt.includeDrafts')}
          {flag('allowSearch', 'wm.mkt.allowSearch')}
          {flag('allowCategories', 'wm.mkt.allowCategories')}
          {flag('allowReserve', 'wm.mkt.allowReserve')}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${id}-key`} label={t('wm.mkt.connectorKey')}>
            <input
              id={`${id}-key`}
              value={connectorKeyId}
              maxLength={120}
              autoComplete="off"
              className={control}
              onChange={(event) => setConnectorKeyId(event.target.value)}
            />
          </Field>
          <SecretInput
            id={`${id}-secret`}
            label={t('wm.mkt.connectorSecret')}
            fingerprint={s.connectorSecretFingerprint}
            secret={connectorSecret}
            onChange={setConnectorSecret}
            maxLength={300}
          />
          <Field id={`${id}-order-key`} label={t('wm.mkt.orderKey')}>
            <input
              id={`${id}-order-key`}
              value={orderKeyId}
              maxLength={120}
              autoComplete="off"
              className={control}
              onChange={(event) => setOrderKeyId(event.target.value)}
            />
          </Field>
          <SecretInput
            id={`${id}-order-secret`}
            label={t('wm.mkt.orderSecret')}
            fingerprint={s.orderSecretFingerprint}
            secret={orderSecret}
            onChange={setOrderSecret}
            maxLength={300}
          />
          <SecretInput
            id={`${id}-api-key`}
            label={t('wm.mkt.apiKey')}
            fingerprint={s.apiKeyFingerprint}
            secret={apiKey}
            onChange={setApiKey}
            maxLength={300}
          />
          <SecretInput
            id={`${id}-webhook`}
            label={t('wm.mkt.webhookSecret')}
            fingerprint={s.webhookSecretFingerprint}
            secret={webhookSecret}
            onChange={setWebhookSecret}
            maxLength={300}
          />
          <Field id={`${id}-base`} label={t('wm.mkt.baseUrl')} hint={t('wm.mkt.baseUrlHelp')}>
            <input
              id={`${id}-base`}
              value={baseUrl}
              maxLength={300}
              className={control}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          </Field>
          <Field
            id={`${id}-public`}
            label={t('wm.mkt.publicBaseUrl')}
            hint={t('wm.mkt.publicBaseUrlHelp')}
          >
            <input
              id={`${id}-public`}
              value={publicBaseUrl}
              maxLength={300}
              className={control}
              onChange={(event) => setPublicBaseUrl(event.target.value)}
            />
          </Field>
          <Field id={`${id}-weight`} label={t('wm.mkt.weight')}>
            <input
              id={`${id}-weight`}
              value={weight}
              inputMode="numeric"
              maxLength={6}
              aria-invalid={!weightValid}
              className={control}
              onChange={(event) => setWeight(event.target.value)}
            />
          </Field>
        </div>
        <Problem error={save.error} />
      </fieldset>
    </NamedSection>
  );
}

function Addresses({ value }: { readonly value: MarketplaceView }) {
  const t = useT();
  const a = value.activity;
  const counts = Object.entries(a.requestCounts);
  const rows: readonly [MessageKey, string][] = [
    ['wm.mkt.connectorAddress', value.addresses.connector],
    ['wm.mkt.ordersAddress', value.addresses.orders],
    ['wm.mkt.webhookAddress', value.addresses.webhook],
  ];
  return (
    <NamedSection title={t('wm.mkt.addresses')} description={t('wm.mkt.addressesHelp')}>
      <dl className="space-y-3 text-sm">
        {rows.map(([label, address]) => (
          <div key={label}>
            <dt className="text-xs text-muted-foreground">{t(label)}</dt>
            <dd className="flex items-center gap-1">
              <span className="font-mono text-xs break-all">{address}</span>
              <CopyButton text={address} label={`${t('wm.copyLink')}: ${t(label)}`} />
            </dd>
          </div>
        ))}
      </dl>
      <h3 className="mt-5 mb-2 text-sm font-semibold">{t('wm.mkt.activity')}</h3>
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs text-muted-foreground">{t('wm.mkt.lastRequest')}</dt>
          <dd>
            {a.lastRequestAt === null ? (
              t('wm.never')
            ) : (
              <>
                <DateTime value={a.lastRequestAt} />
                {a.lastRequestKind === null ? null : (
                  <span className="ml-2 font-mono text-xs text-muted-foreground">
                    {a.lastRequestKind}
                  </span>
                )}
              </>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('wm.mkt.ordersReceived')}</dt>
          <dd className="tabular-nums">
            {a.ordersReceived}
            {a.lastOrderAt === null ? null : (
              <span className="ml-2 text-xs text-muted-foreground">
                <DateTime value={a.lastOrderAt} />
              </span>
            )}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('wm.mkt.lastWebhook')}</dt>
          <dd>{a.lastWebhookAt === null ? t('wm.never') : <DateTime value={a.lastWebhookAt} />}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{t('wm.mkt.lastRefusal')}</dt>
          <dd>
            {a.lastRefusalAt === null ? (
              t('wm.never')
            ) : (
              <>
                <DateTime value={a.lastRefusalAt} />
                <span className="block text-xs text-muted-foreground">{a.lastRefusalReason}</span>
              </>
            )}
          </dd>
        </div>
        {counts.length === 0 ? null : (
          <div className="sm:col-span-2">
            <dt className="text-xs text-muted-foreground">{t('wm.mkt.requests')}</dt>
            <dd className="font-mono text-xs tabular-nums">
              {counts.map(([kind, count]) => `${kind} ${String(count)}`).join(' · ')}
            </dd>
          </div>
        )}
      </dl>
    </NamedSection>
  );
}

const HOLD_TONE: Readonly<Record<NcomHold['state'], 'warning' | 'success' | 'neutral'>> = {
  held: 'warning',
  converted: 'success',
  released: 'neutral',
};

function Holds() {
  const t = useT();
  const w = useWebsiteT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayRelease = ability.can('update', 'WebsiteCredentials');
  const query = useQuery({ queryKey: ['website', 'marketplace', 'holds'], queryFn: listHolds });
  const [releasing, setReleasing] = useState<NcomHold | null>(null);
  return (
    <NamedSection title={t('wm.holds.title')} description={t('wm.holds.description')}>
      <Loadable query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
                <caption className="sr-only">{t('wm.holds.title')}</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="font-medium">{t('wm.holds.ref')}</th>
                    <th className="text-right font-medium">{t('wm.holds.units')}</th>
                    <th className="font-medium">{t('wm.holds.state')}</th>
                    <th className="font-medium">{t('wm.holds.when')}</th>
                    <th className="font-medium">
                      <span className="sr-only">{t('wm.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((hold) => (
                    <tr key={hold.id} className="h-row border-b border-border last:border-b-0">
                      <td className="font-mono text-xs">{hold.orderRef}</td>
                      <td className="text-right tabular-nums">
                        {hold.lines.reduce((sum, line) => sum + line.qty, 0)}
                      </td>
                      <td>
                        <StatusBadge tone={HOLD_TONE[hold.state]}>
                          {t(`wm.holds.state.${hold.state}` as MessageKey)}
                        </StatusBadge>
                      </td>
                      <td>{hold.heldAt === null ? null : <DateTime value={hold.heldAt} />}</td>
                      <td className="text-right">
                        {mayRelease && hold.state === 'held' ? (
                          <Button size="sm" variant="outline" onClick={() => setReleasing(hold)}>
                            {t('wm.holds.release')}
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        }
      </Loadable>
      {releasing === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setReleasing(null);
          }}
          title={t('wm.holds.releaseTitle')}
          description={t('wm.holds.releaseDetail')}
          confirmLabel={t('wm.holds.release')}
          cancelLabel={w('web.cancel')}
          closeLabel={w('web.close')}
          onConfirm={async () => {
            await releaseHold(releasing.id);
            setReleasing(null);
            await queryClient.invalidateQueries({ queryKey: ['website', 'marketplace', 'holds'] });
          }}
        />
      )}
    </NamedSection>
  );
}

const MESSAGE_TONE: Readonly<
  Record<NcomOrderRow['messages'][number]['status'], 'success' | 'warning' | 'danger' | 'neutral'>
> = {
  delivered: 'success',
  pending: 'warning',
  refused: 'danger',
  failed: 'danger',
};

function HandedOver() {
  const t = useT();
  const { locale } = useLocale();
  const query = useQuery({
    queryKey: ['website', 'marketplace', 'orders'],
    queryFn: listNcomOrders,
  });
  return (
    <NamedSection title={t('wm.orders.title')} description={t('wm.orders.description')}>
      <Loadable query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty />
          ) : (
            <ul className="divide-y divide-border">
              {data.items.map((row) => (
                <li key={row.orderId} className="space-y-1 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link
                      to={websitePath(`/orders/${row.orderId}`)}
                      className="font-medium underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    >
                      {row.orderNo ?? row.orderId}
                    </Link>
                    <span className="font-mono text-xs text-muted-foreground">
                      {row.ncomOrderNumber ?? row.ncomOrderId}
                    </span>
                    {row.status === null ? null : (
                      <StatusBadge tone="neutral">
                        {t(`orders.status.${row.status}` as MessageKey)}
                      </StatusBadge>
                    )}
                    {row.codAmountPoisha === null ? null : (
                      <span className="tabular-nums">
                        {t('wm.orders.cod')} <Money poisha={row.codAmountPoisha} locale={locale} />
                      </span>
                    )}
                    {row.receivedAt === null ? null : (
                      <span className="text-xs text-muted-foreground">
                        <DateTime value={row.receivedAt} />
                      </span>
                    )}
                  </div>
                  {[row.storeName, row.pageTitle, row.offerLabel].some((part) => part !== null) ? (
                    <p className="text-xs text-muted-foreground">
                      {[row.storeName, row.pageTitle, row.offerLabel]
                        .filter((part): part is string => part !== null && part !== '')
                        .join(' · ')}
                    </p>
                  ) : null}
                  {row.foreignItems === null || row.foreignItems.length === 0 ? null : (
                    <p className="text-xs text-muted-foreground">
                      {t('wm.orders.foreign')}{' '}
                      {row.foreignItems
                        .map((item) => `${item.title} × ${String(item.quantity)}`)
                        .join(', ')}{' '}
                      (<Money poisha={row.foreignPoisha} locale={locale} />)
                    </p>
                  )}
                  {(row.warnings ?? []).map((warning) => (
                    <p key={warning} className="text-xs text-warning-subtle-foreground">
                      {warning}
                    </p>
                  ))}
                  {row.messages.length === 0 ? null : (
                    <p className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="text-muted-foreground">{t('wm.orders.updates')}</span>
                      {row.messages.map((message) => (
                        <StatusBadge key={message.id} tone={MESSAGE_TONE[message.status]}>
                          {`${message.topic === 'order.cancelled' ? t('wm.orders.cancelled') : t('wm.orders.updated')} r${String(message.revision)} · ${t(`wm.orders.msg.${message.status}` as MessageKey)}`}
                        </StatusBadge>
                      ))}
                    </p>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
    </NamedSection>
  );
}
