import { attributeKindRank, mostCommonPrice, newVariantPrice } from '@elysium/domain/pricing';
import { Button, Checkbox, cn, controlClassName, poishaToTaka, takaToPoisha } from '@elysium/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/catalog-pricing.js';
import type { StockRow } from '../stock/api.js';
import type { CatalogAttribute, CatalogProduct } from './api.js';
import { ChipGroup, Field } from './parts.js';
import { extendVariants, setSkuStatuses } from './pricing-api.js';
import { planExtend, positivePrice, total, type ExistingVariant } from './variant-grid.js';
import { variantLabel } from './variant-table.js';

/**
 * Sizes and colours, after the product exists (M39b, D-639).
 *
 * The chips start at the values the product sells now. Ticking a value adds its variants:
 * the section lists each new one with the price it will start at (the same size's price in the
 * product's other colours, else the main price below: never the cheapest variant's and never
 * an archived one's, `newVariantPrice`) and lets the person change it before anything is saved.
 * Unticking a value stops selling it in every colour (its variants are archived together; the
 * server refuses while orders hold their pieces). Re-ticking an archived value sells it again.
 * A new axis on a product that had none (colours on a size-only shirt) offers to archive the
 * old variants that will not match.
 *
 * The axes go size first, then colour, then the rest, as on creation, and the server keeps the
 * product's own code order whatever order they are sent in.
 */
export function SizesAndColours({
  product,
  attributes,
  stock,
  onDone,
}: {
  readonly product: CatalogProduct | undefined;
  readonly attributes: readonly CatalogAttribute[];
  readonly stock: readonly StockRow[];
  readonly onDone: () => void;
}) {
  const t = useT();
  const [chosen, setChosen] = useState<Record<string, string[]> | null>(null);
  const [newPrices, setNewPrices] = useState<Record<string, string>>({});
  const [newRegulars, setNewRegulars] = useState<Record<string, string>>({});
  const [mainText, setMainText] = useState('');
  const [archiveOrphans, setArchiveOrphans] = useState(true);
  const [done, setDone] = useState(false);

  const skus = product?.skus ?? [];
  const kinds = new Map(attributes.map((attribute) => [attribute.id, attribute.kind]));
  // Every value names itself, archived or not: the product's own variants may carry one.
  const valueAxis = new Map<string, string>();
  const valueLabel = new Map<string, string>();
  for (const axis of attributes) {
    for (const value of axis.values) {
      valueAxis.set(value.id, axis.id);
      valueLabel.set(value.id, value.label);
    }
  }
  const used = new Set(skus.flatMap((sku) => sku.attributes.map((pair) => pair.valueId)));
  // A new variant is offered only live lists and values (M39a, D-624); an archived one the
  // product already sells stays as a chip, so it can still be unticked.
  const axes = attributes
    .filter((axis) => axis.isVariant)
    .map((axis) => ({
      ...axis,
      values: axis.values.filter(
        (value) => (axis.isActive !== false && value.isActive !== false) || used.has(value.id),
      ),
    }))
    .filter((axis) => axis.values.length > 0)
    .sort(
      (a, b) =>
        attributeKindRank(a.kind) - attributeKindRank(b.kind) ||
        a.position - b.position ||
        (a.code < b.code ? -1 : 1),
    );
  const existing: ExistingVariant[] = skus.map((sku) => ({
    id: sku.id,
    valueIds: sku.attributes.map((pair) => pair.valueId),
    status: sku.status,
    pricePoisha: sku.pricePoisha,
  }));
  // What the product sells now: the values of its active variants.
  const selling = (axis: CatalogAttribute) => [
    ...new Set(
      skus
        .filter((sku) => sku.status === 'active')
        .flatMap((sku) =>
          sku.attributes.filter((pair) => pair.attributeId === axis.id).map((pair) => pair.valueId),
        ),
    ),
  ];
  const current = (axis: CatalogAttribute) => chosen?.[axis.id] ?? selling(axis);
  const ticked = axes.map((axis) => ({ attributeId: axis.id, valueIds: current(axis) }));
  // Archived lists and values (M39a, D-624) go on no new variant.
  const archivedValues = new Set(
    attributes.flatMap((axis) =>
      axis.values
        .filter((value) => axis.isActive === false || value.isActive === false)
        .map((value) => value.id),
    ),
  );
  const plan = planExtend(existing, ticked, valueAxis, archivedValues);

  const active = existing.filter((variant) => variant.status === 'active');
  const defaultMain = mostCommonPrice(active.map((variant) => BigInt(variant.pricePoisha)));
  const mainPoisha =
    mainText.trim() === ''
      ? defaultMain
      : (() => {
          const typed = positivePrice(takaToPoisha(mainText));
          return typed === null ? null : BigInt(typed);
        })();
  const mainInvalid = mainText.trim() !== '' && positivePrice(takaToPoisha(mainText)) === null;
  const sizeValues = new Set(
    attributes
      .filter((axis) => axis.kind === 'size')
      .flatMap((axis) => axis.values.map((v) => v.id)),
  );
  const startPrice = (valueIds: readonly string[]): string | null => {
    const price = newVariantPrice(
      valueIds,
      sizeValues,
      existing.map((variant) => ({
        valueIds: variant.valueIds,
        pricePoisha: BigInt(variant.pricePoisha),
        active: variant.status === 'active',
      })),
      mainPoisha,
    );
    return price === null ? null : price.toString();
  };
  const labelOf = (valueIds: readonly string[]) =>
    [...valueIds]
      .sort(
        (a, b) =>
          attributeKindRank(kinds.get(valueAxis.get(a) ?? '') ?? 'custom') -
          attributeKindRank(kinds.get(valueAxis.get(b) ?? '') ?? 'custom'),
      )
      .map((id) => valueLabel.get(id) ?? id)
      .join(' / ');
  const priceOf = (key: string, valueIds: readonly string[]) => {
    const typed = (newPrices[key] ?? '').trim();
    return typed === '' ? startPrice(valueIds) : positivePrice(takaToPoisha(typed));
  };
  const regularOf = (key: string) => {
    const typed = (newRegulars[key] ?? '').trim();
    return typed === '' ? null : positivePrice(takaToPoisha(typed));
  };
  const addProblem = plan.add.some((row) => {
    const price = priceOf(row.key, row.valueIds);
    const regularText = (newRegulars[row.key] ?? '').trim();
    const regular = regularOf(row.key);
    if (price === null) return true;
    if (regularText !== '' && (regular === null || BigInt(regular) <= BigInt(price))) return true;
    return false;
  });
  const piecesOf = (skuId: string) =>
    total(stock.filter((row) => row.skuId === skuId).map((row) => row.onHand));
  const describe = (ids: readonly string[]) =>
    ids.map((id) => {
      const sku = skus.find((entry) => entry.id === id);
      return {
        id,
        label: sku === undefined ? id : variantLabel(sku, kinds) || sku.skuCode,
        pieces: piecesOf(id),
      };
    });
  const toArchive = [...plan.archive, ...(archiveOrphans ? plan.orphans : [])];
  const nothing = plan.add.length === 0 && toArchive.length === 0 && plan.restore.length === 0;

  const save = useMutation({
    mutationFn: async () => {
      // Archive first: it is the step the server may refuse (orders holding pieces), and a
      // refusal should leave nothing half-done.
      if (toArchive.length > 0) await setSkuStatuses(toArchive, 'archived');
      if (plan.restore.length > 0) await setSkuStatuses(plan.restore, 'active');
      if (plan.add.length > 0 && product !== undefined) {
        await extendVariants(product.id, {
          // Only live values: the server builds the new variants from these axes, and an
          // archived value the product still sells stays on its own variants.
          axes: ticked
            .map((axis) => ({
              ...axis,
              valueIds: axis.valueIds.filter((id) => !archivedValues.has(id)),
            }))
            .filter((axis) => axis.valueIds.length > 0),
          ...(mainPoisha === null ? {} : { pricePoisha: mainPoisha.toString() }),
          variantPrices: plan.add.map((row) => {
            const regular = regularOf(row.key);
            return {
              valueIds: row.valueIds,
              pricePoisha: priceOf(row.key, row.valueIds) ?? '',
              ...(regular === null ? {} : { compareAtPoisha: regular }),
            };
          }),
        });
      }
    },
    onSuccess: () => {
      setChosen(null);
      setNewPrices({});
      setNewRegulars({});
      setDone(true);
      onDone();
    },
  });

  const box = cn(controlClassName, 'h-control-sm w-28 text-right tabular-nums');

  return (
    <section
      aria-labelledby="add-variants-heading"
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <h2 id="add-variants-heading" className="text-base font-semibold tracking-tight">
        {t('cp.extend.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('cp.extend.help')}</p>
      {axes.map((axis) => (
        <ChipGroup
          key={axis.id}
          legend={axis.name}
          values={axis.values}
          chosen={current(axis)}
          onToggle={(valueId) => {
            setDone(false);
            const list = current(axis);
            setChosen((state) => ({
              ...Object.fromEntries(axes.map((entry) => [entry.id, current(entry)])),
              ...(state ?? {}),
              [axis.id]: list.includes(valueId)
                ? list.filter((id) => id !== valueId)
                : [...list, valueId],
            }));
          }}
        />
      ))}

      {plan.add.length > 0 ? (
        <div className="space-y-3">
          <Field
            label={t('cp.extend.mainPrice')}
            hint={t('cp.extend.mainPriceHint')}
            className="max-w-xs"
          >
            <input
              inputMode="decimal"
              value={mainText}
              placeholder={defaultMain === null ? '' : poishaToTaka(defaultMain.toString())}
              aria-invalid={mainInvalid}
              onChange={(event) => setMainText(event.target.value)}
              className={cn(controlClassName, 'w-full text-right tabular-nums')}
            />
          </Field>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-sm">
              <caption className="px-3 py-2 text-left text-sm font-medium">
                {`${t('cp.extend.willAdd')} (${String(plan.add.length)})`}
              </caption>
              <thead>
                <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                  <th scope="col" className="h-9 px-3 font-medium">
                    {t('cs.col.variant')}
                  </th>
                  <th scope="col" className="h-9 px-3 text-right font-medium">
                    {t('cp.col.price')}
                  </th>
                  <th scope="col" className="h-9 px-3 text-right font-medium">
                    {t('cp.col.regular')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {plan.add.map((row) => {
                  const label = labelOf(row.valueIds);
                  const start = startPrice(row.valueIds);
                  return (
                    <tr key={row.key} className="border-b border-border last:border-b-0">
                      <td className="px-3 py-1.5 font-medium">{label}</td>
                      <td className="px-3 py-1.5 text-right">
                        <input
                          inputMode="decimal"
                          aria-label={`${t('cp.col.price')} ${label}`}
                          data-testid={`new-price-${label}`}
                          value={newPrices[row.key] ?? ''}
                          placeholder={start === null ? '' : poishaToTaka(start)}
                          aria-invalid={priceOf(row.key, row.valueIds) === null}
                          onChange={(event) =>
                            setNewPrices((state) => ({ ...state, [row.key]: event.target.value }))
                          }
                          className={box}
                        />
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <input
                          inputMode="decimal"
                          aria-label={`${t('cp.col.regular')} ${label}`}
                          value={newRegulars[row.key] ?? ''}
                          onChange={(event) =>
                            setNewRegulars((state) => ({
                              ...state,
                              [row.key]: event.target.value,
                            }))
                          }
                          className={box}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {plan.archive.length > 0 ? (
        <VariantList
          title={t('cp.extend.willArchive')}
          items={describe(plan.archive)}
          piecesLabel={t('cp.extend.pieces')}
        />
      ) : null}
      {plan.restore.length > 0 ? (
        <VariantList
          title={t('cp.extend.willRestore')}
          items={describe(plan.restore)}
          piecesLabel={t('cp.extend.pieces')}
        />
      ) : null}
      {plan.skipped > 0 ? (
        <p className="text-sm text-muted-foreground">
          {t('cp.extend.skippedArchived').replace('{n}', String(plan.skipped))}
        </p>
      ) : null}
      {plan.orphans.length > 0 && plan.add.length > 0 ? (
        <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
          <p className="text-sm">{t('cp.extend.orphans')}</p>
          <ul className="text-sm text-muted-foreground">
            {describe(plan.orphans).map((item) => (
              <li key={item.id}>
                {item.pieces > 0
                  ? `${item.label} · ${String(item.pieces)} ${t('cp.extend.pieces')}`
                  : item.label}
              </li>
            ))}
          </ul>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={archiveOrphans}
              onCheckedChange={(next) => setArchiveOrphans(next === true)}
            />
            {t('cp.extend.archiveOrphans')}
          </label>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          data-testid="save-sizes-colours"
          disabled={nothing || addProblem || mainInvalid || save.isPending}
          onClick={() => save.mutate()}
        >
          {t('cp.extend.submit')}
        </Button>
        {done ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('cp.extend.done')}
          </p>
        ) : chosen !== null && nothing ? (
          <p className="text-sm text-muted-foreground">{t('cp.extend.nothing')}</p>
        ) : null}
      </div>
      {save.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {save.error instanceof ApiError ? save.error.message : t('cp.saveFailed')}
        </p>
      ) : null}
    </section>
  );
}

function VariantList({
  title,
  items,
  piecesLabel,
}: {
  readonly title: string;
  readonly items: readonly { id: string; label: string; pieces: number }[];
  readonly piecesLabel: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{`${title} (${String(items.length)})`}</p>
      <ul className="text-sm text-muted-foreground">
        {items.map((item) => (
          <li key={item.id}>
            {item.pieces > 0 ? `${item.label} · ${String(item.pieces)} ${piecesLabel}` : item.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
