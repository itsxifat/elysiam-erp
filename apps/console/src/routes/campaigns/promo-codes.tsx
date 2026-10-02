import {
  Button,
  DataTable,
  Dialog,
  Money,
  PermissionGate,
  StatusBadge,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { isOrdersKey, useOrdersT } from '../orders/messages.js';
import {
  createPromoCode,
  listPromoCodes,
  PROMO_FORM_CHANNELS,
  PROMO_KINDS,
  PROMO_STATUSES,
  setPromoStatus,
  type PromoCode,
  type PromoKind,
  type PromoStatus,
} from './api.js';
import {
  CampaignsHeader,
  control,
  Field,
  singlePage,
  useCampaignTableLabels,
} from './campaigns-nav.js';
import { useCampaignsT, type CampaignsMessageKey } from './messages.js';
import {
  checkPromoForm,
  offerParts,
  type PromoFormErrors,
  type PromoFormValues,
} from './promo-form.js';

/**
 * Promo codes (M16; D-203, D-204): the list, a new code, and pausing or archiving one.
 *
 * `read LandingPage` to see them, `create` and `update` to make and change them. A code's
 * value cannot be edited once it exists: a buyer who was told "10% off" was told it about
 * that code, so a different offer is a different code. Occasion codes the CRM issued are
 * listed too, marked personal, so a marketer can see what the birthday job has given out.
 */
export function PromoCodesPage() {
  const ability = useAbility();
  const t = useCampaignsT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'LandingPage')}
      explain={{
        title: t('campaigns.codes.deniedTitle'),
        detail: t('campaigns.codes.deniedDetail'),
      }}
    >
      <PromoCodes />
    </PermissionGate>
  );
}

const TONE: Record<PromoStatus, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  paused: 'warning',
  archived: 'neutral',
};

function PromoCodes() {
  const t = useCampaignsT();
  const tOrders = useOrdersT();
  const { locale } = useLocale();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<PromoStatus | undefined>(undefined);
  const [creating, setCreating] = useState(false);

  const codes = useQuery({
    queryKey: ['campaigns', 'codes', status],
    queryFn: () => listPromoCodes(status),
  });

  const changeStatus = useMutation({
    mutationFn: ({ id, next }: { id: string; next: PromoStatus }) => setPromoStatus(id, next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['campaigns', 'codes'] });
    },
  });

  const canUpdate = ability.can('update', 'LandingPage');

  const columns = useMemo<readonly DataTableColumn<PromoCode>[]>(() => {
    const column = dataTableColumns<PromoCode>();
    const channel = (value: string) => {
      const key = `orders.channel.${value}`;
      return isOrdersKey(key) ? tOrders(key) : value;
    };
    return column.columns([
      column.accessor('code', {
        header: t('campaigns.codes.col.code'),
        cell: (cell) => (
          <span className="inline-flex items-center gap-2">
            <span className="font-mono text-sm font-medium">{cell.getValue()}</span>
            {cell.row.original.customerId === null ? null : (
              <StatusBadge tone="info">
                {cell.row.original.origin === 'occasion'
                  ? t('campaigns.codes.origin.occasion')
                  : t('campaigns.codes.personal')}
              </StatusBadge>
            )}
          </span>
        ),
      }),
      column.display({
        id: 'offer',
        header: t('campaigns.codes.col.offer'),
        cell: (cell) => {
          const offer = offerParts(cell.row.original);
          if ('freeDelivery' in offer) return t('campaigns.codes.kind.free_delivery');
          return (
            <span className="tabular-nums">
              {'percent' in offer ? offer.percent : <Money poisha={offer.poisha} locale={locale} />}{' '}
              {t('campaigns.codes.off')}
            </span>
          );
        },
      }),
      column.display({
        id: 'used',
        header: t('campaigns.codes.col.used'),
        meta: { numeric: true },
        cell: (cell) => {
          const { usedCount, totalLimit } = cell.row.original;
          return (
            <span className="tabular-nums">
              {totalLimit === null ? usedCount : `${String(usedCount)} / ${String(totalLimit)}`}
            </span>
          );
        },
      }),
      column.display({
        id: 'valid',
        header: t('campaigns.codes.col.valid'),
        cell: (cell) => {
          const { validFrom, validTo } = cell.row.original;
          if (validFrom === null && validTo === null) return t('campaigns.codes.always');
          return (
            <span className="tabular-nums">
              {validFrom ?? '…'} – {validTo ?? '…'}
            </span>
          );
        },
      }),
      column.display({
        id: 'channels',
        header: t('campaigns.codes.col.channels'),
        cell: (cell) => {
          const channels = cell.row.original.channels;
          return channels === null || channels.length === 0
            ? t('campaigns.codes.allChannels')
            : channels.map(channel).join(', ');
        },
      }),
      column.accessor('status', {
        header: t('campaigns.codes.col.status'),
        cell: (cell) => (
          <StatusBadge tone={TONE[cell.getValue()]}>
            {t(`campaigns.codes.status.${cell.getValue()}` as CampaignsMessageKey)}
          </StatusBadge>
        ),
      }),
      column.display({
        id: 'actions',
        header: t('campaigns.codes.col.actions'),
        cell: (cell) => {
          const code = cell.row.original;
          if (!canUpdate || code.status === 'archived') return null;
          const busy = changeStatus.isPending && changeStatus.variables.id === code.id;
          return (
            <span className="inline-flex gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  changeStatus.mutate({
                    id: code.id,
                    next: code.status === 'active' ? 'paused' : 'active',
                  })
                }
              >
                {code.status === 'active'
                  ? t('campaigns.codes.pause')
                  : t('campaigns.codes.resume')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => changeStatus.mutate({ id: code.id, next: 'archived' })}
              >
                {t('campaigns.codes.archive')}
              </Button>
            </span>
          );
        },
      }),
    ]);
  }, [t, tOrders, locale, canUpdate, changeStatus]);

  const labels = useCampaignTableLabels(
    t('campaigns.codes.emptyTitle'),
    t('campaigns.codes.emptyDetail'),
  );

  return (
    <div className="space-y-5">
      <CampaignsHeader
        title={t('campaigns.nav.codes')}
        caption={t('campaigns.codes.subtitle')}
        actions={
          ability.can('create', 'LandingPage') ? (
            <Button size="sm" onClick={() => setCreating(true)}>
              <Plus aria-hidden="true" />
              {t('campaigns.codes.new')}
            </Button>
          ) : undefined
        }
      />
      <DataTable
        columns={columns}
        data={codes.data?.items ?? []}
        getRowId={(row) => row.id}
        page={singlePage(codes.data?.items.length ?? 0)}
        onPageChange={() => undefined}
        sort={null}
        onSortChange={() => undefined}
        loading={codes.isPending}
        error={codes.error}
        onRetry={() => void codes.refetch()}
        caption={t('campaigns.nav.codes')}
        labels={labels}
        toolbar={
          <select
            aria-label={t('campaigns.codes.col.status')}
            value={status ?? ''}
            className={`${control} w-auto`}
            onChange={(event) =>
              setStatus((event.target.value || undefined) as PromoStatus | undefined)
            }
          >
            <option value="">{t('campaigns.codes.allStatuses')}</option>
            {PROMO_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`campaigns.codes.status.${value}` as CampaignsMessageKey)}
              </option>
            ))}
          </select>
        }
      />
      {creating ? <NewCodeDialog onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

const EMPTY: PromoFormValues = {
  code: '',
  kind: 'percent',
  percent: '',
  amount: '',
  minOrder: '',
  maxDiscount: '',
  totalLimit: '',
  perCustomerLimit: '',
  validFrom: '',
  validTo: '',
  channels: [],
};

function NewCodeDialog({ onClose }: { readonly onClose: () => void }) {
  const t = useCampaignsT();
  const tOrders = useOrdersT();
  const queryClient = useQueryClient();
  const id = useId();
  const [values, setValues] = useState<PromoFormValues>(EMPTY);
  const [errors, setErrors] = useState<PromoFormErrors>({});
  const [failure, setFailure] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: createPromoCode,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['campaigns', 'codes'] });
      onClose();
    },
    onError: (error) => {
      // The server's own sentence when it sent one (a duplicate code, say).
      setFailure(error instanceof ApiError ? error.message : t('campaigns.codes.form.failed'));
    },
  });

  function set<K extends keyof PromoFormValues>(key: K, value: PromoFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    setFailure(null);
    const checked = checkPromoForm(values);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    create.mutate(checked.body);
  }

  const error = (key: keyof PromoFormValues) => {
    const message = errors[key];
    return message === undefined ? undefined : t(message);
  };
  const input = (key: keyof PromoFormValues, extra: object = {}) => ({
    id: `${id}-${key}`,
    'aria-invalid': errors[key] !== undefined,
    'aria-describedby': errors[key] === undefined ? undefined : `${id}-${key}-error`,
    className: `${control} tabular-nums`,
    ...extra,
  });
  const optional = t('campaigns.optional');

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('campaigns.codes.form.title')}
      closeLabel={t('campaigns.close')}
      className="max-w-xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('campaigns.cancel')}
          </Button>
          <Button onClick={submit} disabled={create.isPending}>
            {t('campaigns.codes.form.create')}
          </Button>
        </>
      }
    >
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <Field
          label={t('campaigns.codes.form.code')}
          id={`${id}-code`}
          hint={t('campaigns.codes.form.codeHint')}
          error={error('code')}
        >
          <input
            {...input('code')}
            className={`${control} font-mono uppercase`}
            autoComplete="off"
            value={values.code}
            onChange={(event) => set('code', event.target.value)}
          />
        </Field>
        <Field label={t('campaigns.codes.form.kind')} id={`${id}-kind`}>
          <select
            id={`${id}-kind`}
            className={control}
            value={values.kind}
            onChange={(event) => set('kind', event.target.value as PromoKind)}
          >
            {PROMO_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`campaigns.codes.kind.${kind}` as CampaignsMessageKey)}
              </option>
            ))}
          </select>
        </Field>

        {values.kind === 'percent' ? (
          <>
            <Field
              label={t('campaigns.codes.form.percent')}
              id={`${id}-percent`}
              error={error('percent')}
            >
              <input
                {...input('percent', { inputMode: 'decimal' })}
                value={values.percent}
                onChange={(event) => set('percent', event.target.value)}
              />
            </Field>
            <Field
              label={t('campaigns.codes.form.maxDiscount')}
              id={`${id}-maxDiscount`}
              hint={optional}
              error={error('maxDiscount')}
            >
              <input
                {...input('maxDiscount', { inputMode: 'decimal' })}
                value={values.maxDiscount}
                onChange={(event) => set('maxDiscount', event.target.value)}
              />
            </Field>
          </>
        ) : null}
        {values.kind === 'flat' ? (
          <Field
            label={t('campaigns.codes.form.amount')}
            id={`${id}-amount`}
            error={error('amount')}
          >
            <input
              {...input('amount', { inputMode: 'decimal' })}
              value={values.amount}
              onChange={(event) => set('amount', event.target.value)}
            />
          </Field>
        ) : null}

        <Field
          label={t('campaigns.codes.form.minOrder')}
          id={`${id}-minOrder`}
          hint={optional}
          error={error('minOrder')}
        >
          <input
            {...input('minOrder', { inputMode: 'decimal' })}
            value={values.minOrder}
            onChange={(event) => set('minOrder', event.target.value)}
          />
        </Field>
        <Field
          label={t('campaigns.codes.form.totalLimit')}
          id={`${id}-totalLimit`}
          hint={optional}
          error={error('totalLimit')}
        >
          <input
            {...input('totalLimit', { inputMode: 'numeric' })}
            value={values.totalLimit}
            onChange={(event) => set('totalLimit', event.target.value)}
          />
        </Field>
        <Field
          label={t('campaigns.codes.form.perCustomer')}
          id={`${id}-perCustomerLimit`}
          hint={optional}
          error={error('perCustomerLimit')}
        >
          <input
            {...input('perCustomerLimit', { inputMode: 'numeric' })}
            value={values.perCustomerLimit}
            onChange={(event) => set('perCustomerLimit', event.target.value)}
          />
        </Field>
        <Field label={t('campaigns.codes.form.validFrom')} id={`${id}-validFrom`} hint={optional}>
          <input
            {...input('validFrom', { type: 'date' })}
            value={values.validFrom}
            onChange={(event) => set('validFrom', event.target.value)}
          />
        </Field>
        <Field
          label={t('campaigns.codes.form.validTo')}
          id={`${id}-validTo`}
          hint={optional}
          error={error('validTo')}
        >
          <input
            {...input('validTo', { type: 'date' })}
            value={values.validTo}
            onChange={(event) => set('validTo', event.target.value)}
          />
        </Field>

        <fieldset className="space-y-1 sm:col-span-2">
          <legend className="text-xs font-medium text-muted-foreground">
            {t('campaigns.codes.form.channels')}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {PROMO_FORM_CHANNELS.map((channel) => (
              <label key={channel} className="inline-flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring"
                  checked={values.channels.includes(channel)}
                  onChange={(event) =>
                    set(
                      'channels',
                      event.target.checked
                        ? [...values.channels, channel]
                        : values.channels.filter((value) => value !== channel),
                    )
                  }
                />
                {tOrders(`orders.channel.${channel}`)}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">{t('campaigns.codes.form.channelsHint')}</p>
        </fieldset>

        {failure === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive sm:col-span-2">
            {failure}
          </p>
        )}
        {/* Enter submits from any field. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}
