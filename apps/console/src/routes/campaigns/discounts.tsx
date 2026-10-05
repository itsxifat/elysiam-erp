import {
  Button,
  DataTable,
  Dialog,
  Money,
  PermissionGate,
  Select,
  StatusBadge,
  dataTableColumns,
  type DataTableColumn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale, useT } from '../../i18n/locale.js';
import { listCategories, listProducts } from '../catalog/api.js';
import { isOrdersKey, useOrdersT } from '../orders/messages.js';
import {
  createPromoCode,
  listPromoCodes,
  PROMO_FORM_CHANNELS,
  PROMO_KINDS,
  PROMO_METHODS,
  PROMO_STATUSES,
  setPromoStatus,
  type PromoCode,
  type PromoKind,
  type PromoMethod,
  type PromoStatus,
} from './api.js';
import {
  CampaignsHeader,
  control,
  Field,
  singlePage,
  useCampaignTableLabels,
} from './campaigns-nav.js';
import { dhakaText } from './dhaka-time.js';
import {
  checkDiscountForm,
  EMPTY_DISCOUNT,
  offerParts,
  type DiscountFormErrors,
  type DiscountFormField,
  type DiscountFormValues,
  type TierValues,
  tierField,
} from './discount-form.js';
import { useCampaignsT, type CampaignsMessageKey } from './messages.js';
import {
  archiveDiscount,
  deleteDiscount,
  discountUsage,
  restoreDiscount,
} from '../../api/manage.js';
import '../../i18n/manage.js';
import { DeleteOrArchive } from '../../ui/delete-or-archive.js';

/**
 * Discounts (M16's promo codes, extended in M35a; D-203, D-204, D-541).
 *
 * One list for the codes buyers type and the automatic discounts the website applies by
 * itself. `read LandingPage` to see them, `create` and `update` to make and change them. A
 * discount's terms cannot be edited once it exists: a buyer who was told "10% off" was told
 * it about that discount, so a different offer is a different discount. Occasion codes the
 * CRM issued are listed too, marked personal.
 */
export function DiscountsPage() {
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
      <Discounts />
    </PermissionGate>
  );
}

const TONE: Record<PromoStatus, 'success' | 'warning' | 'neutral'> = {
  active: 'success',
  paused: 'warning',
  archived: 'neutral',
};

function Discounts() {
  const t = useCampaignsT();
  const tOrders = useOrdersT();
  const { locale } = useLocale();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<PromoStatus | undefined>(undefined);
  const [method, setMethod] = useState<PromoMethod | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  // M39a (D-631): the discount whose Delete-or-archive dialog is open.
  const [managing, setManaging] = useState<PromoCode | null>(null);
  const tm = useT();

  const codes = useQuery({
    queryKey: ['campaigns', 'codes', status, method],
    queryFn: () => listPromoCodes(status, method),
  });

  const changeStatus = useMutation({
    mutationFn: ({ id, next }: { id: string; next: PromoStatus }) => setPromoStatus(id, next),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['campaigns', 'codes'] });
    },
  });

  const canUpdate = ability.can('update', 'LandingPage');
  const canDelete = ability.can('delete', 'LandingPage');

  const columns = useMemo<readonly DataTableColumn<PromoCode>[]>(() => {
    const column = dataTableColumns<PromoCode>();
    const channel = (value: string) => {
      const key = `orders.channel.${value}`;
      return isOrdersKey(key) ? tOrders(key) : value;
    };
    return column.columns([
      column.display({
        id: 'name',
        header: t('campaigns.discounts.col.discount'),
        cell: (cell) => {
          const row = cell.row.original;
          return (
            <span className="inline-flex flex-wrap items-center gap-2">
              {row.code === null ? (
                <span className="text-sm font-medium">{row.title}</span>
              ) : (
                <span className="font-mono text-sm font-medium">{row.code}</span>
              )}
              {row.method === 'automatic' ? (
                <StatusBadge tone="info">{t('campaigns.discounts.method.automatic')}</StatusBadge>
              ) : null}
              {row.customerId === null ? null : (
                <StatusBadge tone="info">
                  {row.origin === 'occasion'
                    ? t('campaigns.codes.origin.occasion')
                    : t('campaigns.codes.personal')}
                </StatusBadge>
              )}
              {row.allowStacking ? (
                <StatusBadge tone="neutral">{t('campaigns.discounts.stacks')}</StatusBadge>
              ) : null}
            </span>
          );
        },
      }),
      column.display({
        id: 'offer',
        header: t('campaigns.codes.col.offer'),
        cell: (cell) => <OfferText code={cell.row.original} />,
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
          const { validFrom, validTo, startsAt, endsAt } = cell.row.original;
          if (startsAt !== null || endsAt !== null) {
            return (
              <span className="tabular-nums">
                {startsAt === null ? '…' : dhakaText(startsAt, locale)} –{' '}
                {endsAt === null ? '…' : dhakaText(endsAt, locale)}
              </span>
            );
          }
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
          if (!canUpdate) return null;
          const busy = changeStatus.isPending && changeStatus.variables.id === code.id;
          // Archived: Restore (it comes back paused) and, when nobody used it, Delete (D-631).
          if (code.status === 'archived') {
            return (
              <span className="inline-flex gap-1">
                <Button size="sm" variant="outline" onClick={() => setManaging(code)}>
                  {tm('mg.restore')}
                </Button>
              </span>
            );
          }
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
                aria-label={`${t('campaigns.codes.archive')}: ${code.code ?? code.title}`}
                onClick={() => setManaging(code)}
              >
                <Trash2 aria-hidden="true" />
                {t('campaigns.codes.archive')}
              </Button>
            </span>
          );
        },
      }),
    ]);
  }, [t, tm, tOrders, locale, canUpdate, changeStatus]);

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
          <div className="flex flex-wrap gap-2">
            <Select
              variant="filter"
              aria-label={t('campaigns.discounts.form.method')}
              value={method ?? ''}
              onValueChange={(value) => setMethod((value || undefined) as PromoMethod | undefined)}
              options={[
                { value: '', label: t('campaigns.discounts.allMethods') },
                ...PROMO_METHODS.map((value) => ({
                  value,
                  label: t(`campaigns.discounts.method.${value}` as CampaignsMessageKey),
                })),
              ]}
            />
            <Select
              variant="filter"
              aria-label={t('campaigns.codes.col.status')}
              value={status ?? ''}
              onValueChange={(value) => setStatus((value || undefined) as PromoStatus | undefined)}
              options={[
                { value: '', label: t('campaigns.codes.allStatuses') },
                ...PROMO_STATUSES.map((value) => ({
                  value,
                  label: t(`campaigns.codes.status.${value}` as CampaignsMessageKey),
                })),
              ]}
            />
          </div>
        }
      />
      {creating ? <NewDiscountDialog onClose={() => setCreating(false)} /> : null}
      {managing === null ? null : (
        <DeleteOrArchive
          key={managing.id}
          open
          onClose={() => setManaging(null)}
          queryKey={['campaigns', 'codes', managing.id]}
          loadUsage={() => discountUsage(managing.id)}
          onDelete={canDelete ? () => deleteDiscount(managing.id) : undefined}
          onArchive={() => archiveDiscount(managing.id)}
          archiveNote={tm('mg.archive.discount')}
          onRestore={() => restoreDiscount(managing.id)}
          onDone={() => void queryClient.invalidateQueries({ queryKey: ['campaigns', 'codes'] })}
        />
      )}
    </div>
  );
}

function OfferText({ code }: { readonly code: PromoCode }) {
  const t = useCampaignsT();
  const { locale } = useLocale();
  const offer = offerParts(code);
  if ('freeDelivery' in offer) return <>{t('campaigns.codes.kind.free_delivery')}</>;
  if ('tiers' in offer) {
    return (
      <span className="tabular-nums">
        {t('campaigns.discounts.kind.tiered')} · {offer.tiers}
      </span>
    );
  }
  if ('buy' in offer) {
    return (
      <span className="tabular-nums">
        {t('campaigns.discounts.offer.buy')} {offer.buy} · {t('campaigns.discounts.offer.get')}{' '}
        {offer.get} ({offer.getPercent} {t('campaigns.codes.off')})
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      {'percent' in offer ? offer.percent : <Money poisha={offer.poisha} locale={locale} />}{' '}
      {t('campaigns.codes.off')}
    </span>
  );
}

const checkbox = 'size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring';

/** Indentation by category depth, as whole classes so Tailwind sees each one. */
const DEPTH = ['ps-0', 'ps-5', 'ps-10', 'ps-16', 'ps-20'] as const;

function NewDiscountDialog({ onClose }: { readonly onClose: () => void }) {
  const t = useCampaignsT();
  const tOrders = useOrdersT();
  const queryClient = useQueryClient();
  const id = useId();
  const [values, setValues] = useState<DiscountFormValues>(EMPTY_DISCOUNT);
  const [errors, setErrors] = useState<DiscountFormErrors>({});
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

  function set<K extends keyof DiscountFormValues>(key: K, value: DiscountFormValues[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    setFailure(null);
    const checked = checkDiscountForm(values);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({});
    create.mutate(checked.body);
  }

  const error = (key: DiscountFormField) => {
    const message = errors[key];
    return message === undefined ? undefined : t(message);
  };
  const input = (key: DiscountFormField, extra: object = {}) => ({
    id: `${id}-${key}`,
    'aria-invalid': errors[key] !== undefined,
    'aria-describedby': errors[key] === undefined ? undefined : `${id}-${key}-error`,
    className: `${control} tabular-nums`,
    ...extra,
  });
  const optional = t('campaigns.optional');
  const isCode = values.method === 'code';
  const rate =
    values.kind === 'percent' || values.kind === 'buy_x_get_y' || values.kind === 'tiered';

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t('campaigns.codes.form.title')}
      closeLabel={t('campaigns.close')}
      className="max-h-[90vh] max-w-2xl overflow-y-auto"
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
        className="space-y-5"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">{t('campaigns.discounts.form.basics')}</legend>
          <div
            role="radiogroup"
            aria-label={t('campaigns.discounts.form.method')}
            className="flex flex-wrap gap-4"
          >
            {PROMO_METHODS.map((value) => (
              <label key={value} className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-method`}
                  className={checkbox}
                  checked={values.method === value}
                  onChange={() => set('method', value)}
                />
                {t(`campaigns.discounts.method.${value}` as CampaignsMessageKey)}
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {isCode
              ? t('campaigns.discounts.form.methodCodeHint')
              : t('campaigns.discounts.form.methodAutomaticHint')}
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            {isCode ? (
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
            ) : null}
            <Field
              label={t('campaigns.discounts.form.title')}
              id={`${id}-title`}
              hint={isCode ? optional : t('campaigns.discounts.form.titleHint')}
              error={error('title')}
            >
              <input
                {...input('title')}
                value={values.title}
                onChange={(event) => set('title', event.target.value)}
              />
            </Field>
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">{t('campaigns.codes.form.kind')}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('campaigns.discounts.form.kind')} id={`${id}-kind`}>
              <Select
                id={`${id}-kind`}
                value={values.kind}
                onValueChange={(value) => set('kind', value as PromoKind)}
                options={PROMO_KINDS.map((kind) => ({
                  value: kind,
                  label: t(`campaigns.discounts.kind.${kind}` as CampaignsMessageKey),
                }))}
              />
            </Field>
            {values.kind === 'percent' ? (
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
            {values.kind === 'buy_x_get_y' ? (
              <>
                <Field
                  label={t('campaigns.discounts.form.buyQuantity')}
                  id={`${id}-buyQuantity`}
                  error={error('buyQuantity')}
                >
                  <input
                    {...input('buyQuantity', { inputMode: 'numeric' })}
                    value={values.buyQuantity}
                    onChange={(event) => set('buyQuantity', event.target.value)}
                  />
                </Field>
                <Field
                  label={t('campaigns.discounts.form.getQuantity')}
                  id={`${id}-getQuantity`}
                  error={error('getQuantity')}
                >
                  <input
                    {...input('getQuantity', { inputMode: 'numeric' })}
                    value={values.getQuantity}
                    onChange={(event) => set('getQuantity', event.target.value)}
                  />
                </Field>
                <Field
                  label={t('campaigns.discounts.form.getPercent')}
                  id={`${id}-getPercent`}
                  hint={t('campaigns.discounts.form.getPercentHint')}
                  error={error('getPercent')}
                >
                  <input
                    {...input('getPercent', { inputMode: 'decimal' })}
                    value={values.getPercent}
                    onChange={(event) => set('getPercent', event.target.value)}
                  />
                </Field>
              </>
            ) : null}
            {rate ? (
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
            ) : null}
          </div>
          {values.kind === 'tiered' ? (
            <Tiers tiers={values.tiers} errors={errors} onChange={(tiers) => set('tiers', tiers)} />
          ) : null}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">{t('campaigns.discounts.form.scope')}</legend>
          <div
            role="radiogroup"
            aria-label={t('campaigns.discounts.form.scope')}
            className="flex flex-wrap gap-4"
          >
            {(['all', 'products', 'categories'] as const).map((value) => (
              <label key={value} className="inline-flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name={`${id}-scope`}
                  className={checkbox}
                  checked={values.scope === value}
                  onChange={() => set('scope', value)}
                />
                {t(`campaigns.discounts.scope.${value}` as CampaignsMessageKey)}
              </label>
            ))}
          </div>
          {values.scope === 'products' ? (
            <ProductPicker
              selected={values.productIds}
              onChange={(productIds) => set('productIds', productIds)}
            />
          ) : null}
          {values.scope === 'categories' ? (
            <CategoryPicker
              selected={values.categoryIds}
              onChange={(categoryIds) => set('categoryIds', categoryIds)}
            />
          ) : null}
          {errors.scope === undefined ? null : (
            <p role="alert" className="text-xs text-destructive">
              {t(errors.scope)}
            </p>
          )}
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">
            {t('campaigns.discounts.form.conditions')}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
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
              label={t('campaigns.discounts.form.minQuantity')}
              id={`${id}-minQuantity`}
              hint={optional}
              error={error('minQuantity')}
            >
              <input
                {...input('minQuantity', { inputMode: 'numeric' })}
                value={values.minQuantity}
                onChange={(event) => set('minQuantity', event.target.value)}
              />
            </Field>
          </div>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className={checkbox}
              checked={values.firstOrderOnly}
              onChange={(event) => set('firstOrderOnly', event.target.checked)}
            />
            {t('campaigns.discounts.form.firstOrderOnly')}
          </label>
          <fieldset className="space-y-1">
            <legend className="text-xs font-medium text-muted-foreground">
              {t('campaigns.codes.form.channels')}
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {PROMO_FORM_CHANNELS.map((channel) => (
                <label key={channel} className="inline-flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    className={checkbox}
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
            <p className="text-xs text-muted-foreground">
              {t('campaigns.codes.form.channelsHint')}
            </p>
          </fieldset>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">
            {t('campaigns.discounts.form.schedule')}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('campaigns.discounts.form.startsAt')}
              id={`${id}-startsAt`}
              hint={optional}
              error={error('startsAt')}
            >
              <input
                {...input('startsAt', { type: 'datetime-local' })}
                value={values.startsAt}
                onChange={(event) => set('startsAt', event.target.value)}
              />
            </Field>
            <Field
              label={t('campaigns.discounts.form.endsAt')}
              id={`${id}-endsAt`}
              hint={optional}
              error={error('endsAt')}
            >
              <input
                {...input('endsAt', { type: 'datetime-local' })}
                value={values.endsAt}
                onChange={(event) => set('endsAt', event.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('campaigns.discounts.form.dhakaTime')}</p>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">{t('campaigns.discounts.form.limits')}</legend>
          <div className="grid gap-3 sm:grid-cols-2">
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
          </div>
        </fieldset>

        <fieldset className="space-y-3">
          <legend className="text-sm font-semibold">
            {t('campaigns.discounts.form.combining')}
          </legend>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className={checkbox}
              checked={values.allowStacking}
              onChange={(event) => set('allowStacking', event.target.checked)}
            />
            {t('campaigns.discounts.form.allowStacking')}
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label={t('campaigns.discounts.form.priority')}
              id={`${id}-priority`}
              hint={t('campaigns.discounts.form.priorityHint')}
              error={error('priority')}
            >
              <input
                {...input('priority', { inputMode: 'numeric' })}
                value={values.priority}
                onChange={(event) => set('priority', event.target.value)}
              />
            </Field>
          </div>
        </fieldset>

        {failure === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {failure}
          </p>
        )}
        {/* Enter submits from any field. */}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Dialog>
  );
}

function Tiers({
  tiers,
  errors,
  onChange,
}: {
  readonly tiers: readonly TierValues[];
  readonly errors: DiscountFormErrors;
  readonly onChange: (tiers: readonly TierValues[]) => void;
}) {
  const t = useCampaignsT();
  const id = useId();
  const update = (index: number, patch: Partial<TierValues>) =>
    onChange(tiers.map((tier, at) => (at === index ? { ...tier, ...patch } : tier)));

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">{t('campaigns.discounts.form.tiersHint')}</p>
      {tiers.map((tier, index) => {
        const key = tierField(index);
        const message = errors[key];
        return (
          <div key={index} className="grid items-end gap-2 sm:grid-cols-[1fr_9rem_1fr_auto]">
            <Field label={t('campaigns.discounts.form.tierFrom')} id={`${id}-${key}-min`}>
              <input
                id={`${id}-${key}-min`}
                className={`${control} tabular-nums`}
                inputMode="decimal"
                aria-invalid={message !== undefined}
                value={tier.minSubtotal}
                onChange={(event) => update(index, { minSubtotal: event.target.value })}
              />
            </Field>
            <Field label={t('campaigns.discounts.form.tierKind')} id={`${id}-${key}-kind`}>
              <Select
                id={`${id}-${key}-kind`}
                value={tier.kind}
                onValueChange={(value) => update(index, { kind: value as TierValues['kind'] })}
                options={[
                  { value: 'percent', label: t('campaigns.codes.kind.percent') },
                  { value: 'flat', label: t('campaigns.codes.kind.flat') },
                ]}
              />
            </Field>
            <Field
              label={
                tier.kind === 'percent'
                  ? t('campaigns.codes.form.percent')
                  : t('campaigns.codes.form.amount')
              }
              id={`${id}-${key}-value`}
            >
              <input
                id={`${id}-${key}-value`}
                className={`${control} tabular-nums`}
                inputMode="decimal"
                aria-invalid={message !== undefined}
                value={tier.value}
                onChange={(event) => update(index, { value: event.target.value })}
              />
            </Field>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label={t('campaigns.discounts.form.removeTier')}
              disabled={tiers.length === 1}
              onClick={() => onChange(tiers.filter((_, at) => at !== index))}
            >
              <Trash2 aria-hidden="true" />
            </Button>
            {message === undefined ? null : (
              <p role="alert" className="text-xs text-destructive sm:col-span-4">
                {t(message)}
              </p>
            )}
          </div>
        );
      })}
      {tiers.length < 10 ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange([...tiers, { minSubtotal: '', kind: 'percent', value: '' }])}
        >
          <Plus aria-hidden="true" />
          {t('campaigns.discounts.form.addTier')}
        </Button>
      ) : null}
    </div>
  );
}

/** Products searched by name, three letters or more, and the ones picked. */
function ProductPicker({
  selected,
  onChange,
}: {
  readonly selected: readonly string[];
  readonly onChange: (ids: readonly string[]) => void;
}) {
  const t = useCampaignsT();
  const id = useId();
  const [search, setSearch] = useState('');
  const [names, setNames] = useState<ReadonlyMap<string, string>>(new Map());
  const found = useQuery({
    queryKey: ['campaigns', 'product-search', search],
    queryFn: () => listProducts({ q: search, limit: 20 }),
    enabled: search.trim().length >= 3,
  });

  return (
    <div className="space-y-2">
      <Field
        label={t('campaigns.discounts.form.findProduct')}
        id={`${id}-search`}
        hint={t('campaigns.discounts.form.findHint')}
      >
        <input
          id={`${id}-search`}
          className={control}
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </Field>
      {selected.length === 0 ? null : (
        <ul className="flex flex-wrap gap-2" aria-label={t('campaigns.discounts.form.picked')}>
          {selected.map((productId) => (
            <li
              key={productId}
              className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-0.5 text-sm"
            >
              {names.get(productId) ?? productId}
              <button
                type="button"
                className="rounded p-0.5 focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`${t('campaigns.discounts.form.remove')} ${names.get(productId) ?? ''}`}
                onClick={() => onChange(selected.filter((value) => value !== productId))}
              >
                <X aria-hidden="true" className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {found.data === undefined ? null : (
        <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {found.data.items.map((product) => (
            <li
              key={product.id}
              className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
            >
              <span>{product.name}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={selected.includes(product.id)}
                onClick={() => {
                  setNames((current) => new Map(current).set(product.id, product.name));
                  onChange([...selected, product.id]);
                }}
              >
                {t('campaigns.discounts.form.add')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Every category, indented by depth. A category covers the ones below it (D-541). */
function CategoryPicker({
  selected,
  onChange,
}: {
  readonly selected: readonly string[];
  readonly onChange: (ids: readonly string[]) => void;
}) {
  const t = useCampaignsT();
  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: () => listCategories(),
  });
  const ordered = [...(categories.data?.items ?? [])].sort((a, b) => a.path.localeCompare(b.path));

  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-medium text-muted-foreground">
        {t('campaigns.discounts.form.categoriesHint')}
      </legend>
      <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
        {ordered.map((category) => (
          <label
            key={category.id}
            className={`flex items-center gap-2 text-sm ${DEPTH[Math.min(category.depth, DEPTH.length - 1)] ?? 'ps-0'}`}
          >
            <input
              type="checkbox"
              className={checkbox}
              checked={selected.includes(category.id)}
              onChange={(event) =>
                onChange(
                  event.target.checked
                    ? [...selected, category.id]
                    : selected.filter((value) => value !== category.id),
                )
              }
            />
            {category.name}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
