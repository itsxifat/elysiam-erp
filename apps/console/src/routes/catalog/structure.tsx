import {
  Button,
  Checkbox,
  Dialog,
  PageHeader,
  PermissionGate,
  Select,
  StatusBadge,
  controlClassName,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { cloneElement, useId, useState, type ReactElement } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { DEFAULT_PAGE_SIZE } from '../../lib/table-search.js';
import {
  createLocation,
  listAllLocations,
  listBranchOptions,
  updateLocation,
  type StockLocation,
} from '../stock/api.js';
import {
  createAttribute,
  createAttributeValue,
  createCategory,
  listAttributes,
  listCategories,
  updateAttribute,
  updateAttributeValue,
  updateCategory,
  type CatalogAttribute,
  type CatalogCategory,
} from './api.js';
import { CategoryWebsiteDialog } from './category-website.js';
import { slugify } from './slug.js';
import { codeFrom } from './variant-grid.js';

/**
 * Catalog setup: categories, the size and colour lists, and the brand's stock locations
 * (plan `catalog-stock-ux`, D-424, D-429). Linked from the Catalog header rather than
 * given a menu item of its own: it is the catalog's vocabulary, set up once and touched
 * rarely.
 *
 * Every code (category, list, value, location) is suggested from the name and can be
 * changed before saving, and none can be changed afterwards: codes are inside every SKU
 * code and label already printed. Names and labels can always be fixed.
 */
export function CatalogStructurePage() {
  const ability = useAbility();
  const t = useT();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Catalog');
  const mayCreate = ability.can('create', 'Catalog');
  const mayUpdate = ability.can('update', 'Catalog');
  const mayStock = ability.can('read', 'Stock');

  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: listCategories,
    enabled: mayRead,
  });
  const attributes = useQuery({
    queryKey: ['catalog', 'attributes'],
    queryFn: listAttributes,
    enabled: mayRead,
  });
  const locations = useQuery({
    queryKey: ['stock', 'locations', 'all'],
    queryFn: listAllLocations,
    enabled: mayStock,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['catalog'] });
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
  };

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('catalog.deniedTitle'), detail: t('catalog.deniedDetail') }}
    >
      <div className="max-w-4xl space-y-6">
        <div className="space-y-3">
          <nav aria-label={t('cs.breadcrumb')} className="text-sm text-muted-foreground">
            <Link
              to="/catalog"
              search={{ page: 1, pageSize: DEFAULT_PAGE_SIZE }}
              className="inline-flex items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ArrowLeft aria-hidden className="size-4" />
              {t('catalog.title')}
            </Link>
          </nav>
          <PageHeader title={t('cs.setup.title')} description={t('cs.setup.help')} />
        </div>

        <Categories
          items={categories.data?.items ?? []}
          mayCreate={mayCreate}
          mayUpdate={mayUpdate}
          onDone={refresh}
        />
        <Lists
          items={attributes.data?.items ?? []}
          mayCreate={mayCreate}
          mayUpdate={mayUpdate}
          onDone={refresh}
        />
        <PermissionGate allowed={mayStock}>
          <Locations
            items={locations.data?.items ?? []}
            mayCreate={mayCreate}
            mayUpdate={mayUpdate}
            onDone={refresh}
          />
        </PermissionGate>
      </div>
    </PermissionGate>
  );
}

/** The kit's control; width comes from where it sits (a dialog's column, a form row). */
const control = controlClassName;

/** A label joined to its one control by id (see `Field` in parts.tsx for why). */
function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}

function Problem({ error }: { readonly error: unknown }) {
  const t = useT();
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className="basis-full text-sm text-destructive">
      {error instanceof ApiError ? error.message : t('cs.saveFailed')}
    </p>
  );
}

// --- categories -------------------------------------------------------------------

function Categories({
  items,
  mayCreate,
  mayUpdate,
  onDone,
}: {
  readonly items: readonly CatalogCategory[];
  readonly mayCreate: boolean;
  readonly mayUpdate: boolean;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [editing, setEditing] = useState<CatalogCategory | null>(null);
  const [onWebsite, setOnWebsite] = useState<CatalogCategory | null>(null);
  const ability = useAbility();
  const mayWebsite = ability.can('update', 'Storefront');
  const suggested = code ?? codeFrom(name, 4);

  const create = useMutation({
    mutationFn: () =>
      createCategory({
        name: name.trim(),
        slug: slugify(name),
        code: suggested,
        parentId: parentId === '' ? undefined : parentId,
      }),
    onSuccess: () => {
      setName('');
      setCode(null);
      onDone();
    },
  });

  return (
    <section
      aria-labelledby="categories-heading"
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <h2 id="categories-heading" className="text-base font-semibold tracking-tight">
        {t('catalog.categories')}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('cs.setup.noCategories')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((category) => (
            <li key={category.id} className="flex min-h-row items-center gap-3 px-4 py-1.5 text-sm">
              <span
                aria-hidden
                className={['w-0', 'w-4', 'w-8', 'w-12'][Math.min(category.depth, 3)] ?? 'w-0'}
              />
              <span className="font-medium">{category.name}</span>
              <span className="text-xs text-muted-foreground tabular-nums">{category.code}</span>
              {category.isActive ? null : (
                <StatusBadge tone="neutral">{t('cs.inactive')}</StatusBadge>
              )}
              {category.web.webVisible ? null : (
                <StatusBadge tone="neutral">{t('web.off')}</StatusBadge>
              )}
              <span className="flex-1" />
              <PermissionGate allowed={mayWebsite}>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`${t('web.category.action')}: ${category.name}`}
                  onClick={() => setOnWebsite(category)}
                >
                  {t('web.category.action')}
                </Button>
              </PermissionGate>
              <PermissionGate allowed={mayUpdate}>
                <Button size="sm" variant="ghost" onClick={() => setEditing(category)}>
                  {t('cs.edit')}
                </Button>
              </PermissionGate>
            </li>
          ))}
        </ul>
      )}

      <PermissionGate allowed={mayCreate}>
        <div className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/50 p-4">
          <Field label={t('cs.setup.categoryName')}>
            <input
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              className={control}
            />
          </Field>
          <Field label={t('cs.setup.parent')}>
            <Select
              value={parentId}
              onValueChange={setParentId}
              className="min-w-44"
              options={[
                { value: '', label: t('cs.setup.topLevel') },
                ...items
                  .filter((category) => category.depth < 3)
                  .map((category) => ({
                    value: category.id,
                    // A sub-category sits under its parent, indented as the list nests.
                    label: `${'\u00a0'.repeat(category.depth * 2)}${category.name}`,
                  })),
              ]}
            />
          </Field>
          <Field label={t('cs.setup.code')}>
            <input
              value={suggested}
              maxLength={8}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              className={`${control} w-24 font-mono uppercase`}
            />
          </Field>
          <Button
            size="sm"
            disabled={name.trim() === '' || !/^[A-Z0-9]{1,8}$/.test(suggested) || create.isPending}
            onClick={() => create.mutate()}
          >
            {t('cs.setup.addCategory')}
          </Button>
          <p className="basis-full text-xs text-muted-foreground">{t('cs.setup.codeHint')}</p>
          <Problem error={create.error} />
        </div>
      </PermissionGate>

      {onWebsite === null ? null : (
        <CategoryWebsiteDialog
          key={onWebsite.id}
          category={onWebsite}
          onClose={() => setOnWebsite(null)}
          onDone={onDone}
        />
      )}

      {editing === null ? null : (
        <EditCategory
          key={editing.id}
          category={editing}
          all={items}
          onClose={() => setEditing(null)}
          onDone={onDone}
        />
      )}
    </section>
  );
}

function EditCategory({
  category,
  all,
  onClose,
  onDone,
}: {
  readonly category: CatalogCategory;
  readonly all: readonly CatalogCategory[];
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(category.name);
  const [parentId, setParentId] = useState(category.parentId ?? '');
  const [active, setActive] = useState(category.isActive);
  // Not under itself or anything below it: the database refuses a cycle anyway.
  const choosable = all.filter(
    (other) => other.id !== category.id && !other.path.startsWith(`${category.path}/`),
  );

  const save = useMutation({
    mutationFn: () =>
      updateCategory(category.id, {
        name: name.trim(),
        parentId: parentId === '' ? null : parentId,
        isActive: active,
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
      title={t('cs.setup.editCategory')}
      description={t('cs.setup.codeFixed')}
      closeLabel={t('cs.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cs.cancel')}
          </Button>
          <Button disabled={name.trim() === '' || save.isPending} onClick={() => save.mutate()}>
            {t('cs.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('cs.setup.categoryName')}>
          <input
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            className={control}
          />
        </Field>
        <Field label={t('cs.setup.parent')}>
          <Select
            value={parentId}
            onValueChange={setParentId}
            options={[
              { value: '', label: t('cs.setup.topLevel') },
              ...choosable.map((other) => ({
                value: other.id,
                label: `${'\u00a0'.repeat(other.depth * 2)}${other.name}`,
              })),
            ]}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={active} onCheckedChange={(next) => setActive(next === true)} />
          {t('cs.setup.inUse')}
        </label>
        <Problem error={save.error} />
      </div>
    </Dialog>
  );
}

// --- sizes, colours and other lists ---------------------------------------------------

function attributeCode(name: string): string {
  const code = codeFrom(name, 32);
  return /^[A-Z]/.test(code) ? code : `A${code}`.slice(0, 32);
}

function Lists({
  items,
  mayCreate,
  mayUpdate,
  onDone,
}: {
  readonly items: readonly CatalogAttribute[];
  readonly mayCreate: boolean;
  readonly mayUpdate: boolean;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'size' | 'colour' | 'custom'>('size');
  const [isVariant, setIsVariant] = useState(true);
  const [renaming, setRenaming] = useState<
    | { kind: 'list'; attribute: CatalogAttribute }
    | { kind: 'value'; attribute: CatalogAttribute; valueId: string; label: string }
    | null
  >(null);

  const create = useMutation({
    mutationFn: () =>
      createAttribute({
        code: attributeCode(name),
        name: name.trim(),
        kind,
        isVariant,
        // Last in the list, so lists show in the order they were added.
        position: items.length,
      }),
    onSuccess: () => {
      setName('');
      onDone();
    },
  });

  return (
    <section
      aria-labelledby="lists-heading"
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <h2 id="lists-heading" className="text-base font-semibold tracking-tight">
        {t('cs.setup.lists')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('cs.setup.listsHelp')}</p>

      <ul className="space-y-3">
        {items.map((attribute) => (
          <li key={attribute.id} className="space-y-3 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-medium">{attribute.name}</span>
              <StatusBadge tone="neutral">{t(`catalog.kind.${attribute.kind}`)}</StatusBadge>
              {attribute.isVariant ? null : (
                <StatusBadge tone="info">{t('cs.setup.describesOnly')}</StatusBadge>
              )}
              <span className="flex-1" />
              <PermissionGate allowed={mayUpdate}>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setRenaming({ kind: 'list', attribute })}
                >
                  {t('cs.rename')}
                </Button>
              </PermissionGate>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {attribute.values.length === 0 ? (
                <span className="text-xs text-muted-foreground">{t('cs.setup.noValues')}</span>
              ) : null}
              {attribute.values.map((value) =>
                mayUpdate ? (
                  <Button
                    key={value.id}
                    size="sm"
                    variant="outline"
                    aria-label={`${t('cs.rename')} ${value.label}`}
                    onClick={() =>
                      setRenaming({
                        kind: 'value',
                        attribute,
                        valueId: value.id,
                        label: value.label,
                      })
                    }
                  >
                    {value.label}
                    <span className="ms-1 font-mono text-xs text-muted-foreground">
                      {value.code}
                    </span>
                  </Button>
                ) : (
                  <span
                    key={value.id}
                    className="rounded-xs bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                  >
                    {value.label}
                  </span>
                ),
              )}
            </div>
            <PermissionGate allowed={mayCreate}>
              <NewValue
                attributeId={attribute.id}
                position={attribute.values.length}
                onDone={onDone}
              />
            </PermissionGate>
          </li>
        ))}
      </ul>

      <PermissionGate allowed={mayCreate}>
        <div className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/50 p-4">
          <Field label={t('cs.setup.listName')}>
            <input
              value={name}
              maxLength={60}
              placeholder={t('cs.setup.listNameExample')}
              onChange={(event) => setName(event.target.value)}
              className={control}
            />
          </Field>
          <Field label={t('catalog.attributeKind')}>
            <Select
              value={kind}
              onValueChange={(value) => setKind(value as 'size' | 'colour' | 'custom')}
              className="min-w-36"
              options={[
                { value: 'size', label: t('catalog.kind.size') },
                { value: 'colour', label: t('catalog.kind.colour') },
                { value: 'custom', label: t('catalog.kind.custom') },
              ]}
            />
          </Field>
          <label className="flex h-control items-center gap-2 text-sm">
            <Checkbox checked={isVariant} onCheckedChange={(next) => setIsVariant(next === true)} />
            {t('catalog.isVariant')}
          </label>
          <Button
            size="sm"
            disabled={name.trim() === '' || create.isPending}
            onClick={() => create.mutate()}
          >
            {t('cs.setup.addList')}
          </Button>
          <p className="basis-full text-xs text-muted-foreground">{t('catalog.isVariantHelp')}</p>
          <Problem error={create.error} />
        </div>
      </PermissionGate>

      {renaming === null ? null : (
        <Rename
          key={renaming.kind === 'list' ? renaming.attribute.id : renaming.valueId}
          title={renaming.kind === 'list' ? t('cs.setup.renameList') : t('cs.setup.renameValue')}
          initial={renaming.kind === 'list' ? renaming.attribute.name : renaming.label}
          maxLength={60}
          onClose={() => setRenaming(null)}
          onSave={async (next) => {
            if (renaming.kind === 'list') {
              await updateAttribute(renaming.attribute.id, { name: next });
            } else {
              await updateAttributeValue(renaming.attribute.id, renaming.valueId, { label: next });
            }
            onDone();
          }}
        />
      )}
    </section>
  );
}

function NewValue({
  attributeId,
  position,
  onDone,
}: {
  readonly attributeId: string;
  /** Last in the list, so S, M, L, XL read in the order they were typed. */
  readonly position: number;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [label, setLabel] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const suggested = code ?? codeFrom(label, 8);

  const create = useMutation({
    mutationFn: () =>
      createAttributeValue(attributeId, { code: suggested, label: label.trim(), position }),
    onSuccess: () => {
      setLabel('');
      setCode(null);
      onDone();
    },
  });

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label={t('cs.setup.newValue')}>
        <input
          value={label}
          maxLength={60}
          onChange={(event) => setLabel(event.target.value)}
          className={`${control} w-36`}
        />
      </Field>
      <Field label={t('cs.setup.code')}>
        <input
          value={suggested}
          maxLength={8}
          onChange={(event) => setCode(event.target.value.toUpperCase())}
          className={`${control} w-24 font-mono uppercase`}
        />
      </Field>
      <Button
        size="sm"
        variant="outline"
        disabled={label.trim() === '' || !/^[A-Z0-9]{1,8}$/.test(suggested) || create.isPending}
        onClick={() => create.mutate()}
      >
        {t('cs.add')}
      </Button>
      <Problem error={create.error} />
    </div>
  );
}

function Rename({
  title,
  initial,
  maxLength,
  onClose,
  onSave,
}: {
  readonly title: string;
  readonly initial: string;
  readonly maxLength: number;
  readonly onClose: () => void;
  readonly onSave: (next: string) => Promise<void>;
}) {
  const t = useT();
  const [value, setValue] = useState(initial);
  const save = useMutation({
    mutationFn: () => onSave(value.trim()),
    onSuccess: onClose,
  });
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={title}
      description={t('cs.setup.codeFixed')}
      closeLabel={t('cs.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cs.cancel')}
          </Button>
          <Button disabled={value.trim() === '' || save.isPending} onClick={() => save.mutate()}>
            {t('cs.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('cs.setup.name')}>
          <input
            value={value}
            maxLength={maxLength}
            onChange={(event) => setValue(event.target.value)}
            className={control}
          />
        </Field>
        <Problem error={save.error} />
      </div>
    </Dialog>
  );
}

// --- locations --------------------------------------------------------------------

function Locations({
  items,
  mayCreate,
  mayUpdate,
  onDone,
}: {
  readonly items: readonly StockLocation[];
  readonly mayCreate: boolean;
  readonly mayUpdate: boolean;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'warehouse' | 'showroom'>('showroom');
  const [branchId, setBranchId] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [editing, setEditing] = useState<StockLocation | null>(null);
  const suggested = code ?? codeFrom(name, 12);

  const branches = useQuery({
    queryKey: ['hr', 'branch-options'],
    queryFn: listBranchOptions,
    enabled: mayCreate,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const branchList = branches.data?.items ?? [];
  const chosenBranch = branchId !== '' ? branchId : (branchList[0]?.id ?? '');

  const create = useMutation({
    mutationFn: () =>
      createLocation({
        code: suggested,
        name: name.trim(),
        kind,
        ...(kind === 'showroom' ? { branchId: chosenBranch } : {}),
      }),
    onSuccess: () => {
      setName('');
      setCode(null);
      onDone();
    },
  });

  // Every kind, in-transit included, so a switched-off one can be switched back on
  // (ledger audit L2).
  const shown = items;

  return (
    <section
      aria-labelledby="locations-heading"
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <h2 id="locations-heading" className="text-base font-semibold tracking-tight">
        {t('cs.setup.locations')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('cs.setup.locationsHelp')}</p>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {shown.map((location) => (
          <li key={location.id} className="flex min-h-row items-center gap-3 px-4 py-1.5 text-sm">
            <span className="font-medium">{location.name}</span>
            <span className="text-xs text-muted-foreground tabular-nums">{location.code}</span>
            <StatusBadge tone="neutral">{t(`cs.locationKind.${location.kind}`)}</StatusBadge>
            {location.isActive ? null : (
              <StatusBadge tone="neutral">{t('cs.inactive')}</StatusBadge>
            )}
            <span className="flex-1" />
            <PermissionGate allowed={mayUpdate}>
              <Button size="sm" variant="ghost" onClick={() => setEditing(location)}>
                {t('cs.edit')}
              </Button>
            </PermissionGate>
          </li>
        ))}
      </ul>

      <PermissionGate allowed={mayCreate}>
        <div className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/50 p-4">
          <Field label={t('cs.setup.locationName')}>
            <input
              value={name}
              maxLength={120}
              placeholder={t('cs.setup.locationExample')}
              onChange={(event) => setName(event.target.value)}
              className={control}
            />
          </Field>
          <Field label={t('cs.setup.locationKind')}>
            <Select
              value={kind}
              onValueChange={(value) => setKind(value as 'warehouse' | 'showroom')}
              className="min-w-36"
              options={[
                { value: 'showroom', label: t('cs.locationKind.showroom') },
                { value: 'warehouse', label: t('cs.locationKind.warehouse') },
              ]}
            />
          </Field>
          {kind === 'showroom' ? (
            <Field label={t('cs.setup.branch')}>
              <Select
                value={chosenBranch}
                onValueChange={setBranchId}
                className="min-w-44"
                options={branchList.map((branch) => ({ value: branch.id, label: branch.name }))}
              />
            </Field>
          ) : null}
          <Field label={t('cs.setup.code')}>
            <input
              value={suggested}
              maxLength={16}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              className={`${control} w-28 font-mono uppercase`}
            />
          </Field>
          <Button
            size="sm"
            disabled={
              name.trim() === '' ||
              !/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(suggested) ||
              (kind === 'showroom' && chosenBranch === '') ||
              create.isPending
            }
            onClick={() => create.mutate()}
          >
            {t('cs.setup.addLocation')}
          </Button>
          <Problem error={create.error} />
        </div>
      </PermissionGate>

      {editing === null ? null : (
        <EditLocation
          key={editing.id}
          location={editing}
          onClose={() => setEditing(null)}
          onDone={onDone}
        />
      )}
    </section>
  );
}

function EditLocation({
  location,
  onClose,
  onDone,
}: {
  readonly location: StockLocation;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(location.name);
  const [active, setActive] = useState(location.isActive);
  const save = useMutation({
    mutationFn: () => updateLocation(location.id, { name: name.trim(), isActive: active }),
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
      title={t('cs.setup.editLocation')}
      description={t('cs.setup.codeFixed')}
      closeLabel={t('cs.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cs.cancel')}
          </Button>
          <Button disabled={name.trim() === '' || save.isPending} onClick={() => save.mutate()}>
            {t('cs.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('cs.setup.locationName')}>
          <input
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            className={control}
          />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={active} onCheckedChange={(next) => setActive(next === true)} />
          {t('cs.setup.inUse')}
        </label>
        <Problem error={save.error} />
      </div>
    </Dialog>
  );
}
