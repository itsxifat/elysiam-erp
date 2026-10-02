import {
  Button,
  DataTable,
  DateTime,
  PermissionGate,
  dataTableColumns,
  normalizeBdPhone,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { control, Field, singlePage } from '../campaigns/campaigns-nav.js';
import {
  AGE_BANDS,
  createLead,
  LEAD_CHANNELS,
  LEAD_DIMENSIONS,
  LEAD_STATUSES,
  leadSegments,
  listLeads,
  setLeadStatus,
  type AgeBand,
  type Lead,
  type LeadDimension,
  type LeadStatus,
  type SegmentRow,
} from './api.js';
import { percent } from './format.js';
import { MarketingHeader, useMarketingTableLabels } from './marketing-nav.js';
import { isMarketingKey, useMarketingT, type MarketingMessageKey } from './messages.js';

/**
 * Leads: people who asked and have not bought, or not yet (§1, §11; M18).
 *
 * Product and size of interest, age band and profession are the client's four segment
 * dimensions; the segments screen groups by each (D-258).
 */
export function MarketingLeadsPage() {
  const ability = useAbility();
  const t = useMarketingT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Campaign')}
      explain={{ title: t('marketing.deniedTitle'), detail: t('marketing.deniedDetail') }}
    >
      <Leads />
    </PermissionGate>
  );
}

export function MarketingSegmentsPage() {
  const ability = useAbility();
  const t = useMarketingT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Campaign')}
      explain={{ title: t('marketing.deniedTitle'), detail: t('marketing.deniedDetail') }}
    >
      <Segments />
    </PermissionGate>
  );
}

const MOBILE = /^01[3-9]\d{8}$/;

function Leads() {
  const t = useMarketingT();
  const ability = useAbility();
  const canCreate = ability.can('create', 'Campaign');
  const canEdit = ability.can('update', 'Campaign');
  const queryClient = useQueryClient();
  const id = useId();
  const [status, setStatus] = useState<LeadStatus | undefined>(undefined);
  const [form, setForm] = useState({
    phone: '',
    name: '',
    channel: 'facebook',
    size: '',
    ageBand: '' as AgeBand | '',
    profession: '',
  });
  const [invalidPhone, setInvalidPhone] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const leads = useQuery({
    queryKey: ['marketing', 'leads', status],
    queryFn: () => listLeads(status),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['marketing', 'leads'] });
  const failed = (error: unknown) =>
    setFailure(error instanceof Error ? error.message : t('marketing.failed'));

  const create = useMutation({
    mutationFn: createLead,
    onSuccess: async () => {
      setForm((current) => ({ ...current, phone: '', name: '', size: '', profession: '' }));
      setFailure(null);
      await refresh();
    },
    onError: failed,
  });
  const move = useMutation({
    mutationFn: (input: { id: string; status: LeadStatus }) =>
      setLeadStatus(input.id, input.status),
    onSuccess: refresh,
    onError: failed,
  });

  function submit() {
    const phone = normalizeBdPhone(form.phone);
    if (!MOBILE.test(phone)) {
      setInvalidPhone(true);
      return;
    }
    setInvalidPhone(false);
    create.mutate({
      phone,
      channel: form.channel,
      ...(form.name.trim() === '' ? {} : { name: form.name.trim() }),
      ...(form.size.trim() === '' ? {} : { size: form.size.trim() }),
      ...(form.ageBand === '' ? {} : { ageBand: form.ageBand }),
      ...(form.profession.trim() === '' ? {} : { profession: form.profession.trim() }),
    });
  }

  const columns = useMemo<readonly DataTableColumn<Lead>[]>(() => {
    const column = dataTableColumns<Lead>();
    return column.columns([
      column.accessor('phone', {
        header: t('marketing.col.phone'),
        cell: (cell) => <span className="tabular-nums">{cell.getValue()}</span>,
      }),
      column.accessor('name', {
        header: t('marketing.col.name'),
        cell: (cell) => cell.getValue() ?? '—',
      }),
      column.accessor('channel', {
        header: t('marketing.col.channel'),
        cell: (cell) => {
          const key = `marketing.channel.${cell.getValue()}`;
          return isMarketingKey(key) ? t(key) : cell.getValue();
        },
      }),
      column.accessor('size', {
        header: t('marketing.dimension.size'),
        cell: (cell) => cell.getValue() ?? '—',
      }),
      column.accessor('ageBand', {
        header: t('marketing.dimension.age_band'),
        cell: (cell) => {
          const value = cell.getValue();
          return value === null ? '—' : t(`marketing.age.${value}` as MarketingMessageKey);
        },
      }),
      column.accessor('profession', {
        header: t('marketing.dimension.profession'),
        cell: (cell) => cell.getValue() ?? '—',
      }),
      column.accessor('createdAt', {
        header: t('marketing.col.date'),
        cell: (cell) => <DateTime value={cell.getValue()} dateOnly />,
      }),
      column.accessor('status', {
        header: t('marketing.col.status'),
        cell: (cell) =>
          canEdit ? (
            <select
              aria-label={t('marketing.col.status')}
              className={`${control} w-auto`}
              value={cell.getValue()}
              onChange={(event) =>
                move.mutate({ id: cell.row.original.id, status: event.target.value as LeadStatus })
              }
            >
              {LEAD_STATUSES.map((value) => (
                <option key={value} value={value}>
                  {t(`marketing.lead.${value}` as MarketingMessageKey)}
                </option>
              ))}
            </select>
          ) : (
            t(`marketing.lead.${cell.getValue()}` as MarketingMessageKey)
          ),
      }),
    ]);
    // The mutation is stable; `t` and the grant are what change the columns.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, canEdit]);

  const items = leads.data?.items ?? [];
  const labels = useMarketingTableLabels(
    t('marketing.leads.emptyTitle'),
    t('marketing.leads.emptyDetail'),
  );

  return (
    <div className="space-y-5">
      <MarketingHeader title={t('marketing.nav.leads')} caption={t('marketing.leads.subtitle')} />

      {canCreate ? (
        <form
          className="grid gap-3 rounded-lg border border-border bg-card p-4 md:grid-cols-7"
          aria-label={t('marketing.leads.add')}
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <Field
            label={t('marketing.col.phone')}
            id={`${id}-phone`}
            error={invalidPhone ? t('marketing.leads.invalidPhone') : undefined}
          >
            <input
              id={`${id}-phone`}
              type="tel"
              inputMode="tel"
              autoComplete="off"
              required
              className={`${control} tabular-nums`}
              value={form.phone}
              aria-invalid={invalidPhone}
              aria-describedby={invalidPhone ? `${id}-phone-error` : undefined}
              onChange={(event) =>
                setForm((current) => ({ ...current, phone: event.target.value }))
              }
            />
          </Field>
          <Field label={t('marketing.col.name')} id={`${id}-name`} hint={t('marketing.optional')}>
            <input
              id={`${id}-name`}
              className={control}
              maxLength={200}
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            />
          </Field>
          <Field label={t('marketing.col.channel')} id={`${id}-channel`}>
            <select
              id={`${id}-channel`}
              className={control}
              value={form.channel}
              onChange={(event) =>
                setForm((current) => ({ ...current, channel: event.target.value }))
              }
            >
              {LEAD_CHANNELS.map((value) => (
                <option key={value} value={value}>
                  {t(`marketing.channel.${value}` as MarketingMessageKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t('marketing.dimension.size')}
            id={`${id}-size`}
            hint={t('marketing.optional')}
          >
            <input
              id={`${id}-size`}
              className={control}
              maxLength={40}
              value={form.size}
              onChange={(event) => setForm((current) => ({ ...current, size: event.target.value }))}
            />
          </Field>
          <Field label={t('marketing.dimension.age_band')} id={`${id}-age`}>
            <select
              id={`${id}-age`}
              className={control}
              value={form.ageBand}
              onChange={(event) =>
                setForm((current) => ({ ...current, ageBand: event.target.value as AgeBand | '' }))
              }
            >
              <option value="">—</option>
              {AGE_BANDS.map((value) => (
                <option key={value} value={value}>
                  {t(`marketing.age.${value}` as MarketingMessageKey)}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t('marketing.dimension.profession')}
            id={`${id}-profession`}
            hint={t('marketing.optional')}
          >
            <input
              id={`${id}-profession`}
              className={control}
              maxLength={80}
              value={form.profession}
              onChange={(event) =>
                setForm((current) => ({ ...current, profession: event.target.value }))
              }
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" size="sm" disabled={create.isPending}>
              {t('marketing.leads.add')}
            </Button>
          </div>
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
        loading={leads.isPending}
        error={leads.error}
        onRetry={() => void leads.refetch()}
        caption={t('marketing.nav.leads')}
        labels={labels}
        toolbar={
          <select
            aria-label={t('marketing.col.status')}
            value={status ?? ''}
            className={`${control} w-auto`}
            onChange={(event) =>
              setStatus((event.target.value || undefined) as LeadStatus | undefined)
            }
          >
            <option value="">{t('marketing.leads.allStatuses')}</option>
            {LEAD_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`marketing.lead.${value}` as MarketingMessageKey)}
              </option>
            ))}
          </select>
        }
      />
    </div>
  );
}

function Segments() {
  const t = useMarketingT();
  const [dimension, setDimension] = useState<LeadDimension>('product');
  const segments = useQuery({
    queryKey: ['marketing', 'segments', dimension],
    queryFn: () => leadSegments(dimension),
  });

  const columns = useMemo<readonly DataTableColumn<SegmentRow>[]>(() => {
    const column = dataTableColumns<SegmentRow>();
    return column.columns([
      column.accessor('label', {
        header: t(`marketing.dimension.${dimension}` as MarketingMessageKey),
        cell: (cell) => {
          const row = cell.row.original;
          if (row.key === null) return t('marketing.segments.notStated');
          if (dimension === 'age_band') return t(`marketing.age.${row.key}` as MarketingMessageKey);
          return cell.getValue() ?? row.key;
        },
      }),
      column.accessor('leads', { header: t('marketing.segments.leads'), meta: { numeric: true } }),
      column.accessor('converted', {
        header: t('marketing.segments.converted'),
        meta: { numeric: true },
      }),
      column.accessor('conversionBps', {
        header: t('marketing.segments.conversion'),
        meta: { numeric: true },
        cell: (cell) => percent(cell.getValue()),
      }),
    ]);
  }, [t, dimension]);

  const rows = segments.data?.rows ?? [];
  const labels = useMarketingTableLabels(
    t('marketing.leads.emptyTitle'),
    t('marketing.leads.emptyDetail'),
  );

  return (
    <div className="space-y-5">
      <MarketingHeader
        title={t('marketing.nav.segments')}
        caption={t('marketing.segments.subtitle')}
      />
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(row) => row.key ?? 'not-stated'}
        page={singlePage(rows.length)}
        onPageChange={() => undefined}
        sort={null}
        onSortChange={() => undefined}
        loading={segments.isPending}
        error={segments.error}
        onRetry={() => void segments.refetch()}
        caption={t('marketing.nav.segments')}
        labels={labels}
        toolbar={
          <select
            aria-label={t('marketing.segments.by')}
            value={dimension}
            className={`${control} w-auto`}
            onChange={(event) => setDimension(event.target.value as LeadDimension)}
          >
            {LEAD_DIMENSIONS.map((value) => (
              <option key={value} value={value}>
                {t(`marketing.dimension.${value}` as MarketingMessageKey)}
              </option>
            ))}
          </select>
        }
      />
    </div>
  );
}
