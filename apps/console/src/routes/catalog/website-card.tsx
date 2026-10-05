import type { WebGender } from '@elysium/contracts';
import { Button, Checkbox, Select, StatusBadge, controlClassName } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { getSettings, listSizeCharts, saveProductWebFields } from '../website/api.js';
import { NamedSection } from '../website/parts.js';
import type { CatalogProduct } from './api.js';
import '../../i18n/website.js';

/**
 * The product page's Website card (M33, D-500): whether the product is on the website and
 * how it shows there — featured, new arrival, its shelf, tags, size chart, the words a
 * search engine shows, material and care — and a link to it on the website.
 *
 * Read by everyone who reads the website (`read Storefront`); saved by those who manage it
 * (`update Storefront`: org_admin and marketing), which is not the same as editing the
 * product itself (`update Catalog`, org_admin alone). The old addresses are listed so
 * somebody renaming a product can see the links that still lead to it.
 */
export function WebsiteCard({
  product,
  onDone,
}: {
  readonly product: CatalogProduct;
  readonly onDone: () => void;
}) {
  const t = useT();
  const id = useId();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const mayUpdate = ability.can('update', 'Storefront');
  const web = product.web;

  const charts = useQuery({
    queryKey: ['website', 'size-charts'],
    queryFn: listSizeCharts,
    staleTime: 60_000,
  });
  const settings = useQuery({
    queryKey: ['website', 'settings'],
    queryFn: getSettings,
    staleTime: 60_000,
  });

  const [visible, setVisible] = useState(web.webVisible);
  const [featured, setFeatured] = useState(web.featured);
  const [newArrival, setNewArrival] = useState(web.newArrival);
  const [gender, setGender] = useState<string>(web.gender ?? '');
  const [tags, setTags] = useState(web.tags.join(', '));
  const [sizeChartId, setSizeChartId] = useState(web.sizeChartId ?? '');
  const [seoTitle, setSeoTitle] = useState(web.seoTitle ?? '');
  const [seoDescription, setSeoDescription] = useState(web.seoDescription ?? '');
  const [material, setMaterial] = useState(web.material ?? '');
  const [care, setCare] = useState(web.careInstructions ?? '');
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: () =>
      saveProductWebFields(product.id, {
        webVisible: visible,
        featured,
        newArrival,
        gender: gender === '' ? null : (gender as WebGender),
        tags: tags
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ''),
        sizeChartId: sizeChartId === '' ? null : sizeChartId,
        seoTitle: seoTitle.trim() === '' ? null : seoTitle.trim(),
        seoDescription: seoDescription.trim() === '' ? null : seoDescription.trim(),
        material: material.trim() === '' ? null : material.trim(),
        careInstructions: care.trim() === '' ? null : care.trim(),
      }),
    onMutate: () => setSaved(false),
    onSuccess: async () => {
      setSaved(true);
      await queryClient.invalidateQueries({ queryKey: ['catalog', 'product', product.id] });
      onDone();
    },
  });

  const siteUrl = settings.data?.siteInfo.siteUrl ?? '';
  const viewHref =
    siteUrl === '' || product.status !== 'active' || !web.webVisible
      ? null
      : `${siteUrl.replace(/\/+$/, '')}/shop/${product.slug}`;

  return (
    <NamedSection
      title={t('web.card.title')}
      description={t('web.card.help')}
      actions={
        <div className="flex items-center gap-3">
          <StatusBadge tone={web.webVisible ? 'success' : 'neutral'}>
            {web.webVisible ? t('web.on') : t('web.off')}
          </StatusBadge>
          {viewHref === null ? null : (
            <a
              href={viewHref}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1 rounded-sm text-sm text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {t('web.card.view')}
              <ExternalLink aria-hidden className="size-3.5" />
            </a>
          )}
        </div>
      }
    >
      <fieldset disabled={!mayUpdate} className="space-y-4">
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Tick label={t('web.card.visible')} checked={visible} onChange={setVisible} />
          <Tick label={t('web.card.featured')} checked={featured} onChange={setFeatured} />
          <Tick label={t('web.card.newArrival')} checked={newArrival} onChange={setNewArrival} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Labelled id={`${id}-gender`} label={t('web.card.gender')}>
            <Select
              id={`${id}-gender`}
              value={gender}
              onValueChange={setGender}
              disabled={!mayUpdate}
              options={[
                { value: '', label: t('web.card.genderAny') },
                { value: 'men', label: t('web.gender.men') },
                { value: 'women', label: t('web.gender.women') },
                { value: 'kids', label: t('web.gender.kids') },
                { value: 'unisex', label: t('web.gender.unisex') },
              ]}
            />
          </Labelled>
          <Labelled id={`${id}-chart`} label={t('web.card.sizeChart')}>
            <Select
              id={`${id}-chart`}
              value={sizeChartId}
              onValueChange={setSizeChartId}
              disabled={!mayUpdate}
              options={[
                { value: '', label: t('web.card.noSizeChart') },
                ...(charts.data?.items ?? []).map((chart) => ({
                  value: chart.id,
                  label: chart.name,
                })),
              ]}
            />
          </Labelled>
        </div>
        <Labelled id={`${id}-tags`} label={t('web.card.tags')} hint={t('web.card.tagsHelp')}>
          <input
            id={`${id}-tags`}
            value={tags}
            maxLength={1200}
            className={control}
            onChange={(event) => setTags(event.target.value)}
          />
        </Labelled>
        <div className="grid gap-4 sm:grid-cols-2">
          <Labelled id={`${id}-material`} label={t('web.card.material')}>
            <input
              id={`${id}-material`}
              value={material}
              maxLength={200}
              className={control}
              onChange={(event) => setMaterial(event.target.value)}
            />
          </Labelled>
          <Labelled id={`${id}-seo-title`} label={t('web.card.seoTitle')}>
            <input
              id={`${id}-seo-title`}
              value={seoTitle}
              maxLength={120}
              className={control}
              onChange={(event) => setSeoTitle(event.target.value)}
            />
          </Labelled>
        </div>
        <Labelled id={`${id}-seo-description`} label={t('web.card.seoDescription')}>
          <textarea
            id={`${id}-seo-description`}
            value={seoDescription}
            maxLength={320}
            rows={2}
            className={`${control} h-auto py-2`}
            onChange={(event) => setSeoDescription(event.target.value)}
          />
        </Labelled>
        <Labelled id={`${id}-care`} label={t('web.card.care')}>
          <textarea
            id={`${id}-care`}
            value={care}
            maxLength={2000}
            rows={3}
            className={`${control} h-auto py-2`}
            onChange={(event) => setCare(event.target.value)}
          />
        </Labelled>
        {web.previousSlugs.length === 0 ? null : (
          <div className="space-y-1 text-sm">
            <p className="font-medium">{t('web.card.oldAddresses')}</p>
            <p className="font-mono text-xs text-muted-foreground">
              {web.previousSlugs.join(', ')}
            </p>
          </div>
        )}
        {mayUpdate ? (
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
              {t('web.save')}
            </Button>
            {saved ? (
              <span role="status" className="text-xs text-muted-foreground">
                {t('web.saved')}
              </span>
            ) : null}
          </div>
        ) : null}
        {save.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : t('web.errorDetail')}
          </p>
        )}
      </fieldset>
    </NamedSection>
  );
}

const control = `${controlClassName} w-full disabled:opacity-50`;

function Tick({
  label,
  checked,
  onChange,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <Checkbox checked={checked} onCheckedChange={(next) => onChange(next === true)} />
      {label}
    </label>
  );
}

function Labelled({
  id,
  label,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5 text-sm">
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
