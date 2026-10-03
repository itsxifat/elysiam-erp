import {
  Button,
  DataTable,
  DateTime,
  Money,
  PermissionGate,
  Select,
  Skeleton,
  StatusBadge,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { control, Field, singlePage } from '../campaigns/campaigns-nav.js';
import {
  CAPI_STATUSES,
  getConnection,
  listConversions,
  saveConnection,
  type CapiStatus,
  type Conversion,
  type MetaConnection,
} from './api.js';
import { MarketingHeader, useMarketingTableLabels } from './marketing-nav.js';
import { useMarketingT, type MarketingMessageKey } from './messages.js';

/**
 * The brand's Meta link and the conversion log (§11, §21; M18).
 *
 * The token is write-only: typed here, sealed on the server, never shown again — the
 * screen shows a 12-character fingerprint so an operator can tell which token is set.
 * Both Meta adapters are unverified (D-257); the provider line says which one is running.
 */
export function MarketingMetaPage() {
  const ability = useAbility();
  const t = useMarketingT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Campaign')}
      explain={{ title: t('marketing.deniedTitle'), detail: t('marketing.deniedDetail') }}
    >
      <MetaSettings />
      <ConversionLog />
    </PermissionGate>
  );
}

const CAPI_TONE: Record<CapiStatus, 'info' | 'success' | 'danger' | 'neutral'> = {
  queued: 'info',
  sent: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

interface Draft {
  adAccountId: string;
  pixelId: string;
  token: string;
  testEventCode: string;
  spendImportEnabled: boolean;
  capiEnabled: boolean;
  sendNameAndCity: boolean;
}

function draftOf(connection: MetaConnection): Draft {
  return {
    adAccountId: connection.adAccountId ?? '',
    pixelId: connection.pixelId ?? '',
    token: '',
    testEventCode: connection.testEventCode ?? '',
    spendImportEnabled: connection.spendImportEnabled,
    capiEnabled: connection.capiEnabled,
    sendNameAndCity: connection.sendNameAndCity,
  };
}

function MetaSettings() {
  const t = useMarketingT();
  const connection = useQuery({ queryKey: ['marketing', 'meta'], queryFn: getConnection });
  return (
    <div className="space-y-5">
      <MarketingHeader title={t('marketing.nav.meta')} caption={t('marketing.meta.subtitle')} />
      {connection.data === undefined ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <MetaForm initial={connection.data} />
      )}
    </div>
  );
}

/** Mounted once the link has loaded, so the draft starts from it without an effect. */
function MetaForm({ initial }: { readonly initial: MetaConnection }) {
  const t = useMarketingT();
  const ability = useAbility();
  const canEdit = ability.can('update', 'Campaign');
  const queryClient = useQueryClient();
  const id = useId();
  const [data, setData] = useState<MetaConnection>(initial);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const save = useMutation({
    mutationFn: (value: Draft) =>
      saveConnection({
        adAccountId: value.adAccountId.trim() === '' ? null : value.adAccountId.trim(),
        pixelId: value.pixelId.trim() === '' ? null : value.pixelId.trim(),
        ...(value.token.trim() === '' ? {} : { token: value.token.trim() }),
        testEventCode: value.testEventCode.trim() === '' ? null : value.testEventCode.trim(),
        spendImportEnabled: value.spendImportEnabled,
        capiEnabled: value.capiEnabled,
        sendNameAndCity: value.sendNameAndCity,
      }),
    onSuccess: async (saved) => {
      setData(saved);
      setDraft(draftOf(saved));
      setMessage({ tone: 'ok', text: t('marketing.meta.saved') });
      await queryClient.invalidateQueries({ queryKey: ['marketing', 'meta'] });
    },
    onError: (error) =>
      setMessage({
        tone: 'error',
        text: error instanceof Error ? error.message : t('marketing.failed'),
      }),
  });

  const set = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const check = (key: 'spendImportEnabled' | 'capiEnabled' | 'sendNameAndCity', label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        className="size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
        checked={draft[key]}
        disabled={!canEdit}
        onChange={(event) => set({ [key]: event.target.checked })}
      />
      {label}
    </label>
  );

  return (
    <form
      className="grid gap-4 rounded-lg border border-border bg-card p-4 md:grid-cols-2"
      aria-label={t('marketing.nav.meta')}
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(draft);
      }}
    >
      <p className="text-sm text-muted-foreground md:col-span-2">
        {t('marketing.meta.provider')}:{' '}
        <span className="font-medium text-foreground">
          {data.provider === 'graph' ? t('marketing.meta.graph') : t('marketing.meta.fake')}
        </span>
        {' · '}
        {t('marketing.meta.token')}:{' '}
        <span className="font-mono text-foreground">
          {data.tokenConfigured ? (data.tokenFingerprint ?? '') : t('marketing.meta.noToken')}
        </span>
      </p>
      <Field label={t('marketing.meta.adAccount')} id={`${id}-account`} hint="act_…">
        <input
          id={`${id}-account`}
          className={`${control} font-mono`}
          disabled={!canEdit}
          value={draft.adAccountId}
          onChange={(event) => set({ adAccountId: event.target.value })}
        />
      </Field>
      <Field label={t('marketing.meta.pixel')} id={`${id}-pixel`}>
        <input
          id={`${id}-pixel`}
          inputMode="numeric"
          className={`${control} font-mono`}
          disabled={!canEdit}
          value={draft.pixelId}
          onChange={(event) => set({ pixelId: event.target.value })}
        />
      </Field>
      <Field
        label={t('marketing.meta.newToken')}
        id={`${id}-token`}
        hint={t('marketing.meta.tokenHint')}
      >
        <input
          id={`${id}-token`}
          type="password"
          autoComplete="off"
          className={`${control} font-mono`}
          disabled={!canEdit}
          value={draft.token}
          onChange={(event) => set({ token: event.target.value })}
        />
      </Field>
      <Field
        label={t('marketing.meta.testCode')}
        id={`${id}-test`}
        hint={t('marketing.meta.testCodeHint')}
      >
        <input
          id={`${id}-test`}
          className={`${control} font-mono`}
          disabled={!canEdit}
          value={draft.testEventCode}
          onChange={(event) => set({ testEventCode: event.target.value })}
        />
      </Field>
      <div className="space-y-2 md:col-span-2">
        {check('spendImportEnabled', t('marketing.meta.importSwitch'))}
        {check('capiEnabled', t('marketing.meta.capiSwitch'))}
        {check('sendNameAndCity', t('marketing.meta.consentSwitch'))}
      </div>
      {data.lastImportAt === null ? null : (
        <p className="text-sm text-muted-foreground md:col-span-2">
          {t('marketing.meta.lastImport')}: <DateTime value={data.lastImportAt} /> ·{' '}
          {data.lastImportStatus === 'ok'
            ? t('marketing.meta.importOk')
            : `${t('marketing.meta.importFailed')} — ${data.lastImportError ?? ''}`}
        </p>
      )}
      {canEdit ? (
        <div className="md:col-span-2">
          <Button type="submit" size="sm" disabled={save.isPending}>
            {t('marketing.save')}
          </Button>
        </div>
      ) : null}
      {message === null ? null : (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={
            message.tone === 'error'
              ? 'text-sm font-medium text-destructive md:col-span-2'
              : 'text-sm text-muted-foreground md:col-span-2'
          }
        >
          {message.text}
        </p>
      )}
    </form>
  );
}

function ConversionLog() {
  const t = useMarketingT();
  const { locale } = useLocale();
  const [status, setStatus] = useState<CapiStatus | undefined>(undefined);
  const conversions = useQuery({
    queryKey: ['marketing', 'capi', status],
    queryFn: () => listConversions(status),
  });

  const columns = useMemo<readonly DataTableColumn<Conversion>[]>(() => {
    const column = dataTableColumns<Conversion>();
    return column.columns([
      column.accessor('orderId', {
        header: t('marketing.capi.order'),
        cell: (cell) => <span className="font-mono text-xs">{cell.getValue()}</span>,
      }),
      column.accessor('status', {
        header: t('marketing.col.status'),
        cell: (cell) => (
          <StatusBadge tone={CAPI_TONE[cell.getValue()]}>
            {t(`marketing.capi.${cell.getValue()}` as MarketingMessageKey)}
          </StatusBadge>
        ),
      }),
      column.accessor('valuePoisha', {
        header: t('marketing.capi.value'),
        meta: { numeric: true },
        cell: (cell) => {
          const value = cell.getValue();
          return value === null ? '—' : <Money poisha={value} locale={locale} />;
        },
      }),
      column.accessor('attempts', {
        header: t('marketing.capi.attempts'),
        meta: { numeric: true },
      }),
      column.accessor('sentAt', {
        header: t('marketing.capi.sentAt'),
        cell: (cell) => {
          const value = cell.getValue();
          return value === null ? '—' : <DateTime value={value} />;
        },
      }),
      column.accessor('lastError', {
        header: t('marketing.capi.error'),
        cell: (cell) => cell.getValue() ?? '—',
      }),
    ]);
  }, [t, locale]);

  const items = conversions.data?.items ?? [];
  const labels = useMarketingTableLabels(
    t('marketing.capi.emptyTitle'),
    t('marketing.capi.emptyDetail'),
  );

  return (
    <div className="mt-5 space-y-3">
      <h2 className="text-base font-semibold tracking-tight">{t('marketing.capi.title')}</h2>
      <DataTable
        columns={columns}
        data={items}
        getRowId={(row) => row.id}
        page={singlePage(items.length)}
        onPageChange={() => undefined}
        sort={null}
        onSortChange={() => undefined}
        loading={conversions.isPending}
        error={conversions.error}
        onRetry={() => void conversions.refetch()}
        caption={t('marketing.capi.title')}
        labels={labels}
        toolbar={
          <Select
            variant="filter"
            aria-label={t('marketing.col.status')}
            value={status ?? ''}
            onValueChange={(value) => setStatus((value || undefined) as CapiStatus | undefined)}
            options={[
              { value: '', label: t('marketing.capi.allStatuses') },
              ...CAPI_STATUSES.map((value) => ({
                value,
                label: t(`marketing.capi.${value}` as MarketingMessageKey),
              })),
            ]}
          />
        }
      />
    </div>
  );
}
