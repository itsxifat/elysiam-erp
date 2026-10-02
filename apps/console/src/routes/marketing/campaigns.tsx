import {
  Button,
  DataTable,
  PermissionGate,
  StatusBadge,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { control, Field, singlePage } from '../campaigns/campaigns-nav.js';
import {
  addRef,
  createCampaign,
  listCampaigns,
  PLATFORMS,
  REF_KINDS,
  removeRef,
  setCampaignStatus,
  type Campaign,
  type Platform,
  type RefKind,
} from './api.js';
import { MarketingHeader, useMarketingTableLabels } from './marketing-nav.js';
import { useMarketingT, type MarketingMessageKey } from './messages.js';

/**
 * Campaigns and the external ids that attribute orders to them (§11; M18).
 *
 * A mapping is a Meta campaign id, a Meta ad id or a `utm_campaign` value. Each names one
 * campaign in the brand, so attribution is never ambiguous; removing one un-attributes
 * exactly the orders it attributed, because attribution is read, not stored (D-250).
 */
export function MarketingCampaignsPage() {
  const ability = useAbility();
  const t = useMarketingT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Campaign')}
      explain={{ title: t('marketing.deniedTitle'), detail: t('marketing.deniedDetail') }}
    >
      <Campaigns />
    </PermissionGate>
  );
}

function Campaigns() {
  const t = useMarketingT();
  const ability = useAbility();
  const canCreate = ability.can('create', 'Campaign');
  const canEdit = ability.can('update', 'Campaign');
  const queryClient = useQueryClient();
  const id = useId();

  const [name, setName] = useState('');
  const [platform, setPlatform] = useState<Platform>('meta');
  const [startsOn, setStartsOn] = useState('');
  const [endsOn, setEndsOn] = useState('');
  const [utm, setUtm] = useState('');
  const [metaId, setMetaId] = useState('');
  const [mapping, setMapping] = useState<{ campaignId: string; kind: RefKind; value: string }>({
    campaignId: '',
    kind: 'utm_campaign',
    value: '',
  });
  const [failure, setFailure] = useState<string | null>(null);

  const campaigns = useQuery({ queryKey: ['marketing', 'campaigns'], queryFn: listCampaigns });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['marketing'] });
  const failed = (error: unknown) =>
    setFailure(error instanceof Error ? error.message : t('marketing.failed'));

  const create = useMutation({
    mutationFn: createCampaign,
    onSuccess: async () => {
      setName('');
      setUtm('');
      setMetaId('');
      setStartsOn('');
      setEndsOn('');
      setFailure(null);
      await refresh();
    },
    onError: failed,
  });
  const map = useMutation({
    mutationFn: () =>
      addRef(mapping.campaignId, { kind: mapping.kind, value: mapping.value.trim() }),
    onSuccess: async () => {
      setMapping((current) => ({ ...current, value: '' }));
      setFailure(null);
      await refresh();
    },
    onError: failed,
  });
  const unmap = useMutation({
    mutationFn: (input: { campaignId: string; refId: string }) =>
      removeRef(input.campaignId, input.refId),
    onSuccess: refresh,
    onError: failed,
  });
  const archive = useMutation({
    mutationFn: (input: { id: string; status: 'active' | 'archived' }) =>
      setCampaignStatus(input.id, input.status),
    onSuccess: refresh,
    onError: failed,
  });

  const columns = useMemo<readonly DataTableColumn<Campaign>[]>(() => {
    const column = dataTableColumns<Campaign>();
    return column.columns([
      column.accessor('name', {
        header: t('marketing.col.campaign'),
        cell: (cell) => <span className="font-medium">{cell.getValue()}</span>,
      }),
      column.accessor('platform', {
        header: t('marketing.col.platform'),
        cell: (cell) => t(`marketing.platform.${cell.getValue()}` as MarketingMessageKey),
      }),
      column.display({
        id: 'refs',
        header: t('marketing.col.mappings'),
        cell: (cell) => {
          const row = cell.row.original;
          if (row.refs.length === 0) return '—';
          return (
            <ul className="flex flex-wrap gap-1">
              {row.refs.map((ref) => (
                <li
                  key={ref.id}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 font-mono text-xs"
                >
                  <span className="text-muted-foreground">
                    {t(`marketing.ref.${ref.kind}` as MarketingMessageKey)}
                  </span>
                  {ref.value}
                  {canEdit ? (
                    <button
                      type="button"
                      className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      aria-label={`${t('marketing.campaigns.unmap')} ${ref.value}`}
                      onClick={() => unmap.mutate({ campaignId: row.id, refId: ref.id })}
                    >
                      <X aria-hidden="true" className="size-3" />
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          );
        },
      }),
      column.accessor('status', {
        header: t('marketing.col.status'),
        cell: (cell) => (
          <StatusBadge tone={cell.getValue() === 'active' ? 'success' : 'neutral'}>
            {t(`marketing.status.${cell.getValue()}` as MarketingMessageKey)}
          </StatusBadge>
        ),
      }),
      column.display({
        id: 'actions',
        header: '',
        cell: (cell) => {
          const row = cell.row.original;
          if (!canEdit) return null;
          const next = row.status === 'active' ? 'archived' : 'active';
          return (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => archive.mutate({ id: row.id, status: next })}
            >
              {t(
                row.status === 'active'
                  ? 'marketing.campaigns.archive'
                  : 'marketing.campaigns.restore',
              )}
            </Button>
          );
        },
      }),
    ]);
    // The mutations are stable; `t` and the two grants are what change the columns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, canEdit]);

  const items = campaigns.data?.items ?? [];
  const labels = useMarketingTableLabels(
    t('marketing.campaigns.emptyTitle'),
    t('marketing.campaigns.emptyDetail'),
  );

  function submit() {
    const refs = [
      ...utm
        .split(',')
        .map((value) => value.trim())
        .filter((value) => value !== '')
        .map((value) => ({ kind: 'utm_campaign' as const, value })),
      ...(metaId.trim() === '' ? [] : [{ kind: 'meta_campaign' as const, value: metaId.trim() }]),
    ];
    create.mutate({
      name: name.trim(),
      platform,
      ...(startsOn === '' ? {} : { startsOn }),
      ...(endsOn === '' ? {} : { endsOn }),
      ...(refs.length === 0 ? {} : { refs }),
    });
  }

  return (
    <div className="space-y-5">
      <MarketingHeader
        title={t('marketing.nav.campaigns')}
        caption={t('marketing.campaigns.subtitle')}
      />

      {canCreate ? (
        <form
          className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim() !== '') submit();
          }}
        >
          <div className="md:col-span-2">
            <Field label={t('marketing.col.campaign')} id={`${id}-name`}>
              <input
                id={`${id}-name`}
                className={control}
                maxLength={200}
                required
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </div>
          <Field label={t('marketing.col.platform')} id={`${id}-platform`}>
            <select
              id={`${id}-platform`}
              className={control}
              value={platform}
              onChange={(event) => setPlatform(event.target.value as Platform)}
            >
              {PLATFORMS.map((value) => (
                <option key={value} value={value}>
                  {t(`marketing.platform.${value}` as MarketingMessageKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t('marketing.campaigns.startsOn')}
            id={`${id}-start`}
            hint={t('marketing.optional')}
          >
            <input
              id={`${id}-start`}
              type="date"
              className={control}
              value={startsOn}
              onChange={(event) => setStartsOn(event.target.value)}
            />
          </Field>
          <Field
            label={t('marketing.campaigns.endsOn')}
            id={`${id}-end`}
            hint={t('marketing.optional')}
          >
            <input
              id={`${id}-end`}
              type="date"
              className={control}
              value={endsOn}
              min={startsOn === '' ? undefined : startsOn}
              onChange={(event) => setEndsOn(event.target.value)}
            />
          </Field>
          <div className="md:col-span-3">
            <Field
              label={t('marketing.campaigns.utm')}
              id={`${id}-utm`}
              hint={t('marketing.campaigns.utmHint')}
            >
              <input
                id={`${id}-utm`}
                className={`${control} font-mono`}
                value={utm}
                onChange={(event) => setUtm(event.target.value)}
              />
            </Field>
          </div>
          <div className="md:col-span-2">
            <Field
              label={t('marketing.ref.meta_campaign')}
              id={`${id}-meta`}
              hint={t('marketing.optional')}
            >
              <input
                id={`${id}-meta`}
                inputMode="numeric"
                className={`${control} font-mono`}
                value={metaId}
                onChange={(event) => setMetaId(event.target.value)}
              />
            </Field>
          </div>
          <div className="flex items-end">
            <Button type="submit" size="sm" disabled={create.isPending}>
              {t('marketing.campaigns.create')}
            </Button>
          </div>
        </form>
      ) : null}

      {canEdit && items.length > 0 ? (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4"
          aria-label={t('marketing.campaigns.map')}
          onSubmit={(event) => {
            event.preventDefault();
            if (mapping.campaignId !== '' && mapping.value.trim() !== '') map.mutate();
          }}
        >
          <div className="min-w-48">
            <Field label={t('marketing.col.campaign')} id={`${id}-map-campaign`}>
              <select
                id={`${id}-map-campaign`}
                className={control}
                value={mapping.campaignId}
                onChange={(event) =>
                  setMapping((current) => ({ ...current, campaignId: event.target.value }))
                }
              >
                <option value="">—</option>
                {items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label={t('marketing.campaigns.kind')} id={`${id}-map-kind`}>
            <select
              id={`${id}-map-kind`}
              className={control}
              value={mapping.kind}
              onChange={(event) =>
                setMapping((current) => ({ ...current, kind: event.target.value as RefKind }))
              }
            >
              {REF_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {t(`marketing.ref.${kind}` as MarketingMessageKey)}
                </option>
              ))}
            </select>
          </Field>
          <div className="min-w-48 flex-1">
            <Field label={t('marketing.campaigns.value')} id={`${id}-map-value`}>
              <input
                id={`${id}-map-value`}
                className={`${control} font-mono`}
                maxLength={120}
                value={mapping.value}
                onChange={(event) =>
                  setMapping((current) => ({ ...current, value: event.target.value }))
                }
              />
            </Field>
          </div>
          <Button type="submit" size="sm" variant="outline" disabled={map.isPending}>
            {t('marketing.campaigns.map')}
          </Button>
        </form>
      ) : null}

      {failure === null ? null : (
        <p role="alert" className="text-sm font-medium text-destructive">
          {failure}
        </p>
      )}

      <DataTable
        columns={columns}
        data={items}
        getRowId={(row) => row.id}
        page={singlePage(items.length)}
        onPageChange={() => undefined}
        sort={null}
        onSortChange={() => undefined}
        loading={campaigns.isPending}
        error={campaigns.error}
        onRetry={() => void campaigns.refetch()}
        caption={t('marketing.nav.campaigns')}
        labels={labels}
      />
    </div>
  );
}
