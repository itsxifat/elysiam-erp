import {
  Button,
  ConfirmDialog,
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
import { addOptOut, listOptOuts, removeOptOut, type OptOut } from './api.js';
import {
  CampaignsHeader,
  control,
  Field,
  singlePage,
  useCampaignTableLabels,
} from './campaigns-nav.js';
import { useCampaignsT } from './messages.js';

/**
 * Opt-outs (M16; D-205): numbers that asked for no more offers.
 *
 * An opted-out number still receives a sign-in code — a person locked out of their account
 * did not ask to stay locked out — and nothing else that is marketing. It is also left out
 * of every re-engagement list and file (D-208). Removing one asks first, because it is the
 * one action here that starts sending somebody offers again.
 */
export function OptOutsPage() {
  const ability = useAbility();
  const t = useCampaignsT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'Campaign')}
      explain={{ title: t('campaigns.deniedTitle'), detail: t('campaigns.deniedDetail') }}
    >
      <OptOuts />
    </PermissionGate>
  );
}

const MOBILE = /^01[3-9]\d{8}$/;

function OptOuts() {
  const t = useCampaignsT();
  const ability = useAbility();
  const canEdit = ability.can('update', 'Campaign');
  const queryClient = useQueryClient();
  const id = useId();
  const [phone, setPhone] = useState('');
  const [reason, setReason] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState(false);
  const [removing, setRemoving] = useState<OptOut | null>(null);

  const optOuts = useQuery({ queryKey: ['campaigns', 'opt-outs'], queryFn: listOptOuts });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['campaigns', 'opt-outs'] });

  const add = useMutation({
    mutationFn: addOptOut,
    onSuccess: async () => {
      setPhone('');
      setReason('');
      await refresh();
    },
    onError: () => setFailure(true),
  });
  const remove = useMutation({
    mutationFn: removeOptOut,
    onSuccess: async () => {
      setRemoving(null);
      await refresh();
    },
  });

  function submit() {
    setFailure(false);
    const normalized = normalizeBdPhone(phone);
    if (!MOBILE.test(normalized)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    add.mutate({ phone: normalized, ...(reason.trim() === '' ? {} : { reason: reason.trim() }) });
  }

  const columns = useMemo<readonly DataTableColumn<OptOut>[]>(() => {
    const column = dataTableColumns<OptOut>();
    return column.columns([
      column.accessor('phone', {
        header: t('campaigns.optOuts.phone'),
        cell: (cell) => <span className="tabular-nums">{cell.getValue()}</span>,
      }),
      column.accessor('reason', {
        header: t('campaigns.optOuts.reason'),
        cell: (cell) => cell.getValue() ?? '—',
      }),
      column.accessor('createdAt', {
        header: t('campaigns.optOuts.since'),
        cell: (cell) => <DateTime value={cell.getValue()} dateOnly />,
      }),
      column.display({
        id: 'remove',
        header: '',
        cell: (cell) =>
          canEdit ? (
            <Button size="sm" variant="ghost" onClick={() => setRemoving(cell.row.original)}>
              {t('campaigns.optOuts.remove')}
            </Button>
          ) : null,
      }),
    ]);
  }, [t, canEdit]);

  const items = optOuts.data?.items ?? [];
  const labels = useCampaignTableLabels(
    t('campaigns.optOuts.emptyTitle'),
    t('campaigns.optOuts.emptyDetail'),
  );

  return (
    <div className="space-y-5">
      <CampaignsHeader
        title={t('campaigns.nav.optOuts')}
        caption={t('campaigns.optOuts.subtitle')}
      />

      {canEdit ? (
        <form
          className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-card p-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="w-48">
            <Field
              label={t('campaigns.optOuts.phone')}
              id={`${id}-phone`}
              error={invalid ? t('campaigns.optOuts.invalidPhone') : undefined}
            >
              <input
                id={`${id}-phone`}
                type="tel"
                inputMode="tel"
                autoComplete="off"
                className={`${control} tabular-nums`}
                value={phone}
                aria-invalid={invalid}
                aria-describedby={invalid ? `${id}-phone-error` : undefined}
                onChange={(event) => setPhone(event.target.value)}
              />
            </Field>
          </div>
          <div className="min-w-48 flex-1">
            <Field
              label={t('campaigns.optOuts.reason')}
              id={`${id}-reason`}
              hint={t('campaigns.optional')}
            >
              <input
                id={`${id}-reason`}
                className={control}
                maxLength={200}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          </div>
          <Button type="submit" size="sm" disabled={add.isPending}>
            {t('campaigns.optOuts.add')}
          </Button>
          {failure ? (
            <p role="alert" className="w-full text-sm font-medium text-destructive">
              {t('campaigns.optOuts.failed')}
            </p>
          ) : null}
        </form>
      ) : null}

      <DataTable
        columns={columns}
        data={items}
        getRowId={(row) => row.id}
        page={singlePage(items.length)}
        onPageChange={() => undefined}
        sort={null}
        onSortChange={() => undefined}
        loading={optOuts.isPending}
        error={optOuts.error}
        onRetry={() => void optOuts.refetch()}
        caption={t('campaigns.nav.optOuts')}
        labels={labels}
      />

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
        title={t('campaigns.optOuts.removeTitle')}
        description={t('campaigns.optOuts.removeDetail')}
        confirmLabel={t('campaigns.optOuts.remove')}
        cancelLabel={t('campaigns.cancel')}
        closeLabel={t('campaigns.close')}
        destructive
        onConfirm={async () => {
          if (removing !== null) await remove.mutateAsync(removing.phone);
        }}
      />
    </div>
  );
}
