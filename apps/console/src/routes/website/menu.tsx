import type { NavItemInput } from '@elysium/contracts';
import { Button, Checkbox, ConfirmDialog, Dialog, Select, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GripVertical, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import {
  createNavItem,
  deleteNavItem,
  layoutNav,
  listNav,
  updateNavItem,
  type NavCategory,
  type NavItem,
} from './api.js';
import { useWebsiteT, type WebsiteMessageKey } from './messages.js';
import {
  control,
  Empty,
  Field,
  Loadable,
  MoveButtons,
  moved,
  Problem,
  useDragReorder,
  WebsitePage,
} from './parts.js';
import '../../i18n/website.js';
import { formatCount } from '@elysium/i18n';
import { navItemUsage } from '../../api/manage.js';
import { useLocale } from '../../i18n/locale.js';
import '../../i18n/manage.js';

/**
 * Website → Menu (M33, D-504): the website's top menu, two levels deep. A category item
 * opens onto that category's subcategories on the website; a dropdown holds its own items.
 * Rows reorder within their level by drag or by their arrows, saved at once as the whole
 * menu's layout, which the server checks against the domain's rules before keeping.
 */
export function WebsiteMenuPage() {
  const t = useWebsiteT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['website', 'menu'], queryFn: listNav });
  const [editing, setEditing] = useState<NavItem | 'new' | null>(null);
  const [deleting, setDeleting] = useState<NavItem | null>(null);
  const mayCreate = ability.can('create', 'Storefront');
  const mayUpdate = ability.can('update', 'Storefront');
  const mayDelete = ability.can('delete', 'Storefront');

  const layout = useMutation({
    mutationFn: (items: readonly { id: string; parentId: string | null; position: number }[]) =>
      layoutNav(items),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['website', 'menu'] });
    },
  });

  /** Move one item among its siblings, and send the whole menu's layout. */
  const moveWithin = (
    all: readonly NavItem[],
    parentId: string | null,
    from: number,
    to: number,
  ) => {
    const siblings = byPosition(all.filter((item) => item.parentId === parentId));
    const reordered = moved(siblings, from, to);
    const positions = new Map(reordered.map((item, index) => [item.id, index]));
    layout.mutate(
      all.map((item) => ({
        id: item.id,
        parentId: item.parentId,
        position: positions.get(item.id) ?? item.position,
      })),
    );
  };

  return (
    <WebsitePage tab="/website/menu">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('web.menu.caption')}</p>
        {mayCreate ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {t('web.menu.add')}
          </Button>
        ) : null}
      </div>
      <Loadable query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty />
          ) : (
            <Level
              items={data.items}
              categories={data.categories}
              parentId={null}
              mayUpdate={mayUpdate}
              mayDelete={mayDelete}
              busy={layout.isPending}
              onMove={(parentId, from, to) => moveWithin(data.items, parentId, from, to)}
              onEdit={setEditing}
              onDelete={setDeleting}
            />
          )
        }
      </Loadable>
      <Problem error={layout.error} />
      {editing === null || query.data === undefined ? null : (
        <ItemDialog
          key={editing === 'new' ? 'new' : editing.id}
          item={editing === 'new' ? null : editing}
          items={query.data.items}
          categories={query.data.categories}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting === null ? null : (
        <MenuDeleteConfirm
          item={deleting}
          name={
            deleting.label ??
            query.data?.categories.find((category) => category.id === deleting.categoryId)?.name ??
            ''
          }
          onClose={() => setDeleting(null)}
          onDeleted={async () => {
            setDeleting(null);
            await queryClient.invalidateQueries({ queryKey: ['website', 'menu'] });
          }}
        />
      )}
    </WebsitePage>
  );
}

function byPosition(items: readonly NavItem[]): NavItem[] {
  return [...items].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

function labelOf(item: NavItem, categories: readonly NavCategory[]): string {
  if (item.label !== null && item.label !== '') return item.label;
  return categories.find((category) => category.id === item.categoryId)?.name ?? '';
}

function Level({
  items,
  categories,
  parentId,
  mayUpdate,
  mayDelete,
  busy,
  onMove,
  onEdit,
  onDelete,
}: {
  readonly items: readonly NavItem[];
  readonly categories: readonly NavCategory[];
  readonly parentId: string | null;
  readonly mayUpdate: boolean;
  readonly mayDelete: boolean;
  readonly busy: boolean;
  readonly onMove: (parentId: string | null, from: number, to: number) => void;
  readonly onEdit: (item: NavItem) => void;
  readonly onDelete: (item: NavItem) => void;
}) {
  const t = useWebsiteT();
  const siblings = byPosition(items.filter((item) => item.parentId === parentId));
  const drag = useDragReorder((from, to) => onMove(parentId, from, to));
  return (
    <ol
      className={
        parentId === null
          ? 'divide-y divide-border rounded-lg border border-border bg-card'
          : 'ml-8 divide-y divide-border border-l border-border'
      }
    >
      {siblings.map((item, index) => {
        const label = labelOf(item, categories);
        const category = categories.find((entry) => entry.id === item.categoryId);
        return (
          <li key={item.id}>
            <div
              {...(mayUpdate ? drag(index) : {})}
              className="flex items-center gap-3 px-3 py-2 text-sm data-[dragging=true]:opacity-50"
            >
              {mayUpdate ? (
                <GripVertical
                  aria-hidden
                  className="size-4 shrink-0 cursor-grab text-muted-foreground"
                />
              ) : null}
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{label}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {t(`web.menu.kind.${item.kind}` as WebsiteMessageKey)}
                  {item.kind === 'link' && item.href !== null ? ` · ${item.href}` : ''}
                  {item.kind === 'category' && category !== undefined ? ` · /${category.slug}` : ''}
                </p>
              </div>
              {item.highlighted ? (
                <StatusBadge tone="info">{t('web.menu.highlighted')}</StatusBadge>
              ) : null}
              <StatusBadge tone={item.isActive ? 'success' : 'neutral'}>
                {item.isActive ? t('web.on') : t('web.off')}
              </StatusBadge>
              {mayUpdate ? (
                <MoveButtons
                  index={index}
                  count={siblings.length}
                  disabled={busy}
                  onMove={(from, to) => onMove(parentId, from, to)}
                  label={label}
                />
              ) : null}
              {mayUpdate ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${t('web.edit')}: ${label}`}
                  onClick={() => onEdit(item)}
                >
                  <Pencil aria-hidden />
                </Button>
              ) : null}
              {mayDelete ? (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${t('web.delete')}: ${label}`}
                  onClick={() => onDelete(item)}
                >
                  <Trash2 aria-hidden />
                </Button>
              ) : null}
            </div>
            {item.kind === 'dropdown' && items.some((child) => child.parentId === item.id) ? (
              <Level
                items={items}
                categories={categories}
                parentId={item.id}
                mayUpdate={mayUpdate}
                mayDelete={mayDelete}
                busy={busy}
                onMove={onMove}
                onEdit={onEdit}
                onDelete={onDelete}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function ItemDialog({
  item,
  items,
  categories,
  onClose,
}: {
  readonly item: NavItem | null;
  readonly items: readonly NavItem[];
  readonly categories: readonly NavCategory[];
  readonly onClose: () => void;
}) {
  const t = useWebsiteT();
  const id = useId();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<NavItem['kind']>(item?.kind ?? 'link');
  const [label, setLabel] = useState(item?.label ?? '');
  const [href, setHref] = useState(item?.href ?? '');
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? '');
  const [parentId, setParentId] = useState(item?.parentId ?? '');
  const [highlighted, setHighlighted] = useState(item?.highlighted ?? false);
  const [active, setActive] = useState(item?.isActive ?? true);
  // Only a top-level dropdown holds items, and a dropdown cannot sit inside another.
  const parents = items.filter(
    (candidate) =>
      candidate.kind === 'dropdown' && candidate.parentId === null && candidate.id !== item?.id,
  );

  const input = (): NavItemInput => ({
    parentId: kind === 'dropdown' || parentId === '' ? null : parentId,
    kind,
    label: label.trim() === '' ? null : label.trim(),
    href:
      kind === 'link'
        ? href.trim()
        : kind === 'category' && href.trim() !== ''
          ? href.trim()
          : null,
    categoryId: kind === 'category' ? categoryId : null,
    highlighted,
    isActive: active,
  });
  const ready =
    (kind === 'link' && href.trim() !== '' && label.trim() !== '') ||
    (kind === 'category' && categoryId !== '') ||
    (kind === 'dropdown' && label.trim() !== '');

  const save = useMutation({
    mutationFn: () => (item === null ? createNavItem(input()) : updateNavItem(item.id, input())),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['website', 'menu'] });
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('web.menu.formTitle')}
      closeLabel={t('web.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('web.cancel')}
          </Button>
          <Button disabled={!ready || save.isPending} onClick={() => save.mutate()}>
            {t('web.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field id={`${id}-kind`} label={t('web.menu.kind')}>
          <Select
            id={`${id}-kind`}
            value={kind}
            onValueChange={(next) =>
              setKind(next === 'category' ? 'category' : next === 'dropdown' ? 'dropdown' : 'link')
            }
            options={(['link', 'category', 'dropdown'] as const).map((value) => ({
              value,
              label: t(`web.menu.kind.${value}` as WebsiteMessageKey),
            }))}
          />
        </Field>
        {kind === 'category' ? (
          <Field id={`${id}-category`} label={t('web.menu.category')}>
            <Select
              id={`${id}-category`}
              value={categoryId}
              placeholder={t('web.menu.category')}
              onValueChange={setCategoryId}
              options={categories
                .filter((category) => category.isActive)
                .map((category) => ({ value: category.id, label: category.name }))}
            />
          </Field>
        ) : null}
        <Field
          id={`${id}-label`}
          label={t('web.menu.label')}
          hint={kind === 'category' ? t('web.menu.labelHelp') : undefined}
        >
          <input
            id={`${id}-label`}
            value={label}
            maxLength={60}
            className={control}
            onChange={(event) => setLabel(event.target.value)}
          />
        </Field>
        {kind === 'link' ? (
          <Field id={`${id}-href`} label={t('web.menu.href')} hint={t('web.settings.linkHelp')}>
            <input
              id={`${id}-href`}
              value={href}
              maxLength={500}
              className={control}
              onChange={(event) => setHref(event.target.value)}
            />
          </Field>
        ) : null}
        {kind === 'dropdown' ? null : (
          <Field id={`${id}-parent`} label={t('web.menu.parent')}>
            <Select
              id={`${id}-parent`}
              value={parentId}
              onValueChange={setParentId}
              options={[
                { value: '', label: t('web.menu.topLevel') },
                ...parents.map((parent) => ({ value: parent.id, label: parent.label ?? '' })),
              ]}
            />
          </Field>
        )}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={highlighted}
            onCheckedChange={(next) => setHighlighted(next === true)}
          />
          {t('web.menu.highlighted')}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={active} onCheckedChange={(next) => setActive(next === true)} />
          {t('web.menu.show')}
        </label>
        <Problem error={save.error} />
      </div>
    </Dialog>
  );
}

/**
 * Deleting a menu item, and with a dropdown every item under it (0103's cascade): the server
 * says how many go first, and the confirmation names the number (M39a, D-628).
 */
function MenuDeleteConfirm({
  item,
  name,
  onClose,
  onDeleted,
}: {
  readonly item: NavItem;
  readonly name: string;
  readonly onClose: () => void;
  readonly onDeleted: () => Promise<void>;
}) {
  const t = useWebsiteT();
  const { t: tm, locale } = useLocale();
  const usage = useQuery({
    queryKey: ['website', 'menu', item.id, 'usage'],
    queryFn: () => navItemUsage(item.id),
    staleTime: 0,
    retry: false,
  });
  const children = usage.data?.children ?? 0;
  const description =
    children > 0
      ? tm('mg.menu.withChildren')
          .replace('{name}', name)
          .replace('{n}', formatCount(children, locale))
      : tm('mg.menu.alone').replace('{name}', name);
  return (
    <ConfirmDialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('web.deleteTitle')}
      description={usage.isPending ? tm('mg.loading') : description}
      confirmLabel={t('web.delete')}
      cancelLabel={t('web.cancel')}
      closeLabel={t('web.close')}
      destructive
      onConfirm={async () => {
        await deleteNavItem(item.id);
        await onDeleted();
      }}
    />
  );
}
