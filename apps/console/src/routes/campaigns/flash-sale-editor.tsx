import type { Locale } from '@elysium/i18n';
import {
  Button,
  FileUpload,
  Money,
  PermissionGate,
  Skeleton,
  StatusBadge,
  type UploadedFile,
  type UploadTicket,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, useNavigate } from '@tanstack/react-router';
import { Copy, Trash2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { ApiError, api } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import { getProduct, listProducts } from '../catalog/api.js';
import {
  createFlashSale,
  duplicateFlashSale,
  getFlashSale,
  setFlashSaleEnabled,
  updateFlashSale,
  type FlashSale,
} from './api.js';
import { CampaignsHeader, campaignsPath, control, Field } from './campaigns-nav.js';
import {
  checkFlashForm,
  EMPTY_FLASH,
  flashValuesOf,
  percentOff,
  type FlashFormErrors,
  type FlashFormField,
  type FlashFormValues,
  type FlashItemValues,
} from './flash-form.js';
import { FLASH_TONE } from './flash-sales.js';
import { useCampaignsT, type CampaignsMessageKey } from './messages.js';

/**
 * One flash sale, new or existing (M35a, D-542): its page on the website, its window and
 * the SKUs on it, each with a sale price and a number of units or all the stock there is.
 *
 * Sold counts come from the server and refresh while the screen is open; the form never
 * sends them. A SKU taken off the sale is switched off rather than deleted, so what it sold
 * stays on record.
 */
const existing = getRouteApi('/campaigns/flash-sales/$saleId');

export function NewFlashSalePage() {
  return (
    <Gate>
      <Editor saleId={null} />
    </Gate>
  );
}

export function FlashSaleEditorPage() {
  const { saleId } = existing.useParams();
  return (
    <Gate>
      <Editor saleId={saleId} />
    </Gate>
  );
}

function Gate({ children }: { readonly children: ReactNode }) {
  const ability = useAbility();
  const t = useCampaignsT();
  return (
    <PermissionGate
      allowed={ability.can('read', 'LandingPage')}
      explain={{
        title: t('campaigns.flash.deniedTitle'),
        detail: t('campaigns.codes.deniedDetail'),
      }}
    >
      {children}
    </PermissionGate>
  );
}

const checkbox = 'size-4 rounded border-border focus-visible:ring-2 focus-visible:ring-ring';

function bannerTicket(input: { contentType: string; sizeBytes: number; originalName: string }) {
  return api.post<UploadTicket>('/v1/files', {
    ...input,
    visibility: 'public',
    purpose: 'campaign-asset',
  });
}

/**
 * Loads the sale, then hands it to the form keyed by its id: the form takes the stored sale
 * once, and a background refresh (for the sold counts) never resets what is being edited.
 */
function Editor({ saleId }: { readonly saleId: string | null }) {
  const t = useCampaignsT();
  const sale = useQuery({
    queryKey: ['campaigns', 'flash-sale', saleId],
    queryFn: () => getFlashSale(saleId ?? ''),
    enabled: saleId !== null,
    // Units sell while the editor is open; the sold column follows them.
    refetchInterval: 15_000,
  });

  if (saleId === null) return <EditorForm saleId={null} initial={EMPTY_FLASH} live={undefined} />;
  if (sale.isPending) {
    return (
      <div className="space-y-3" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }
  if (sale.error !== null) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t('campaigns.errorDetail')}
      </p>
    );
  }
  return (
    <EditorForm
      key={sale.data.id}
      saleId={sale.data.id}
      initial={flashValuesOf(sale.data)}
      live={sale.data}
    />
  );
}

function EditorForm({
  saleId,
  initial,
  live,
}: {
  readonly saleId: string | null;
  readonly initial: FlashFormValues;
  /** The stored sale as last fetched: its status and the sold counts. */
  readonly live: FlashSale | undefined;
}) {
  const t = useCampaignsT();
  const { locale } = useLocale();
  const ability = useAbility();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const id = useId();
  const canEdit = ability.can(saleId === null ? 'create' : 'update', 'LandingPage');

  const [values, setValues] = useState<FlashFormValues>(initial);
  const [errors, setErrors] = useState<FlashFormErrors>({ fields: {}, items: {} });
  const [failure, setFailure] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const sold = new Map((live?.items ?? []).map((item) => [item.skuId, item.unitsSold]));

  const afterSave = async (next: FlashSale) => {
    setSaved(true);
    setValues(flashValuesOf(next));
    queryClient.setQueryData(['campaigns', 'flash-sale', next.id], next);
    await queryClient.invalidateQueries({ queryKey: ['campaigns', 'flash-sales'] });
    if (saleId === null) {
      await navigate({ to: campaignsPath(`/campaigns/flash-sales/${next.id}`) });
    }
  };
  const onError = (error: unknown) =>
    setFailure(error instanceof ApiError ? error.message : t('campaigns.flash.form.failed'));

  const save = useMutation({
    mutationFn: (body: Parameters<typeof createFlashSale>[0]) =>
      saleId === null ? createFlashSale(body) : updateFlashSale(saleId, body),
    onSuccess: afterSave,
    onError,
  });
  const toggle = useMutation({
    mutationFn: (enabled: boolean) => setFlashSaleEnabled(saleId ?? '', enabled),
    onSuccess: afterSave,
    onError,
  });
  const duplicate = useMutation({
    mutationFn: () => duplicateFlashSale(saleId ?? ''),
    onSuccess: async (copy) => {
      await queryClient.invalidateQueries({ queryKey: ['campaigns', 'flash-sales'] });
      await navigate({ to: campaignsPath(`/campaigns/flash-sales/${copy.id}`) });
    },
    onError,
  });

  function set<K extends keyof FlashFormValues>(key: K, value: FlashFormValues[K]) {
    setSaved(false);
    setValues((current) => ({ ...current, [key]: value }));
  }

  function submit() {
    setFailure(null);
    const checked = checkFlashForm(values);
    if (!checked.ok) {
      setErrors(checked.errors);
      return;
    }
    setErrors({ fields: {}, items: {} });
    save.mutate(checked.body);
  }

  const fieldError = (key: FlashFormField) => {
    const message = errors.fields[key];
    return message === undefined ? undefined : t(message);
  };
  const input = (key: FlashFormField, extra: object = {}) => ({
    id: `${id}-${key}`,
    'aria-invalid': errors.fields[key] !== undefined,
    'aria-describedby': errors.fields[key] === undefined ? undefined : `${id}-${key}-error`,
    className: control,
    disabled: !canEdit,
    ...extra,
  });
  const optional = t('campaigns.optional');
  const status = live?.status;

  return (
    <div className="space-y-6">
      <CampaignsHeader
        title={
          saleId === null ? t('campaigns.flash.newTitle') : values.title || t('campaigns.nav.flash')
        }
        caption={t('campaigns.flash.editorSubtitle')}
        actions={
          saleId === null || !canEdit ? undefined : (
            <span className="inline-flex flex-wrap items-center gap-2">
              {status === undefined ? null : (
                <StatusBadge tone={FLASH_TONE[status]}>
                  {t(`campaigns.flash.status.${status}` as CampaignsMessageKey)}
                </StatusBadge>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={toggle.isPending}
                onClick={() => toggle.mutate(!(live?.enabled ?? false))}
              >
                {live?.enabled === true
                  ? t('campaigns.flash.switchOff')
                  : t('campaigns.flash.switchOn')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={duplicate.isPending}
                onClick={() => duplicate.mutate()}
              >
                <Copy aria-hidden="true" />
                {t('campaigns.flash.duplicate')}
              </Button>
            </span>
          )
        }
      />

      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <section aria-labelledby={`${id}-about`} className="space-y-3">
          <h2 id={`${id}-about`} className="text-sm font-semibold">
            {t('campaigns.flash.form.about')}
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label={t('campaigns.flash.form.title')}
              id={`${id}-title`}
              error={fieldError('title')}
            >
              <input
                {...input('title')}
                value={values.title}
                onChange={(event) => set('title', event.target.value)}
              />
            </Field>
            <Field
              label={t('campaigns.flash.form.slug')}
              id={`${id}-slug`}
              hint={t('campaigns.flash.form.slugHint')}
              error={fieldError('slug')}
            >
              <input
                {...input('slug')}
                className={`${control} font-mono`}
                value={values.slug}
                onChange={(event) => set('slug', event.target.value)}
              />
            </Field>
            <Field label={t('campaigns.flash.form.subtitle')} id={`${id}-subtitle`} hint={optional}>
              <input
                {...input('subtitle')}
                value={values.subtitle}
                onChange={(event) => set('subtitle', event.target.value)}
              />
            </Field>
            <Field
              label={t('campaigns.flash.form.priority')}
              id={`${id}-priority`}
              hint={t('campaigns.flash.form.priorityHint')}
              error={fieldError('priority')}
            >
              <input
                {...input('priority', { inputMode: 'numeric' })}
                className={`${control} tabular-nums`}
                value={values.priority}
                onChange={(event) => set('priority', event.target.value)}
              />
            </Field>
            <div className="md:col-span-2">
              <Field
                label={t('campaigns.flash.form.description')}
                id={`${id}-description`}
                hint={optional}
              >
                <textarea
                  {...input('description')}
                  rows={3}
                  className={`${control} h-auto py-2`}
                  value={values.description}
                  onChange={(event) => set('description', event.target.value)}
                />
              </Field>
            </div>
          </div>
        </section>

        <section aria-labelledby={`${id}-when`} className="space-y-3">
          <h2 id={`${id}-when`} className="text-sm font-semibold">
            {t('campaigns.flash.form.when')}
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            <Field
              label={t('campaigns.discounts.form.startsAt')}
              id={`${id}-startsAt`}
              hint={t('campaigns.flash.form.startsHint')}
              error={fieldError('startsAt')}
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
              hint={t('campaigns.flash.form.endsHint')}
              error={fieldError('endsAt')}
            >
              <input
                {...input('endsAt', { type: 'datetime-local' })}
                value={values.endsAt}
                onChange={(event) => set('endsAt', event.target.value)}
              />
            </Field>
          </div>
          <p className="text-xs text-muted-foreground">{t('campaigns.discounts.form.dhakaTime')}</p>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className={checkbox}
                disabled={!canEdit}
                checked={values.enabled}
                onChange={(event) => set('enabled', event.target.checked)}
              />
              {t('campaigns.flash.form.enabled')}
            </label>
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className={checkbox}
                disabled={!canEdit}
                checked={values.showOnHome}
                onChange={(event) => set('showOnHome', event.target.checked)}
              />
              {t('campaigns.flash.form.showOnHome')}
            </label>
          </div>
          {fieldError('enabled') === undefined ? null : (
            <p role="alert" className="text-xs text-destructive">
              {fieldError('enabled')}
            </p>
          )}
        </section>

        <section aria-labelledby={`${id}-banner`} className="space-y-2">
          <h2 id={`${id}-banner`} className="text-sm font-semibold">
            {t('campaigns.flash.form.banner')}
          </h2>
          {values.bannerFileId === null ? (
            <p className="text-xs text-muted-foreground">{t('campaigns.flash.form.noBanner')}</p>
          ) : (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              {t('campaigns.flash.form.bannerSet')}
              {canEdit ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => set('bannerFileId', null)}
                >
                  {t('campaigns.flash.form.removeBanner')}
                </Button>
              ) : null}
            </p>
          )}
          {canEdit ? (
            <FileUpload
              accept="image/webp,image/jpeg,image/png"
              createTicket={bannerTicket}
              finalize={(fileId) => api.post<UploadedFile>(`/v1/files/${fileId}/finalize`)}
              onUploaded={(file) => set('bannerFileId', file.id)}
              onRemoved={() => set('bannerFileId', null)}
              labels={{
                choose: t('campaigns.flash.form.chooseBanner'),
                uploading: t('campaigns.flash.form.uploading'),
                uploaded: t('campaigns.flash.form.uploaded'),
                remove: t('campaigns.flash.form.removeBanner'),
                failed: t('campaigns.flash.form.uploadFailed'),
                tooLarge: t('campaigns.flash.form.tooLarge'),
              }}
            />
          ) : null}
        </section>

        <section aria-labelledby={`${id}-items`} className="space-y-3">
          <h2 id={`${id}-items`} className="text-sm font-semibold">
            {t('campaigns.flash.form.items')}
          </h2>
          {canEdit ? (
            <AddProduct
              taken={new Set(values.items.map((item) => item.skuId))}
              onAdd={(rows) => set('items', [...values.items, ...rows])}
            />
          ) : null}
          {values.items.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('campaigns.flash.form.noItems')}</p>
          ) : (
            <div className="overflow-x-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <caption className="sr-only">{t('campaigns.flash.form.items')}</caption>
                <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
                  <tr>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('campaigns.flash.col.product')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      {t('campaigns.flash.col.price')}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('campaigns.flash.col.salePrice')}
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      {t('campaigns.flash.col.units')}
                    </th>
                    <th scope="col" className="px-3 py-2 text-right font-medium">
                      {t('campaigns.flash.col.sold')}
                    </th>
                    <th scope="col" className="px-3 py-2">
                      <span className="sr-only">{t('campaigns.codes.col.actions')}</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {values.items.map((item, index) => (
                    <ItemRow
                      key={item.skuId}
                      item={item}
                      sold={sold.get(item.skuId) ?? item.unitsSold}
                      error={errors.items[item.skuId]}
                      disabled={!canEdit}
                      locale={locale}
                      onChange={(patch) =>
                        set(
                          'items',
                          values.items.map((row, at) =>
                            at === index ? { ...row, ...patch } : row,
                          ),
                        )
                      }
                      onRemove={() =>
                        set(
                          'items',
                          values.items.filter((_, at) => at !== index),
                        )
                      }
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {failure === null ? null : (
          <p role="alert" className="text-sm font-medium text-destructive">
            {failure}
          </p>
        )}
        {saved && failure === null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('campaigns.flash.form.saved')}
          </p>
        ) : null}
        {canEdit ? (
          <div className="flex gap-2">
            <Button type="submit" disabled={save.isPending}>
              {saleId === null ? t('campaigns.flash.form.create') : t('campaigns.save')}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => void navigate({ to: campaignsPath('/campaigns/flash-sales') })}
            >
              {t('campaigns.cancel')}
            </Button>
          </div>
        ) : null}
      </form>
    </div>
  );
}

function ItemRow({
  item,
  sold,
  error,
  disabled,
  locale,
  onChange,
  onRemove,
}: {
  readonly item: FlashItemValues;
  readonly sold: number;
  readonly error: CampaignsMessageKey | undefined;
  readonly disabled: boolean;
  readonly locale: Locale;
  readonly onChange: (patch: Partial<FlashItemValues>) => void;
  readonly onRemove: () => void;
}) {
  const t = useCampaignsT();
  const id = useId();
  const off = percentOff(item.shelfPricePoisha, item.salePrice);
  const name = `${item.productName}${item.variantLabel === null ? '' : ` · ${item.variantLabel}`}`;
  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <span className="block font-medium">{name}</span>
        <span className="font-mono text-xs text-muted-foreground">{item.skuCode}</span>
        {error === undefined ? null : (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {t(error)}
          </p>
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        <Money poisha={item.shelfPricePoisha} locale={locale} />
      </td>
      <td className="px-3 py-2">
        <label htmlFor={`${id}-price`} className="sr-only">
          {`${t('campaigns.flash.col.salePrice')} ${name}`}
        </label>
        <input
          id={`${id}-price`}
          className={`${control} w-28 tabular-nums`}
          inputMode="decimal"
          aria-invalid={error !== undefined}
          disabled={disabled}
          value={item.salePrice}
          onChange={(event) => onChange({ salePrice: event.target.value })}
        />
        {off === null ? null : (
          <span className="mt-1 block text-xs text-muted-foreground tabular-nums">
            {off}% {t('campaigns.codes.off')}
          </span>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={`${id}-limit`} className="sr-only">
            {`${t('campaigns.flash.col.units')} ${name}`}
          </label>
          <input
            id={`${id}-limit`}
            className={`${control} w-24 tabular-nums`}
            inputMode="numeric"
            disabled={disabled || item.allStock}
            value={item.allStock ? '' : item.limit}
            onChange={(event) => onChange({ limit: event.target.value })}
          />
          <label className="inline-flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              className={checkbox}
              disabled={disabled}
              checked={item.allStock}
              onChange={(event) => onChange({ allStock: event.target.checked })}
            />
            {t('campaigns.flash.allStock')}
          </label>
        </div>
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{sold}</td>
      <td className="px-3 py-2 text-right">
        {disabled ? null : (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`${t('campaigns.discounts.form.remove')} ${name}`}
            onClick={onRemove}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        )}
      </td>
    </tr>
  );
}

/** Search a product by name and put every one of its sellable SKUs on the sale. */
function AddProduct({
  taken,
  onAdd,
}: {
  readonly taken: ReadonlySet<string>;
  readonly onAdd: (rows: readonly FlashItemValues[]) => void;
}) {
  const t = useCampaignsT();
  const id = useId();
  const [search, setSearch] = useState('');
  const found = useQuery({
    queryKey: ['campaigns', 'product-search', search],
    queryFn: () => listProducts({ q: search, limit: 20 }),
    enabled: search.trim().length >= 3,
  });
  const add = useMutation({
    mutationFn: (productId: string) => getProduct(productId),
    onSuccess: (product) => {
      onAdd(
        product.skus
          .filter((sku) => sku.status === 'active' && !taken.has(sku.id))
          .map((sku) => ({
            skuId: sku.id,
            skuCode: sku.skuCode,
            productName: product.name,
            variantLabel:
              sku.attributes.length === 0
                ? null
                : sku.attributes.map((value) => value.valueLabel).join(' / '),
            shelfPricePoisha: sku.pricePoisha,
            salePrice: '',
            allStock: false,
            limit: '',
            unitsSold: 0,
          })),
      );
      setSearch('');
    },
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
      {found.data === undefined || search.trim().length < 3 ? null : (
        <ul className="max-h-48 divide-y divide-border overflow-y-auto rounded-md border border-border">
          {found.data.items.map((product) => (
            <li
              key={product.id}
              className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
            >
              <span>
                {product.name}{' '}
                <span className="text-xs text-muted-foreground tabular-nums">
                  ({product.skuCount})
                </span>
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={add.isPending}
                onClick={() => add.mutate(product.id)}
              >
                {t('campaigns.flash.form.addProduct')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
