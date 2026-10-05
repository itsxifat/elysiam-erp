import type { CampaignLinkInput } from '@elysium/contracts';
import { Button, Checkbox, ConfirmDialog, Dialog, Select, StatusBadge } from '@elysium/ui';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/web-marketing.js';
import { CopyButton } from '../../ui/copy-button.js';
import { getProduct, listProducts } from '../catalog/api.js';
import { listNav } from './api.js';
import {
  createCampaignLink,
  deleteCampaignLink,
  listCampaignLinks,
  updateCampaignLink,
  type CampaignLink,
} from './marketing-api.js';
import { useWebsiteT } from './messages.js';
import {
  control,
  Empty,
  Field,
  ImagePicker,
  Loadable,
  NamedSection,
  Preview,
  Problem,
  WebsitePage,
} from './parts.js';

/**
 * Website → Campaign links (M35b, D-551): the old site's custom URLs.
 *
 * A link is a five-digit code on a page of the brand's site (the shop, a category or any path):
 * `/shop?category=panjabi&cu=48213`. The website reads the code and shows the link's
 * highlighted products first, its banner and its pop-up; each visit is counted. Marketing puts
 * the address in an ad or a post, and the views say which one brought people.
 */
export function WebsiteCampaignLinksPage() {
  const t = useT();
  const w = useWebsiteT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['website', 'campaign-links'], queryFn: listCampaignLinks });
  const [editing, setEditing] = useState<CampaignLink | 'new' | null>(null);
  const [deleting, setDeleting] = useState<CampaignLink | null>(null);
  const mayCreate = ability.can('create', 'Storefront');
  const mayUpdate = ability.can('update', 'Storefront');
  const mayDelete = ability.can('delete', 'Storefront');

  return (
    <WebsitePage tab="/website/campaign-links" wide>
      <NamedSection
        title={t('wm.links.title')}
        description={t('wm.links.description')}
        actions={
          mayCreate ? (
            <Button size="sm" onClick={() => setEditing('new')}>
              <Plus aria-hidden />
              {t('wm.links.add')}
            </Button>
          ) : null
        }
      >
        <Loadable query={query}>
          {(data) => (
            <>
              {data.siteUrl === null ? (
                <p role="status" className="mb-3 text-sm text-muted-foreground">
                  {t('wm.links.noSiteUrl')}
                </p>
              ) : null}
              {data.items.length === 0 ? (
                <Empty />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm [&_td]:pr-3 [&_th]:h-9 [&_th]:pr-3">
                    <caption className="sr-only">{t('wm.links.title')}</caption>
                    <thead>
                      <tr className="border-b border-border text-left text-xs text-muted-foreground">
                        <th className="font-medium">{t('wm.links.code')}</th>
                        <th className="font-medium">{t('wm.links.name')}</th>
                        <th className="font-medium">{t('wm.links.target')}</th>
                        <th className="text-right font-medium">{t('wm.links.views')}</th>
                        <th className="font-medium">{t('wm.links.state')}</th>
                        <th className="font-medium">
                          <span className="sr-only">{t('wm.actions')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((link) => (
                        <tr key={link.id} className="h-row border-b border-border last:border-b-0">
                          <td className="font-mono text-xs tabular-nums">{link.code}</td>
                          <td className="font-medium">{link.title}</td>
                          <td className="max-w-72">
                            <span className="block truncate font-mono text-xs">{link.path}</span>
                            <span className="text-xs text-muted-foreground">
                              {link.baseType === 'category'
                                ? (link.categoryName ?? t('wm.links.base.category'))
                                : t(
                                    link.baseType === 'shop'
                                      ? 'wm.links.base.shop'
                                      : 'wm.links.base.custom',
                                  )}
                            </span>
                          </td>
                          <td className="text-right tabular-nums">{link.views}</td>
                          <td>
                            <StatusBadge tone={link.isActive ? 'success' : 'neutral'}>
                              {link.isActive ? w('web.on') : w('web.off')}
                            </StatusBadge>
                          </td>
                          <td className="text-right whitespace-nowrap">
                            <CopyButton
                              text={link.url ?? link.path}
                              label={`${t('wm.copyLink')}: ${link.title}`}
                            />
                            {mayUpdate ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`${w('web.edit')}: ${link.title}`}
                                onClick={() => setEditing(link)}
                              >
                                <Pencil aria-hidden />
                              </Button>
                            ) : null}
                            {mayDelete ? (
                              <Button
                                size="sm"
                                variant="ghost"
                                aria-label={`${w('web.delete')}: ${link.title}`}
                                onClick={() => setDeleting(link)}
                              >
                                <Trash2 aria-hidden />
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </Loadable>
      </NamedSection>
      {editing === null ? null : (
        <LinkDialog
          key={editing === 'new' ? 'new' : editing.id}
          link={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setDeleting(null);
          }}
          title={w('web.deleteTitle')}
          description={t('wm.links.deleteDetail')}
          confirmLabel={w('web.delete')}
          cancelLabel={w('web.cancel')}
          closeLabel={w('web.close')}
          destructive
          onConfirm={async () => {
            await deleteCampaignLink(deleting.id);
            setDeleting(null);
            await queryClient.invalidateQueries({ queryKey: ['website', 'campaign-links'] });
          }}
        />
      )}
    </WebsitePage>
  );
}

const DEFAULT_BANNER: CampaignLinkInput['banner'] = {
  enabled: false,
  text: '',
  bgColor: '#B85C3A',
  textColor: '#FFFFFF',
  link: '',
};
const DEFAULT_MODAL: CampaignLinkInput['modal'] = {
  enabled: false,
  type: 'text',
  title: '',
  text: '',
  imageFileId: null,
  ctaText: '',
  ctaLink: '',
};

function LinkDialog({
  link,
  onClose,
}: {
  readonly link: CampaignLink | null;
  readonly onClose: () => void;
}) {
  const t = useT();
  const w = useWebsiteT();
  const id = useId();
  const queryClient = useQueryClient();
  const nav = useQuery({ queryKey: ['website', 'nav'], queryFn: listNav });
  const [title, setTitle] = useState(link?.title ?? '');
  const [baseType, setBaseType] = useState<CampaignLink['baseType']>(link?.baseType ?? 'shop');
  const [categoryId, setCategoryId] = useState<string | null>(link?.categoryId ?? null);
  const [customPath, setCustomPath] = useState(link?.customPath ?? '');
  const [products, setProducts] = useState<readonly string[]>(link?.highlightProductIds ?? []);
  const [banner, setBanner] = useState(link?.banner ?? DEFAULT_BANNER);
  const [modal, setModal] = useState(link?.modal ?? DEFAULT_MODAL);
  const [active, setActive] = useState(link?.isActive ?? true);

  const save = useMutation({
    mutationFn: () => {
      const input: CampaignLinkInput = {
        title: title.trim(),
        baseType,
        categoryId: baseType === 'category' ? categoryId : null,
        customPath: baseType === 'custom' ? customPath.trim() : '',
        highlightProductIds: [...products],
        banner: { ...banner, text: banner.text.trim(), link: banner.link.trim() },
        modal: {
          ...modal,
          title: modal.title.trim(),
          text: modal.text.trim(),
          ctaText: modal.ctaText.trim(),
          ctaLink: modal.ctaLink.trim(),
        },
        isActive: active,
      };
      return link === null ? createCampaignLink(input) : updateCampaignLink(link.id, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['website', 'campaign-links'] });
      onClose();
    },
  });

  const categories = (nav.data?.categories ?? []).filter((category) => category.isActive);
  const incomplete =
    title.trim() === '' ||
    (baseType === 'category' && categoryId === null) ||
    (baseType === 'custom' && !customPath.trim().startsWith('/')) ||
    (modal.enabled && modal.type === 'image' && modal.imageFileId === null);

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={link === null ? t('wm.links.newTitle') : `${t('wm.links.editTitle')} ${link.code}`}
      closeLabel={w('web.close')}
      className="w-[min(44rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {w('web.cancel')}
          </Button>
          <Button disabled={incomplete || save.isPending} onClick={() => save.mutate()}>
            {w('web.save')}
          </Button>
        </>
      }
    >
      <div className="max-h-[70vh] space-y-5 overflow-y-auto pr-1">
        <Field id={`${id}-title`} label={t('wm.links.name')} hint={t('wm.links.nameHelp')}>
          <input
            id={`${id}-title`}
            value={title}
            maxLength={120}
            className={control}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id={`${id}-base`} label={t('wm.links.base')}>
            <Select
              id={`${id}-base`}
              value={baseType}
              onValueChange={(next) =>
                setBaseType(
                  next === 'category' ? 'category' : next === 'custom' ? 'custom' : 'shop',
                )
              }
              options={[
                { value: 'shop', label: t('wm.links.base.shop') },
                { value: 'category', label: t('wm.links.base.category') },
                { value: 'custom', label: t('wm.links.base.custom') },
              ]}
            />
          </Field>
          {baseType === 'category' ? (
            <Field id={`${id}-category`} label={t('wm.links.category')}>
              <Select
                id={`${id}-category`}
                value={categoryId ?? ''}
                placeholder={t('wm.links.chooseCategory')}
                onValueChange={(next) => setCategoryId(next === '' ? null : next)}
                options={categories.map((category) => ({
                  value: category.id,
                  label: category.name,
                }))}
              />
            </Field>
          ) : null}
          {baseType === 'custom' ? (
            <Field id={`${id}-path`} label={t('wm.links.path')} hint={t('wm.links.pathHelp')}>
              <input
                id={`${id}-path`}
                value={customPath}
                maxLength={300}
                placeholder="/new-arrivals"
                className={control}
                onChange={(event) => setCustomPath(event.target.value)}
              />
            </Field>
          ) : null}
        </div>

        <HighlightPicker value={products} onChange={setProducts} />

        <fieldset className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('wm.links.banner')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={banner.enabled}
              onCheckedChange={(next) => setBanner({ ...banner, enabled: next === true })}
            />
            {t('wm.links.bannerOn')}
          </label>
          {banner.enabled ? (
            <>
              <Field id={`${id}-banner-text`} label={t('wm.links.bannerText')}>
                <input
                  id={`${id}-banner-text`}
                  value={banner.text}
                  maxLength={200}
                  className={control}
                  onChange={(event) => setBanner({ ...banner, text: event.target.value })}
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field id={`${id}-banner-bg`} label={t('wm.links.bannerBg')}>
                  <input
                    id={`${id}-banner-bg`}
                    type="color"
                    value={banner.bgColor}
                    className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
                    onChange={(event) =>
                      setBanner({ ...banner, bgColor: event.target.value.toUpperCase() })
                    }
                  />
                </Field>
                <Field id={`${id}-banner-fg`} label={t('wm.links.bannerFg')}>
                  <input
                    id={`${id}-banner-fg`}
                    type="color"
                    value={banner.textColor}
                    className="h-9 w-full cursor-pointer rounded-md border border-input bg-background"
                    onChange={(event) =>
                      setBanner({ ...banner, textColor: event.target.value.toUpperCase() })
                    }
                  />
                </Field>
                <Field id={`${id}-banner-link`} label={t('wm.links.bannerLink')}>
                  <input
                    id={`${id}-banner-link`}
                    value={banner.link}
                    maxLength={500}
                    placeholder="/shop"
                    className={control}
                    onChange={(event) => setBanner({ ...banner, link: event.target.value })}
                  />
                </Field>
              </div>
            </>
          ) : null}
        </fieldset>

        <fieldset className="space-y-3 rounded-md border border-border p-3">
          <legend className="px-1 text-sm font-medium">{t('wm.links.modal')}</legend>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={modal.enabled}
              onCheckedChange={(next) => setModal({ ...modal, enabled: next === true })}
            />
            {t('wm.links.modalOn')}
          </label>
          {modal.enabled ? (
            <>
              <Field id={`${id}-modal-type`} label={t('wm.links.modalType')}>
                <Select
                  id={`${id}-modal-type`}
                  value={modal.type}
                  onValueChange={(next) =>
                    setModal({ ...modal, type: next === 'image' ? 'image' : 'text' })
                  }
                  options={[
                    { value: 'text', label: t('wm.links.modalText') },
                    { value: 'image', label: t('wm.links.modalImage') },
                  ]}
                />
              </Field>
              <Field id={`${id}-modal-title`} label={t('wm.links.modalTitle')}>
                <input
                  id={`${id}-modal-title`}
                  value={modal.title}
                  maxLength={120}
                  className={control}
                  onChange={(event) => setModal({ ...modal, title: event.target.value })}
                />
              </Field>
              {modal.type === 'image' ? (
                <div className="space-y-1.5 text-sm">
                  <p className="font-medium">{t('wm.links.modalPicture')}</p>
                  <div className="flex flex-wrap items-center gap-3">
                    {modal.imageFileId === null ? null : (
                      <Preview fileId={modal.imageFileId} alt={modal.title} className="h-20 w-20" />
                    )}
                    <ImagePicker
                      purpose="campaign-asset"
                      onUploaded={(fileId) => setModal({ ...modal, imageFileId: fileId })}
                    />
                  </div>
                </div>
              ) : (
                <Field id={`${id}-modal-text`} label={t('wm.links.modalBody')}>
                  <textarea
                    id={`${id}-modal-text`}
                    value={modal.text}
                    maxLength={1000}
                    rows={3}
                    className={`${control} h-auto py-2`}
                    onChange={(event) => setModal({ ...modal, text: event.target.value })}
                  />
                </Field>
              )}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id={`${id}-modal-cta`} label={t('wm.links.ctaText')}>
                  <input
                    id={`${id}-modal-cta`}
                    value={modal.ctaText}
                    maxLength={60}
                    className={control}
                    onChange={(event) => setModal({ ...modal, ctaText: event.target.value })}
                  />
                </Field>
                <Field id={`${id}-modal-link`} label={t('wm.links.ctaLink')}>
                  <input
                    id={`${id}-modal-link`}
                    value={modal.ctaLink}
                    maxLength={500}
                    placeholder="/shop"
                    className={control}
                    onChange={(event) => setModal({ ...modal, ctaLink: event.target.value })}
                  />
                </Field>
              </div>
            </>
          ) : null}
        </fieldset>

        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={active} onCheckedChange={(next) => setActive(next === true)} />
          {t('wm.links.active')}
        </label>
        <Problem error={save.error} />
      </div>
    </Dialog>
  );
}

const MAX_HIGHLIGHTS = 24;

/** The products shown first, in order: search by name, add, remove. */
function HighlightPicker({
  value,
  onChange,
}: {
  readonly value: readonly string[];
  readonly onChange: (next: readonly string[]) => void;
}) {
  const t = useT();
  const id = useId();
  const [q, setQ] = useState('');
  const search = useQuery({
    queryKey: ['catalog', 'products', 'pick', q],
    queryFn: () => listProducts({ q, limit: 8, status: 'active' }),
    enabled: q.trim().length >= 3,
  });
  const names = useQueries({
    queries: value.map((productId) => ({
      queryKey: ['catalog', 'product', productId],
      queryFn: () => getProduct(productId),
      staleTime: 60_000,
    })),
  });
  const nameOf = (index: number) => names[index]?.data?.name ?? '…';

  return (
    <div className="space-y-2 text-sm">
      <label htmlFor={`${id}-q`} className="block font-medium">
        {t('wm.links.highlights')}
      </label>
      <p className="text-xs text-muted-foreground">{t('wm.links.highlightsHelp')}</p>
      {value.length === 0 ? null : (
        <ol className="divide-y divide-border rounded-md border border-border">
          {value.map((productId, index) => (
            <li key={productId} className="flex items-center justify-between gap-2 px-3 py-1.5">
              <span className="truncate">{nameOf(index)}</span>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${t('wm.remove')}: ${nameOf(index)}`}
                onClick={() => onChange(value.filter((entry) => entry !== productId))}
              >
                <X aria-hidden />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <input
        id={`${id}-q`}
        value={q}
        maxLength={100}
        placeholder={t('wm.links.searchProducts')}
        disabled={value.length >= MAX_HIGHLIGHTS}
        className={control}
        onChange={(event) => setQ(event.target.value)}
      />
      {search.data === undefined || q.trim().length < 3 ? null : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {search.data.items.length === 0 ? (
            <li className="px-3 py-1.5 text-muted-foreground">{t('wm.links.noProducts')}</li>
          ) : (
            search.data.items.map((product) => {
              const chosen = value.includes(product.id);
              return (
                <li key={product.id} className="flex items-center justify-between gap-2 px-3 py-1">
                  <span className="truncate">{product.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={chosen || value.length >= MAX_HIGHLIGHTS}
                    aria-label={`${t('wm.add')}: ${product.name}`}
                    onClick={() => onChange([...value, product.id])}
                  >
                    {chosen ? <Check aria-hidden /> : <Plus aria-hidden />}
                  </Button>
                </li>
              );
            })
          )}
        </ul>
      )}
    </div>
  );
}
