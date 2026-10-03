import { Button, Dialog, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
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
      <div className="max-w-4xl space-y-8">
        <nav aria-label={t('cs.breadcrumb')} className="text-xs text-muted-foreground">
          <Link
            to="/catalog"
            search={{ page: 1, pageSize: DEFAULT_PAGE_SIZE }}
            className="underline-offset-4 hover:underline"
          >
            {t('catalog.title')}
          </Link>
        </nav>
        <header className="space-y-1">
          <h1 className="text-lg font-semibold tracking-tight">{t('cs.setup.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('cs.setup.help')}</p>
        </header>

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

const control =
  'h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

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
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
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
    <section aria-labelledby="categories-heading" className="space-y-3">
      <h2 id="categories-heading" className="text-sm font-semibold">
        {t('catalog.categories')}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('cs.setup.noCategories')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {items.map((category) => (
            <li key={category.id} className="flex min-h-9 items-center gap-3 px-3 py-1 text-sm">
              <span
                aria-hidden
                className={['w-0', 'w-4', 'w-8', 'w-12'][Math.min(category.depth, 3)] ?? 'w-0'}
              />
              <span className="font-medium">{category.name}</span>
              <span className="font-mono text-xs text-muted-foreground">{category.code}</span>
              {category.isActive ? null : (
                <StatusBadge tone="neutral">{t('cs.inactive')}</StatusBadge>
              )}
              <span className="flex-1" />
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
        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
          <Field label={t('cs.setup.categoryName')}>
            <input
              value={name}
              maxLength={120}
              onChange={(event) => setName(event.target.value)}
              className={control}
            />
          </Field>
          <Field label={t('cs.setup.parent')}>
            <select
              value={parentId}
              onChange={(event) => setParentId(event.target.value)}
              className={control}
            >
              <option value="">{t('cs.setup.topLevel')}</option>
              {items
                .filter((category) => category.depth < 3)
                .map((category) => (
                  <option key={category.id} value={category.id}>
                    {'  '.repeat(category.depth)}
                    {category.name}
                  </option>
                ))}
            </select>
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
          <select
            value={parentId}
            onChange={(event) => setParentId(event.target.value)}
            className={control}
          >
            <option value="">{t('cs.setup.topLevel')}</option>
            {choosable.map((other) => (
              <option key={other.id} value={other.id}>
                {'  '.repeat(other.depth)}
                {other.name}
              </option>
            ))}
          </select>
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            className="size-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
          />
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
    <section aria-labelledby="lists-heading" className="space-y-3">
      <h2 id="lists-heading" className="text-sm font-semibold">
        {t('cs.setup.lists')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('cs.setup.listsHelp')}</p>

      <ul className="space-y-3">
        {items.map((attribute) => (
          <li key={attribute.id} className="space-y-2 rounded-md border border-border p-3">
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
                    className="rounded border border-border px-1.5 py-0.5 text-xs"
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
        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
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
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as 'size' | 'colour' | 'custom')}
              className={control}
            >
              <option value="size">{t('catalog.kind.size')}</option>
              <option value="colour">{t('catalog.kind.colour')}</option>
              <option value="custom">{t('catalog.kind.custom')}</option>
            </select>
          </Field>
          <label className="flex items-center gap-1.5 pb-1 text-sm">
            <input
              type="checkbox"
              checked={isVariant}
              onChange={(event) => setIsVariant(event.target.checked)}
              className="size-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
            />
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
    <section aria-labelledby="locations-heading" className="space-y-3">
      <h2 id="locations-heading" className="text-sm font-semibold">
        {t('cs.setup.locations')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('cs.setup.locationsHelp')}</p>
      <ul className="divide-y divide-border rounded-md border border-border">
        {shown.map((location) => (
          <li key={location.id} className="flex min-h-9 items-center gap-3 px-3 py-1 text-sm">
            <span className="font-medium">{location.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{location.code}</span>
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
        <div className="flex flex-wrap items-end gap-3 rounded-md border border-border p-3">
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
            <select
              value={kind}
              onChange={(event) => setKind(event.target.value as 'warehouse' | 'showroom')}
              className={control}
            >
              <option value="showroom">{t('cs.locationKind.showroom')}</option>
              <option value="warehouse">{t('cs.locationKind.warehouse')}</option>
            </select>
          </Field>
          {kind === 'showroom' ? (
            <Field label={t('cs.setup.branch')}>
              <select
                value={chosenBranch}
                onChange={(event) => setBranchId(event.target.value)}
                className={control}
              >
                {branchList.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </select>
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
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
            className="size-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
          />
          {t('cs.setup.inUse')}
        </label>
        <Problem error={save.error} />
      </div>
    </Dialog>
  );
}
