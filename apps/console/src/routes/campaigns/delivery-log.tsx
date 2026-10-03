import {
  DataTable,
  DateTime,
  PermissionGate,
  Select,
  StatusBadge,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { listMessages, MESSAGE_STATES, type MessageState, type SentMessage } from './api.js';
import { CampaignsHeader, singlePage, useCampaignTableLabels } from './campaigns-nav.js';
import { useCampaignsT, type CampaignsMessageKey } from './messages.js';

/**
 * The delivery log (M16; D-205): every message the brand has queued, newest first.
 *
 * "Due" is when the message may go out: an offer queued at 22:00 Dhaka says 09:00 the next
 * morning, which is check 4 made visible. A suppressed message went to a number that opted
 * out, and was never sent.
 */
export function DeliveryLogPage() {
  const ability = useAbility();
  const t = useCampaignsT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Campaign')}
      explain={{ title: t('campaigns.deniedTitle'), detail: t('campaigns.deniedDetail') }}
    >
      <DeliveryLog />
    </PermissionGate>
  );
}

const TONE: Record<MessageState, 'info' | 'success' | 'danger' | 'neutral'> = {
  queued: 'info',
  sent: 'success',
  failed: 'danger',
  suppressed: 'neutral',
};

function DeliveryLog() {
  const t = useCampaignsT();
  const [state, setState] = useState<MessageState | undefined>(undefined);
  const messages = useQuery({
    queryKey: ['campaigns', 'log', state],
    queryFn: () => listMessages(state),
  });

  const columns = useMemo<readonly DataTableColumn<SentMessage>[]>(() => {
    const column = dataTableColumns<SentMessage>();
    return column.columns([
      column.accessor('phone', {
        header: t('campaigns.log.col.to'),
        cell: (cell) => <span className="tabular-nums">{cell.getValue()}</span>,
      }),
      column.accessor('templateKey', {
        header: t('campaigns.log.col.template'),
        cell: (cell) => <span className="font-mono text-sm">{cell.getValue()}</span>,
      }),
      column.accessor('state', {
        header: t('campaigns.log.col.state'),
        cell: (cell) => (
          <StatusBadge tone={TONE[cell.getValue()]}>
            {t(`campaigns.log.state.${cell.getValue()}` as CampaignsMessageKey)}
          </StatusBadge>
        ),
      }),
      column.accessor('sendAfter', {
        header: t('campaigns.log.col.due'),
        cell: (cell) => <DateTime value={cell.getValue()} />,
      }),
      column.accessor('sentAt', {
        header: t('campaigns.log.col.sent'),
        cell: (cell) => {
          const value = cell.getValue();
          return value === null ? '—' : <DateTime value={value} />;
        },
      }),
      column.accessor('error', {
        header: t('campaigns.log.col.error'),
        cell: (cell) => cell.getValue() ?? '—',
      }),
    ]);
  }, [t]);

  const items = messages.data?.items ?? [];
  const labels = useCampaignTableLabels(
    t('campaigns.log.emptyTitle'),
    t('campaigns.log.emptyDetail'),
  );

  return (
    <div className="space-y-5">
      <CampaignsHeader title={t('campaigns.nav.log')} caption={t('campaigns.log.subtitle')} />
      <DataTable
        columns={columns}
        data={items}
        getRowId={(row) => row.id}
        page={singlePage(items.length)}
        onPageChange={() => undefined}
        sort={null}
        onSortChange={() => undefined}
        loading={messages.isPending}
        error={messages.error}
        onRetry={() => void messages.refetch()}
        caption={t('campaigns.nav.log')}
        labels={labels}
        toolbar={
          <Select
            variant="filter"
            aria-label={t('campaigns.log.col.state')}
            value={state ?? ''}
            onValueChange={(value) => setState((value || undefined) as MessageState | undefined)}
            options={[
              { value: '', label: t('campaigns.log.allStates') },
              ...MESSAGE_STATES.map((value) => ({
                value,
                label: t(`campaigns.log.state.${value}` as CampaignsMessageKey),
              })),
            ]}
          />
        }
      />
    </div>
  );
}
