import type { TrackingSettingsInput } from '@elysium/contracts';
import type { Locale, MessageKey } from '@elysium/i18n';
import { Button, Checkbox, DateTime, Money, Select, StatusBadge } from '@elysium/ui';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import '../../i18n/web-marketing.js';
import {
  getTracking,
  listTrackingEvents,
  saveTracking,
  type TrackingEventRow,
  type TrackingRoute,
  type TrackingSettingsView,
  type TrackingStatus,
} from './marketing-api.js';
import { useWebsiteT } from './messages.js';
import { control, Empty, Field, Loadable, NamedSection, Problem, WebsitePage } from './parts.js';
import { SecretInput, secretField, type Secret } from './marketing-parts.js';

/**
 * Website → Tracking (M35b, D-552): the Meta pixel and Conversions API, Google Analytics 4 and
 * its Measurement Protocol, which events go where, and the log of what was sent.
 *
 * The website's browser fires the pixel and gtag; it also hands each event to the ERP, which
 * sends the same event from the server with the same id, so Meta counts it once. The order's
 * Purchase is the ERP's own: sent when a website or marketplace order is placed (an online
 * payment waits until it is paid). Tokens are write-only, kept sealed; the screen shows a
 * fingerprint.
 */
export function WebsiteTrackingPage() {
  const query = useQuery({ queryKey: ['website', 'tracking'], queryFn: getTracking });
  return (
    <WebsitePage tab="/website/tracking" wide>
      <Loadable query={query}>{(value) => <TrackingForm value={value} />}</Loadable>
      <EventLog />
    </WebsitePage>
  );
}

function TrackingForm({ value }: { readonly value: TrackingSettingsView }) {
  const t = useT();
  const w = useWebsiteT();
  const id = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayUpdate = ability.can('update', 'Storefront');
  // Where the shoppers' hashed details go is the org admin's (D-558): the ids and secrets.
  const mayCredentials = ability.can('update', 'WebsiteCredentials');
  const initial = value.settings;
  const [meta, setMeta] = useState({
    pixelEnabled: initial.meta.pixelEnabled,
    capiEnabled: initial.meta.capiEnabled,
    pixelId: initial.meta.pixelId,
    datasetId: initial.meta.datasetId,
    apiVersion: initial.meta.apiVersion,
    testEventCode: initial.meta.testEventCode,
    defaultCountryCode: initial.meta.defaultCountryCode,
  });
  const [ga4, setGa4] = useState({
    clientEnabled: initial.ga4.clientEnabled,
    mpEnabled: initial.ga4.mpEnabled,
    measurementId: initial.ga4.measurementId,
  });
  const [token, setToken] = useState<Secret>({ mode: 'keep' });
  const [apiSecret, setApiSecret] = useState<Secret>({ mode: 'keep' });
  const [proxy, setProxy] = useState(initial.proxy);
  const [testMode, setTestMode] = useState(initial.testMode);
  const [events, setEvents] = useState<readonly TrackingRoute[]>(initial.events);
  const [retention, setRetention] = useState(String(initial.logRetentionDays));
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () => {
      const tokenValue = secretField(token);
      const secretValue = secretField(apiSecret);
      const input: TrackingSettingsInput = {
        meta: {
          ...meta,
          pixelId: meta.pixelId.trim(),
          datasetId: meta.datasetId.trim(),
          apiVersion: meta.apiVersion.trim(),
          testEventCode: meta.testEventCode.trim(),
          defaultCountryCode: meta.defaultCountryCode.trim(),
          ...(tokenValue === undefined ? {} : { accessToken: tokenValue }),
        },
        ga4: {
          ...ga4,
          measurementId: ga4.measurementId.trim().toUpperCase(),
          ...(secretValue === undefined ? {} : { apiSecret: secretValue }),
        },
        proxy,
        testMode,
        events: [...events],
        logRetentionDays: Number(retention),
      };
      return saveTracking(input);
    },
    onMutate: () => setSaved(false),
    onSuccess: (next) => {
      queryClient.setQueryData(['website', 'tracking'], next);
      setToken({ mode: 'keep' });
      setApiSecret({ mode: 'keep' });
      setSaved(true);
    },
  });

  const retentionValid =
    /^\d{1,3}$/.test(retention) && Number(retention) >= 1 && Number(retention) <= 365;
  const setRoute = (index: number, patch: Partial<TrackingRoute>) =>
    setEvents(events.map((route, at) => (at === index ? { ...route, ...patch } : route)));

  const saveButton = mayUpdate ? (
    <div className="flex items-center gap-3">
      {saved ? (
        <span role="status" className="text-xs text-muted-foreground">
          {w('web.saved')}
        </span>
      ) : null}
      <Button size="sm" disabled={save.isPending || !retentionValid} onClick={() => save.mutate()}>
        {w('web.save')}
      </Button>
    </div>
  ) : null;

  return (
    <>
      <NamedSection
        title={t('wm.track.title')}
        description={t('wm.track.description')}
        actions={saveButton}
      >
        {value.provider === 'fake' ? (
          <p role="status" className="mb-3 text-sm text-muted-foreground">
            {t('wm.track.fakeProvider')}
          </p>
        ) : null}
        {value.credentialsKey ? null : (
          <p role="status" className="mb-3 text-sm text-muted-foreground">
            {t('wm.track.noKey')}
          </p>
        )}
        <p className="mb-4 text-xs text-muted-foreground">{t('wm.track.unverified')}</p>
        {mayUpdate && !mayCredentials ? (
          <p className="mb-4 text-xs text-muted-foreground">{t('wm.track.adminOnly')}</p>
        ) : null}
        <fieldset disabled={!mayUpdate} className="space-y-6">
          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{t('wm.track.meta')}</h3>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={meta.pixelEnabled}
                  onCheckedChange={(next) => setMeta({ ...meta, pixelEnabled: next === true })}
                />
                {t('wm.track.pixelOn')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={meta.capiEnabled}
                  onCheckedChange={(next) => setMeta({ ...meta, capiEnabled: next === true })}
                />
                {t('wm.track.capiOn')}
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${id}-pixel`} label={t('wm.track.pixelId')}>
                <input
                  id={`${id}-pixel`}
                  value={meta.pixelId}
                  inputMode="numeric"
                  maxLength={24}
                  disabled={!mayCredentials}
                  className={control}
                  onChange={(event) => setMeta({ ...meta, pixelId: event.target.value })}
                />
              </Field>
              <Field
                id={`${id}-dataset`}
                label={t('wm.track.datasetId')}
                hint={t('wm.track.datasetHelp')}
              >
                <input
                  id={`${id}-dataset`}
                  value={meta.datasetId}
                  inputMode="numeric"
                  maxLength={24}
                  disabled={!mayCredentials}
                  className={control}
                  onChange={(event) => setMeta({ ...meta, datasetId: event.target.value })}
                />
              </Field>
              <SecretInput
                id={`${id}-token`}
                label={t('wm.track.token')}
                fingerprint={initial.meta.accessTokenFingerprint}
                secret={token}
                onChange={setToken}
                maxLength={600}
                disabled={!mayCredentials}
              />
              <Field id={`${id}-version`} label={t('wm.track.apiVersion')}>
                <input
                  id={`${id}-version`}
                  value={meta.apiVersion}
                  maxLength={8}
                  className={control}
                  onChange={(event) => setMeta({ ...meta, apiVersion: event.target.value })}
                />
              </Field>
              <Field
                id={`${id}-test`}
                label={t('wm.track.testCode')}
                hint={t('wm.track.testCodeHelp')}
              >
                <input
                  id={`${id}-test`}
                  value={meta.testEventCode}
                  maxLength={40}
                  className={control}
                  onChange={(event) => setMeta({ ...meta, testEventCode: event.target.value })}
                />
              </Field>
              <Field id={`${id}-country`} label={t('wm.track.country')}>
                <input
                  id={`${id}-country`}
                  value={meta.defaultCountryCode}
                  inputMode="numeric"
                  maxLength={4}
                  className={control}
                  onChange={(event) => setMeta({ ...meta, defaultCountryCode: event.target.value })}
                />
              </Field>
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{t('wm.track.ga4')}</h3>
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={ga4.clientEnabled}
                  onCheckedChange={(next) => setGa4({ ...ga4, clientEnabled: next === true })}
                />
                {t('wm.track.gtagOn')}
              </label>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={ga4.mpEnabled}
                  onCheckedChange={(next) => setGa4({ ...ga4, mpEnabled: next === true })}
                />
                {t('wm.track.mpOn')}
              </label>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field id={`${id}-measurement`} label={t('wm.track.measurementId')}>
                <input
                  id={`${id}-measurement`}
                  value={ga4.measurementId}
                  maxLength={24}
                  placeholder="G-XXXXXXX"
                  disabled={!mayCredentials}
                  className={control}
                  onChange={(event) => setGa4({ ...ga4, measurementId: event.target.value })}
                />
              </Field>
              <SecretInput
                id={`${id}-secret`}
                label={t('wm.track.apiSecret')}
                fingerprint={initial.ga4.apiSecretFingerprint}
                secret={apiSecret}
                onChange={setApiSecret}
                maxLength={120}
                disabled={!mayCredentials}
              />
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{t('wm.track.proxy')}</h3>
            <p className="text-xs text-muted-foreground">{t('wm.track.proxyHelp')}</p>
            <div className="grid gap-4 sm:grid-cols-2">
              {(
                [
                  ['metaScriptPath', 'wm.track.metaScript'],
                  ['metaCollectPath', 'wm.track.metaCollect'],
                  ['ga4ScriptPath', 'wm.track.ga4Script'],
                  ['ga4CollectPath', 'wm.track.ga4Collect'],
                ] as const
              ).map(([key, label]) => (
                <Field key={key} id={`${id}-${key}`} label={t(label)}>
                  <input
                    id={`${id}-${key}`}
                    value={proxy[key]}
                    maxLength={300}
                    className={control}
                    onChange={(event) => setProxy({ ...proxy, [key]: event.target.value })}
                  />
                </Field>
              ))}
            </div>
          </div>

          <div className="space-y-3">
            <h3 className="text-sm font-semibold">{t('wm.track.events')}</h3>
            <p className="text-xs text-muted-foreground">{t('wm.track.eventsHelp')}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
                <caption className="sr-only">{t('wm.track.events')}</caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th className="font-medium">{t('wm.track.event')}</th>
                    <th className="font-medium">{t('wm.track.on')}</th>
                    <th className="font-medium">{t('wm.track.browser')}</th>
                    <th className="font-medium">{t('wm.track.server')}</th>
                    <th className="font-medium">{t('wm.track.toMeta')}</th>
                    <th className="font-medium">{t('wm.track.toGa4')}</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((route, index) => (
                    <tr key={route.name} className="h-row border-b border-border last:border-b-0">
                      <td className="font-mono text-xs">{route.name}</td>
                      {(['enabled', 'client', 'server', 'meta', 'ga4'] as const).map((key) => (
                        <td key={key}>
                          <Checkbox
                            aria-label={`${route.name}: ${t(ROUTE_LABEL[key])}`}
                            checked={route[key]}
                            onCheckedChange={(next) => setRoute(index, { [key]: next === true })}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="flex items-center gap-2 self-end text-sm">
              <Checkbox checked={testMode} onCheckedChange={(next) => setTestMode(next === true)} />
              {t('wm.track.testMode')}
            </label>
            <Field id={`${id}-retention`} label={t('wm.track.retention')}>
              <input
                id={`${id}-retention`}
                value={retention}
                inputMode="numeric"
                maxLength={3}
                aria-invalid={!retentionValid}
                className={control}
                onChange={(event) => setRetention(event.target.value)}
              />
            </Field>
          </div>
          <Problem error={save.error} />
        </fieldset>
      </NamedSection>
    </>
  );
}

const ROUTE_LABEL: Readonly<Record<'enabled' | 'client' | 'server' | 'meta' | 'ga4', MessageKey>> =
  {
    enabled: 'wm.track.on',
    client: 'wm.track.browser',
    server: 'wm.track.server',
    meta: 'wm.track.toMeta',
    ga4: 'wm.track.toGa4',
  };

const STATUS_TONE: Readonly<Record<string, 'success' | 'warning' | 'danger' | 'neutral'>> = {
  success: 'success',
  partial: 'warning',
  queued: 'warning',
  waiting: 'warning',
  error: 'danger',
  skipped: 'neutral',
};

const STATUSES: readonly TrackingStatus[] = [
  'waiting',
  'queued',
  'success',
  'partial',
  'error',
  'skipped',
];

function EventLog() {
  const t = useT();
  const id = useId();
  const { locale } = useLocale();
  const [status, setStatus] = useState<TrackingStatus | ''>('');
  const log = useInfiniteQuery({
    queryKey: ['website', 'tracking', 'events', status],
    queryFn: ({ pageParam }) =>
      listTrackingEvents({
        status: status === '' ? undefined : status,
        cursor: pageParam === '' ? undefined : pageParam,
      }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const pages = log.data?.pages ?? [];
  const rows = pages.flatMap((page) => page.items);
  const stats = pages[0]?.stats ?? [];

  return (
    <NamedSection
      title={t('wm.log.title')}
      description={t('wm.log.description')}
      actions={
        <div className="w-44">
          <label htmlFor={`${id}-status`} className="sr-only">
            {t('wm.log.status')}
          </label>
          <Select
            id={`${id}-status`}
            size="sm"
            variant="filter"
            value={status}
            onValueChange={(next) => setStatus(next as TrackingStatus | '')}
            options={[
              { value: '', label: t('wm.log.all') },
              ...STATUSES.map((value) => ({
                value,
                label: t(`wm.log.state.${value}` as MessageKey),
              })),
            ]}
          />
        </div>
      }
    >
      {stats.length === 0 ? null : (
        <p className="mb-3 text-xs text-muted-foreground tabular-nums">
          {t('wm.log.today')}{' '}
          {stats
            .map(
              (entry) =>
                `${t(`wm.log.state.${entry.status}` as MessageKey)} ${String(entry.count)}`,
            )
            .join(' · ')}
        </p>
      )}
      {log.isPending ? (
        <p className="text-sm text-muted-foreground">{t('wm.loading')}</p>
      ) : rows.length === 0 ? (
        <Empty />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
            <caption className="sr-only">{t('wm.log.title')}</caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="font-medium">{t('wm.log.when')}</th>
                <th className="font-medium">{t('wm.track.event')}</th>
                <th className="font-medium">{t('wm.log.source')}</th>
                <th className="font-medium">{t('wm.log.status')}</th>
                <th className="font-medium">{t('wm.log.who')}</th>
                <th className="text-right font-medium">{t('wm.log.value')}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <EventRow key={row.id} row={row} locale={locale} />
              ))}
            </tbody>
          </table>
        </div>
      )}
      {log.hasNextPage ? (
        <div className="mt-3">
          <Button
            size="sm"
            variant="outline"
            disabled={log.isFetchingNextPage}
            onClick={() => void log.fetchNextPage()}
          >
            {t('wm.log.more')}
          </Button>
        </div>
      ) : null}
      <Problem error={log.error} />
    </NamedSection>
  );
}

function EventRow({ row, locale }: { readonly row: TrackingEventRow; readonly locale: Locale }) {
  const t = useT();
  const who = row.user === null ? '' : (row.user.email ?? row.user.phone ?? '');
  const detail = [
    row.meta?.status === undefined ? null : `${t('wm.track.toMeta')} ${row.meta.status}`,
    row.ga4?.status === undefined ? null : `${t('wm.track.toGa4')} ${row.ga4.status}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
  const error = row.meta?.error ?? row.ga4?.error ?? null;
  return (
    <tr className="h-row border-b border-border align-top last:border-b-0">
      <td className="whitespace-nowrap">
        <DateTime value={row.createdAt} />
      </td>
      <td>
        <span className="font-mono text-xs">{row.eventName}</span>
        {row.testMode ? (
          <span className="ml-2 text-xs text-muted-foreground">{t('wm.log.test')}</span>
        ) : null}
      </td>
      <td>{row.source === 'server' ? t('wm.track.server') : t('wm.track.browser')}</td>
      <td>
        <StatusBadge tone={STATUS_TONE[row.status] ?? 'neutral'}>
          {t(`wm.log.state.${row.status}` as MessageKey)}
        </StatusBadge>
        {detail === '' ? null : (
          <span className="block text-xs text-muted-foreground">{detail}</span>
        )}
        {error === null ? null : (
          <span className="block max-w-72 truncate text-xs text-destructive" title={error}>
            {error}
          </span>
        )}
      </td>
      <td className="text-xs">{who}</td>
      <td className="text-right text-xs tabular-nums">
        {row.value === null ? null : <Money poisha={row.value} locale={locale} />}
      </td>
    </tr>
  );
}
