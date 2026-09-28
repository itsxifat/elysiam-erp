import { Button, PermissionGate, takaToPoisha } from '@elysium/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { DEFAULT_PAGE_SIZE } from '../../lib/table-search.js';
import { createProduct, listCategories } from './api.js';
import { useCatalogT } from './messages.js';
import { slugify } from './slug.js';

/**
 * Create a product (M06 Build list: "product create/edit with a variant matrix
 * generator").
 *
 * It creates the product **without SKUs** and then sends the operator to the
 * detail screen, where the matrix generator lives. That two-step flow is D-121 made
 * visible: a product may exist with no SKUs, because somebody naming a product and
 * picking its category has not yet decided what colours it comes in, and the
 * alternatives are both worse — a wizard that cannot save halfway, or a placeholder
 * SKU nobody asked for that then has to be archived.
 *
 * The price asked for here is the one every generated SKU will start at, entered in
 * **taka** and converted by `takaToPoisha`, which is integer arithmetic. A
 * `parseFloat(taka) * 100` is 1998.9999999999998 for 19.99 and is banned by the
 * `elysium/no-float-money` lint rule (D-090).
 */
export function CatalogNewProductPage() {
  const ability = useAbility();
  const ct = useCatalogT();
  const navigate = useNavigate();

  const mayWrite = ability.can('create', 'Catalog');

  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [taka, setTaka] = useState('');
  const [status, setStatus] = useState<'draft' | 'active'>('draft');

  const categories = useQuery({
    queryKey: ['catalog', 'categories'],
    queryFn: listCategories,
    enabled: mayWrite,
    staleTime: 5 * 60_000,
  });

  /*
   * `takaToPoisha` returns null for anything that is not taka with up to two
   * decimals — it refuses rather than rounding, because whoever typed `1.005` has
   * already lost precision and rounding here would hide where. So the button is
   * disabled until it parses, and this is the second gate rather than the first.
   */
  const pricePoisha = takaToPoisha(taka);

  const mutation = useMutation({
    mutationFn: () =>
      createProduct({
        name,
        // Derived, not asked for: a slug is a web address with a strict shape, and
        // asking an operator for one produces `Men's Shirt (new)`.
        slug: slugify(name),
        categoryId: categoryId === '' ? undefined : categoryId,
        pricePoisha: pricePoisha ?? '',
        status,
      }),
    onSuccess: (product) =>
      void navigate({ to: '/catalog/$productId', params: { productId: product.id } }),
  });

  const field =
    'h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <PermissionGate
      allowed={mayWrite}
      explain={{ title: ct('catalog.deniedTitle'), detail: ct('catalog.deniedDetail') }}
    >
      <div className="max-w-xl space-y-5">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{ct('catalog.newProduct')}</h1>
          <p className="text-sm text-muted-foreground">{ct('catalog.addVariantsHelp')}</p>
        </header>

        <div className="space-y-3">
          <label className="flex flex-col gap-1 text-xs font-medium">
            {ct('catalog.productName')}
            <input
              value={name}
              maxLength={200}
              onChange={(event) => setName(event.target.value)}
              className={field}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium">
            {ct('catalog.productCategory')}
            <select
              value={categoryId}
              onChange={(event) => setCategoryId(event.target.value)}
              className={field}
            >
              <option value="">{ct('catalog.noParent')}</option>
              {(categories.data?.items ?? []).map((category) => (
                <option key={category.id} value={category.id}>
                  {' '.repeat(category.depth * 2)}
                  {category.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium">
            {ct('catalog.productPrice')}
            <input
              inputMode="decimal"
              value={taka}
              onChange={(event) => setTaka(event.target.value)}
              className={`${field} w-32 text-right tabular-nums`}
            />
          </label>

          <label className="flex flex-col gap-1 text-xs font-medium">
            {ct('catalog.productStatus')}
            <select
              value={status}
              onChange={(event) => setStatus(event.target.value as 'draft' | 'active')}
              className={field}
            >
              <option value="draft">{ct('catalog.status.draft')}</option>
              <option value="active">{ct('catalog.status.active')}</option>
            </select>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            disabled={name === '' || pricePoisha === null || mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            {ct('catalog.create')}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              void navigate({ to: '/catalog', search: { page: 1, pageSize: DEFAULT_PAGE_SIZE } })
            }
          >
            {ct('catalog.cancel')}
          </Button>
        </div>
      </div>
    </PermissionGate>
  );
}
