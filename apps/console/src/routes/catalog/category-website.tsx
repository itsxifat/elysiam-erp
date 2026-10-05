import type { WebGender } from '@elysium/contracts';
import { Button, Checkbox, Dialog, Select, controlClassName } from '@elysium/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { useT } from '../../i18n/locale.js';
import { listSizeCharts, saveCategoryWebFields } from '../website/api.js';
import { ImagePicker, Preview } from '../website/parts.js';
import type { CatalogCategory } from './api.js';
import '../../i18n/website.js';
import '../../i18n/catalog-pricing.js';

const control = `${controlClassName} w-full disabled:opacity-50`;

/**
 * A category's website fields on Catalog setup (M33, D-501): shown on the website or not,
 * featured on the home page's category grid, its shelf, a description and a picture.
 * Saved under `update Storefront`, so marketing manages how a category looks on the website
 * while its name, code and place in the tree stay org_admin's (`update Catalog`).
 *
 * M39b (D-646): a default size chart, which a new product filed under the category starts with.
 */
export function CategoryWebsiteDialog({
  category,
  onClose,
  onDone,
}: {
  readonly category: CatalogCategory;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const t = useT();
  const id = useId();
  const [visible, setVisible] = useState(category.web.webVisible);
  const [featured, setFeatured] = useState(category.web.featured);
  const [gender, setGender] = useState(category.web.gender ?? '');
  const [description, setDescription] = useState(category.web.description ?? '');
  const [imageFileId, setImageFileId] = useState<string | null>(category.web.imageFileId);
  const [chartId, setChartId] = useState(category.web.defaultSizeChartId ?? '');
  const charts = useQuery({
    queryKey: ['website', 'size-charts'],
    queryFn: listSizeCharts,
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: () =>
      saveCategoryWebFields(category.id, {
        webVisible: visible,
        featured,
        gender: gender === '' ? null : (gender as WebGender),
        description: description.trim() === '' ? null : description.trim(),
        imageFileId,
        defaultSizeChartId: chartId === '' ? null : chartId,
      }),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('web.category.title')}
      description={category.name}
      closeLabel={t('web.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('web.cancel')}
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {t('web.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={visible} onCheckedChange={(next) => setVisible(next === true)} />
          {t('web.category.visible')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={featured} onCheckedChange={(next) => setFeatured(next === true)} />
          {t('web.category.featured')}
        </label>
        <div className="space-y-1.5 text-sm">
          <label htmlFor={`${id}-gender`} className="block font-medium">
            {t('web.card.gender')}
          </label>
          <Select
            id={`${id}-gender`}
            value={gender}
            onValueChange={setGender}
            options={[
              { value: '', label: t('web.card.genderAny') },
              { value: 'men', label: t('web.gender.men') },
              { value: 'women', label: t('web.gender.women') },
              { value: 'kids', label: t('web.gender.kids') },
              { value: 'unisex', label: t('web.gender.unisex') },
            ]}
          />
        </div>
        <div className="space-y-1.5 text-sm">
          <label htmlFor={`${id}-chart`} className="block font-medium">
            {t('cp.new.sizeChart')}
          </label>
          <Select
            id={`${id}-chart`}
            value={chartId}
            onValueChange={setChartId}
            options={[
              { value: '', label: t('web.card.noSizeChart') },
              ...(charts.data?.items ?? []).map((chart) => ({
                value: chart.id,
                label: chart.name,
              })),
            ]}
          />
        </div>
        <div className="space-y-1.5 text-sm">
          <label htmlFor={`${id}-description`} className="block font-medium">
            {t('web.category.description')}
          </label>
          <textarea
            id={`${id}-description`}
            value={description}
            maxLength={2000}
            rows={3}
            className={`${control} h-auto py-2`}
            onChange={(event) => setDescription(event.target.value)}
          />
        </div>
        <div className="space-y-1.5 text-sm">
          <p className="font-medium">{t('web.category.image')}</p>
          <div className="flex flex-wrap items-center gap-3">
            {imageFileId === null ? null : (
              <Preview fileId={imageFileId} alt={category.name} className="h-16 w-16" />
            )}
            <ImagePicker purpose="category-image" onUploaded={setImageFileId} />
            {imageFileId === null ? null : (
              <Button size="sm" variant="ghost" onClick={() => setImageFileId(null)}>
                {t('web.settings.remove')}
              </Button>
            )}
          </div>
        </div>
        {save.error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : t('web.errorDetail')}
          </p>
        )}
      </div>
    </Dialog>
  );
}
