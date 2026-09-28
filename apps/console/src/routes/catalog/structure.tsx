import { Button, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { useAbility } from '../../auth/session.js';
import {
  createAttribute,
  createAttributeValue,
  createCategory,
  listAttributes,
  listCategories,
} from './api.js';
import { useCatalogT } from './messages.js';
import { slugify } from './slug.js';

/**
 * Categories and attributes (M06 Build list: "categories and attributes").
 *
 * One screen for both, because they are the same job: setting up the vocabulary a
 * product is described in. Splitting them into two routes would mean an operator
 * adding "XXXL" has to remember which of two screens attributes live on.
 *
 * Two things this screen states rather than hides, because both are decisions the
 * operator cannot undo:
 *
 * - A **code** goes inside every SKU code built under it. It is upper-case with no
 *   dashes (the dash is the SKU pattern's separator, §8), and it cannot be changed
 *   afterwards — every code already printed on a label contains it as a stored
 *   string. The field's help text says so, because an operator who thinks it is a
 *   display label will type `Men's shirts`.
 * - **"Creates separate SKUs"** is what makes an attribute an axis of the matrix.
 *   Off for something that describes a product without multiplying it, such as
 *   fabric. On by mistake, it turns one product into fifteen.
 */
export function CatalogStructurePage() {
  const ability = useAbility();
  const ct = useCatalogT();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Catalog');
  const mayWrite = ability.can('create', 'Catalog');

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

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: ct('catalog.deniedTitle'), detail: ct('catalog.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{ct('catalog.structure')}</h1>
        </header>

        <section aria-labelledby="categories-heading" className="space-y-3">
          <h2 id="categories-heading" className="text-sm font-semibold">
            {ct('catalog.categories')}
          </h2>
          <ul className="divide-y divide-border rounded-md border border-border">
            {(categories.data?.items ?? []).map((category) => (
              <li key={category.id} className="flex h-9 items-center gap-3 px-3 text-sm">
                {/*
                  The tree's shape as indentation, from the maintained `path`.
                  A spacer element rather than an inline padding style: the frontend
                  rules ban inline styles because a hard-coded length is a value that
                  did not come from the tokens in packages/ui, and the depth is
                  bounded at four by the database's own CHECK.
                */}
                <span
                  aria-hidden
                  className={['w-0', 'w-4', 'w-8', 'w-12'][Math.min(category.depth, 3)] ?? 'w-0'}
                />
                <span className="font-medium">{category.name}</span>
                <span className="font-mono text-xs text-muted-foreground">{category.code}</span>
                <span className="flex-1 truncate text-xs text-muted-foreground">
                  {category.path}
                </span>
                {!category.isActive && (
                  <StatusBadge tone="neutral">{ct('catalog.status.archived')}</StatusBadge>
                )}
              </li>
            ))}
          </ul>

          <PermissionGate allowed={mayWrite}>
            <NewCategory
              parents={(categories.data?.items ?? []).map((category) => ({
                id: category.id,
                name: category.name,
                depth: category.depth,
              }))}
              onDone={() =>
                void queryClient.invalidateQueries({ queryKey: ['catalog', 'categories'] })
              }
            />
          </PermissionGate>
        </section>

        <section aria-labelledby="attributes-heading" className="space-y-3">
          <h2 id="attributes-heading" className="text-sm font-semibold">
            {ct('catalog.attributes')}
          </h2>
          <ul className="space-y-2">
            {(attributes.data?.items ?? []).map((attribute) => (
              <li key={attribute.id} className="rounded-md border border-border p-3">
                <div className="flex items-center gap-3 text-sm">
                  <span className="font-medium">{attribute.name}</span>
                  <span className="font-mono text-xs text-muted-foreground">{attribute.code}</span>
                  <StatusBadge tone={attribute.isVariant ? 'info' : 'neutral'}>
                    {attribute.isVariant ? ct('catalog.isVariant') : ct('catalog.kind.custom')}
                  </StatusBadge>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {attribute.values.map((value) => (
                    <span
                      key={value.id}
                      className="rounded border border-border px-1.5 py-0.5 text-xs"
                    >
                      {value.label}
                      <span className="ms-1 font-mono text-muted-foreground">{value.code}</span>
                    </span>
                  ))}
                </div>
                <PermissionGate allowed={mayWrite}>
                  <NewValue
                    attributeId={attribute.id}
                    onDone={() =>
                      void queryClient.invalidateQueries({ queryKey: ['catalog', 'attributes'] })
                    }
                  />
                </PermissionGate>
              </li>
            ))}
          </ul>

          <PermissionGate allowed={mayWrite}>
            <NewAttribute
              onDone={() =>
                void queryClient.invalidateQueries({ queryKey: ['catalog', 'attributes'] })
              }
            />
          </PermissionGate>
        </section>
      </div>
    </PermissionGate>
  );
}

const field =
  'h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

function NewCategory({
  parents,
  onDone,
}: {
  readonly parents: readonly { id: string; name: string; depth: number }[];
  readonly onDone: () => void;
}) {
  const ct = useCatalogT();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [parentId, setParentId] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      createCategory({
        name,
        // The slug is derived rather than asked for: it is a web address, it has a
        // strict shape, and asking an operator for one produces `Men's Shirts`.
        slug: slugify(name),
        code: code.toUpperCase(),
        parentId: parentId === '' ? undefined : parentId,
      }),
    onSuccess: () => {
      setName('');
      setCode('');
      onDone();
    },
  });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs font-medium">
        {ct('catalog.productName')}
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${field} w-48`} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        {ct('catalog.code')}
        <input
          value={code}
          maxLength={8}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          aria-describedby="category-code-hint"
          className={`${field} w-24 font-mono uppercase`}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        {ct('catalog.parent')}
        <select value={parentId} onChange={(e) => setParentId(e.target.value)} className={field}>
          <option value="">{ct('catalog.noParent')}</option>
          {parents.map((parent) => (
            <option key={parent.id} value={parent.id}>
              {' '.repeat(parent.depth * 2)}
              {parent.name}
            </option>
          ))}
        </select>
      </label>
      <Button
        size="sm"
        disabled={name === '' || code === '' || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {ct('catalog.newCategory')}
      </Button>
      <p id="category-code-hint" className="basis-full text-xs text-muted-foreground">
        {ct('catalog.codeHelp')}
      </p>
    </div>
  );
}

function NewAttribute({ onDone }: { readonly onDone: () => void }) {
  const ct = useCatalogT();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<'size' | 'colour' | 'custom'>('custom');
  const [isVariant, setIsVariant] = useState(true);

  const mutation = useMutation({
    mutationFn: () => createAttribute({ code: code.toUpperCase(), name, kind, isVariant }),
    onSuccess: () => {
      setName('');
      setCode('');
      onDone();
    },
  });

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1 text-xs font-medium">
        {ct('catalog.productName')}
        <input value={name} onChange={(e) => setName(e.target.value)} className={`${field} w-48`} />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        {ct('catalog.code')}
        <input
          value={code}
          maxLength={32}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          className={`${field} w-32 font-mono uppercase`}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        {ct('catalog.attributeKind')}
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'size' | 'colour' | 'custom')}
          className={field}
        >
          <option value="colour">{ct('catalog.kind.colour')}</option>
          <option value="size">{ct('catalog.kind.size')}</option>
          <option value="custom">{ct('catalog.kind.custom')}</option>
        </select>
      </label>
      <label className="flex items-center gap-1.5 pb-1 text-sm">
        <input
          type="checkbox"
          checked={isVariant}
          onChange={(e) => setIsVariant(e.target.checked)}
          aria-describedby="is-variant-hint"
          className="h-4 w-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
        />
        {ct('catalog.isVariant')}
      </label>
      <Button
        size="sm"
        disabled={name === '' || code === '' || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {ct('catalog.newAttribute')}
      </Button>
      <p id="is-variant-hint" className="basis-full text-xs text-muted-foreground">
        {ct('catalog.isVariantHelp')}
      </p>
    </div>
  );
}

function NewValue({
  attributeId,
  onDone,
}: {
  readonly attributeId: string;
  readonly onDone: () => void;
}) {
  const ct = useCatalogT();
  const [label, setLabel] = useState('');
  const [code, setCode] = useState('');

  const mutation = useMutation({
    mutationFn: () => createAttributeValue(attributeId, { code: code.toUpperCase(), label }),
    onSuccess: () => {
      setLabel('');
      setCode('');
      onDone();
    },
  });

  return (
    <div className="mt-2 flex items-end gap-2">
      <label className="flex flex-col gap-1 text-xs font-medium">
        {ct('catalog.label')}
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          className={`${field} w-36`}
        />
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium">
        {ct('catalog.code')}
        <input
          value={code}
          maxLength={8}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          className={`${field} w-20 font-mono uppercase`}
        />
      </label>
      <Button
        size="sm"
        variant="outline"
        disabled={label === '' || code === '' || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {ct('catalog.newValue')}
      </Button>
    </div>
  );
}
