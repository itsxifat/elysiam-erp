import { Button, Checkbox, ConfirmDialog, Dialog, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import {
  createSlide,
  deleteSlide,
  listSlides,
  reorderSlides,
  updateSlide,
  type HeroSlide,
} from './api.js';
import { useWebsiteT } from './messages.js';
import {
  control,
  Empty,
  Field,
  ImagePicker,
  Loadable,
  MoveButtons,
  moved,
  Preview,
  Problem,
  useDragReorder,
  WebsitePage,
} from './parts.js';
import '../../i18n/website.js';

/**
 * Website → Hero slides (M33, D-504): the home page's slides in the order they play, each
 * with a desktop image, an optional mobile one, where it leads and whether it shows. Drag a
 * row, or use its arrows, to reorder; the new order is saved at once.
 */
export function WebsiteHeroPage() {
  const t = useWebsiteT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['website', 'hero'], queryFn: listSlides });
  const [editing, setEditing] = useState<HeroSlide | 'new' | null>(null);
  const [deleting, setDeleting] = useState<HeroSlide | null>(null);
  const mayCreate = ability.can('create', 'Storefront');
  const mayUpdate = ability.can('update', 'Storefront');
  const mayDelete = ability.can('delete', 'Storefront');

  const reorder = useMutation({
    mutationFn: (ids: readonly string[]) => reorderSlides(ids),
    onSuccess: (next) => queryClient.setQueryData(['website', 'hero'], next),
  });
  const items = query.data?.items ?? [];
  const move = (from: number, to: number) =>
    reorder.mutate(moved(items, from, to).map((slide) => slide.id));
  const drag = useDragReorder(move);

  return (
    <WebsitePage tab="/website/hero">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('web.hero.caption')}</p>
        {mayCreate ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {t('web.hero.add')}
          </Button>
        ) : null}
      </div>
      <Loadable query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty />
          ) : (
            <ol className="divide-y divide-border rounded-lg border border-border bg-card">
              {data.items.map((slide, index) => (
                <li
                  key={slide.id}
                  {...(mayUpdate ? drag(index) : {})}
                  className="flex items-center gap-3 px-3 py-2 data-[dragging=true]:opacity-50"
                >
                  {mayUpdate ? (
                    <GripVertical
                      aria-hidden
                      className="size-4 shrink-0 cursor-grab text-muted-foreground"
                    />
                  ) : null}
                  <Preview fileId={slide.desktopFileId} alt={slide.altText ?? ''} />
                  <div className="min-w-0 flex-1 text-sm">
                    <p className="truncate font-medium">{slide.altText ?? slide.link}</p>
                    <p className="truncate text-xs text-muted-foreground">{slide.link}</p>
                  </div>
                  <StatusBadge tone={slide.isActive ? 'success' : 'neutral'}>
                    {slide.isActive ? t('web.on') : t('web.off')}
                  </StatusBadge>
                  {mayUpdate ? (
                    <MoveButtons
                      index={index}
                      count={data.items.length}
                      disabled={reorder.isPending}
                      onMove={move}
                      label={slide.altText ?? slide.link}
                    />
                  ) : null}
                  {mayUpdate ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${t('web.edit')}: ${slide.altText ?? slide.link}`}
                      onClick={() => setEditing(slide)}
                    >
                      <Pencil aria-hidden />
                    </Button>
                  ) : null}
                  {mayDelete ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${t('web.delete')}: ${slide.altText ?? slide.link}`}
                      onClick={() => setDeleting(slide)}
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  ) : null}
                </li>
              ))}
            </ol>
          )
        }
      </Loadable>
      <Problem error={reorder.error} />
      {editing === null ? null : (
        <SlideDialog
          key={editing === 'new' ? 'new' : editing.id}
          slide={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting === null ? null : (
        <ConfirmDialog
          open
          onOpenChange={(next) => {
            if (!next) setDeleting(null);
          }}
          title={t('web.deleteTitle')}
          description={t('web.deleteDetail')}
          confirmLabel={t('web.delete')}
          cancelLabel={t('web.cancel')}
          closeLabel={t('web.close')}
          destructive
          onConfirm={async () => {
            await deleteSlide(deleting.id);
            setDeleting(null);
            await queryClient.invalidateQueries({ queryKey: ['website', 'hero'] });
          }}
        />
      )}
    </WebsitePage>
  );
}

function SlideDialog({
  slide,
  onClose,
}: {
  readonly slide: HeroSlide | null;
  readonly onClose: () => void;
}) {
  const t = useWebsiteT();
  const id = useId();
  const queryClient = useQueryClient();
  const [desktop, setDesktop] = useState<string | null>(slide?.desktopFileId ?? null);
  const [mobile, setMobile] = useState<string | null>(slide?.mobileFileId ?? null);
  const [link, setLink] = useState(slide?.link ?? '/');
  const [alt, setAlt] = useState(slide?.altText ?? '');
  const [active, setActive] = useState(slide?.isActive ?? true);

  const save = useMutation({
    mutationFn: () => {
      if (desktop === null) throw new Error(t('web.hero.noImage'));
      const input = {
        desktopFileId: desktop,
        mobileFileId: mobile,
        link: link.trim(),
        altText: alt.trim() === '' ? null : alt.trim(),
        isActive: active,
      };
      return slide === null ? createSlide(input) : updateSlide(slide.id, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['website', 'hero'] });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('web.hero.formTitle')}
      closeLabel={t('web.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('web.cancel')}
          </Button>
          <Button disabled={desktop === null || save.isPending} onClick={() => save.mutate()}>
            {t('web.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5 text-sm">
          <p className="font-medium">{t('web.hero.desktop')}</p>
          <div className="flex flex-wrap items-center gap-3">
            {desktop === null ? null : <Preview fileId={desktop} alt={alt} className="h-14 w-36" />}
            <ImagePicker purpose="storefront-image" onUploaded={setDesktop} />
          </div>
        </div>
        <div className="space-y-1.5 text-sm">
          <p className="font-medium">{t('web.hero.mobile')}</p>
          <div className="flex flex-wrap items-center gap-3">
            {mobile === null ? null : <Preview fileId={mobile} alt={alt} className="h-20 w-16" />}
            <ImagePicker purpose="storefront-image" onUploaded={setMobile} />
            {mobile === null ? null : (
              <Button size="sm" variant="ghost" onClick={() => setMobile(null)}>
                {t('web.settings.remove')}
              </Button>
            )}
          </div>
        </div>
        <Field id={`${id}-link`} label={t('web.hero.link')} hint={t('web.settings.linkHelp')}>
          <input
            id={`${id}-link`}
            value={link}
            maxLength={500}
            className={control}
            onChange={(event) => setLink(event.target.value)}
          />
        </Field>
        <Field id={`${id}-alt`} label={t('web.hero.alt')}>
          <input
            id={`${id}-alt`}
            value={alt}
            maxLength={200}
            className={control}
            onChange={(event) => setAlt(event.target.value)}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={active} onCheckedChange={(next) => setActive(next === true)} />
          {t('web.hero.show')}
        </label>
        <Problem error={save.error} />
      </div>
    </Dialog>
  );
}
