import {
  Button,
  DataTable,
  Money,
  PermissionGate,
  StatusBadge,
  dataTableColumns,
  takaToPoisha,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useMemo, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { control, Field, singlePage } from '../campaigns/campaigns-nav.js';
import { enterSpend, listSpend, requestImport, spendCampaigns, type SpendRow } from './api.js';
import { daysInclusive, dhakaToday, monthStart } from './format.js';
import { MarketingHeader, PeriodPicker, useMarketingTableLabels } from './marketing-nav.js';
import { useMarketingT } from './messages.js';

/**
 * Ad spend, one figure per campaign per day (§11; M18 check 2 made visible).
 *
 * `CampaignSpend`: marketing, org_admin and accounts ("spend entry", §6). Entering a day
 * again replaces it, and a figure a person entered is never overwritten by the Meta import
 * (D-252); a figure the import wrote is marked as Meta's.
 */
export function MarketingSpendPage() {
  const ability = useAbility();
  const t = useMarketingT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'CampaignSpend')}
      explain={{ title: t('marketing.deniedTitle'), detail: t('marketing.deniedDetail') }}
    >
      <Spend />
    </PermissionGate>
  );
}

function Spend() {
  const t = useMarketingT();
  const { locale } = useLocale();
  const ability = useAbility();
  const canEnter = ability.can('create', 'CampaignSpend');
  const queryClient = useQueryClient();
  const id = useId();
  const today = dhakaToday();
  const [period, setPeriod] = useState({ from: monthStart(today), to: today });
  const [entry, setEntry] = useState({ campaignId: '', spendDate: today, amount: '', note: '' });
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [invalidAmount, setInvalidAmount] = useState(false);

  const choices = useQuery({ queryKey: ['marketing', 'spend-campaigns'], queryFn: spendCampaigns });
  const valid = daysInclusive(period.from, period.to) >= 1;
  const spend = useQuery({
    queryKey: ['marketing', 'spend', period.from, period.to],
    queryFn: () => listSpend(period.from, period.to),
    enabled: valid,
  });
  const names = new Map((choices.data?.items ?? []).map((item) => [item.id, item.name]));

  const failed = (error: unknown) =>
    setMessage({
      tone: 'error',
      text: error instanceof Error ? error.message : t('marketing.failed'),
    });

  const save = useMutation({
    mutationFn: enterSpend,
    onSuccess: async () => {
      setEntry((current) => ({ ...current, amount: '', note: '' }));
      setMessage({ tone: 'ok', text: t('marketing.spend.saved') });
      await queryClient.invalidateQueries({ queryKey: ['marketing'] });
    },
    onError: failed,
  });
  const importNow = useMutation({
    mutationFn: () => requestImport(period.from, period.to),
    onSuccess: () => setMessage({ tone: 'ok', text: t('marketing.spend.importQueued') }),
    onError: failed,
  });

  function submit() {
    const amountPoisha = takaToPoisha(entry.amount);
    if (amountPoisha === null || amountPoisha.startsWith('-')) {
      setInvalidAmount(true);
      return;
    }
    setInvalidAmount(false);
    save.mutate({
      campaignId: entry.campaignId,
      spendDate: entry.spendDate,
      amountPoisha,
      ...(entry.note.trim() === '' ? {} : { note: entry.note.trim() }),
    });
  }

  const columns = useMemo<readonly DataTableColumn<SpendRow>[]>(() => {
    const column = dataTableColumns<SpendRow>();
    return column.columns([
      column.accessor('spendDate', {
        header: t('marketing.col.date'),
        cell: (cell) => <span className="tabular-nums">{cell.getValue()}</span>,
      }),
      column.accessor('campaignId', {
        header: t('marketing.col.campaign'),
        cell: (cell) => names.get(cell.getValue()) ?? '—',
      }),
      column.accessor('amountPoisha', {
        header: t('marketing.metric.spend'),
        meta: { numeric: true },
        cell: (cell) => <Money poisha={cell.getValue()} locale={locale} />,
      }),
      column.accessor('source', {
        header: t('marketing.col.source'),
        cell: (cell) => (
          <StatusBadge tone={cell.getValue() === 'manual' ? 'neutral' : 'info'}>
            {t(cell.getValue() === 'manual' ? 'marketing.source.manual' : 'marketing.source.meta')}
          </StatusBadge>
        ),
      }),
      column.accessor('note', {
        header: t('marketing.col.note'),
        cell: (cell) => cell.getValue() ?? '—',
      }),
    ]);
    // `names` is rebuilt from the picker's query; it changes when that does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, locale, choices.data]);

  const items = spend.data?.items ?? [];
  const labels = useMarketingTableLabels(
    t('marketing.spend.emptyTitle'),
    t('marketing.spend.emptyDetail'),
  );

  return (
    <div className="space-y-5">
      <MarketingHeader
        title={t('marketing.nav.spend')}
        caption={t('marketing.spend.subtitle')}
        actions={
          <>
            <PeriodPicker idPrefix={id} from={period.from} to={period.to} onChange={setPeriod} />
            {canEnter ? (
              <Button
                size="sm"
                variant="outline"
                disabled={
                  importNow.isPending || !valid || daysInclusive(period.from, period.to) > 92
                }
                onClick={() => importNow.mutate()}
              >
                {t('marketing.spend.import')}
              </Button>
            ) : null}
          </>
        }
      />

      {canEnter ? (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4"
          aria-label={t('marketing.spend.enter')}
          onSubmit={(event) => {
            event.preventDefault();
            if (entry.campaignId !== '') submit();
          }}
        >
          <div className="min-w-48">
            <Field label={t('marketing.col.campaign')} id={`${id}-campaign`}>
              <select
                id={`${id}-campaign`}
                className={control}
                required
                value={entry.campaignId}
                onChange={(event) =>
                  setEntry((current) => ({ ...current, campaignId: event.target.value }))
                }
              >
                <option value="">—</option>
                {(choices.data?.items ?? [])
                  .filter((item) => item.status === 'active')
                  .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <Field label={t('marketing.col.date')} id={`${id}-date`}>
            <input
              id={`${id}-date`}
              type="date"
              className={`${control} tabular-nums`}
              required
              max={today}
              value={entry.spendDate}
              onChange={(event) =>
                setEntry((current) => ({ ...current, spendDate: event.target.value }))
              }
            />
          </Field>
          <div className="w-36">
            <Field
              label={t('marketing.spend.amount')}
              id={`${id}-amount`}
              error={invalidAmount ? t('marketing.spend.invalidAmount') : undefined}
            >
              <input
                id={`${id}-amount`}
                inputMode="decimal"
                className={`${control} text-right tabular-nums`}
                required
                value={entry.amount}
                aria-invalid={invalidAmount}
                aria-describedby={invalidAmount ? `${id}-amount-error` : undefined}
                onChange={(event) =>
                  setEntry((current) => ({ ...current, amount: event.target.value }))
                }
              />
            </Field>
          </div>
          <div className="min-w-48 flex-1">
            <Field label={t('marketing.col.note')} id={`${id}-note`} hint={t('marketing.optional')}>
              <input
                id={`${id}-note`}
                className={control}
                maxLength={500}
                value={entry.note}
                onChange={(event) =>
                  setEntry((current) => ({ ...current, note: event.target.value }))
                }
              />
            </Field>
          </div>
          <Button type="submit" size="sm" disabled={save.isPending}>
            {t('marketing.spend.save')}
          </Button>
        </form>
      ) : null}

      {message === null ? null : (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={
            message.tone === 'error'
              ? 'text-sm font-medium text-destructive'
              : 'text-sm text-muted-foreground'
          }
        >
          {message.text}
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
        loading={spend.isPending && valid}
        error={spend.error}
        onRetry={() => void spend.refetch()}
        caption={t('marketing.nav.spend')}
        labels={labels}
      />
    </div>
  );
}
