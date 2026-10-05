import { Button, Money, cn, controlClassName, poishaToTaka, takaToPoisha } from '@elysium/ui';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/catalog-pricing.js';
import type { CatalogAttribute, CatalogProduct } from './api.js';
import { setStandardCosts, type SkuCost } from './pricing-api.js';
import { positiveCost } from './variant-grid.js';
import { variantLabel } from './variant-table.js';

/**
 * A product's buying prices (M39b, D-637, D-638), for a role that may read cost and update
 * supply: each variant's average cost and last buying price, and its **standard buying price**
 * (for any supplier), which fills the next receipt of that variant.
 *
 * The standard price lives in the supply module (`supply.sku_purchase_prices`), never on the
 * catalog's variant (invariant 5): this section reads and writes it through `/v1/supply/*`,
 * and the page renders it only for a role the server would send it to anyway. A per-supplier
 * standard and the whole brand at once are on Supply → Buying prices (the spreadsheet).
 */
export function BuyingPrices({
  product,
  attributes,
  costs,
  onDone,
}: {
  readonly product: CatalogProduct;
  readonly attributes: readonly CatalogAttribute[];
  readonly costs: ReadonlyMap<string, SkuCost>;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [fill, setFill] = useState('');
  const [saved, setSaved] = useState(false);
  const kinds = new Map(attributes.map((attribute) => [attribute.id, attribute.kind]));
  const skus = product.skus.filter((sku) => sku.status === 'active');

  const current = (skuId: string) => costs.get(skuId)?.standardUnitCostPoisha ?? null;
  const typed = (skuId: string) => {
    const text = texts[skuId];
    if (text === undefined) return { changed: false, poisha: current(skuId), invalid: false };
    const trimmed = text.trim();
    if (trimmed === '') return { changed: current(skuId) !== null, poisha: null, invalid: false };
    const value = positiveCost(takaToPoisha(trimmed));
    const valid = value !== null && /^[1-9]\d*$/.test(value);
    return {
      changed: valid && value !== current(skuId),
      poisha: valid ? value : null,
      invalid: !valid,
    };
  };
  const entries = skus.flatMap((sku) => {
    const entry = typed(sku.id);
    return entry.changed && !entry.invalid
      ? [{ skuId: sku.id, supplierId: null, standardUnitCostPoisha: entry.poisha }]
      : [];
  });
  const invalid = skus.some((sku) => typed(sku.id).invalid);

  const save = useMutation({
    mutationFn: () => setStandardCosts(entries),
    onSuccess: () => {
      setTexts({});
      setSaved(true);
      onDone();
    },
  });

  const box = cn(controlClassName, 'h-control-sm w-28 text-right tabular-nums');
  const th = 'h-10 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground';

  return (
    <section
      aria-labelledby="buying-heading"
      className="space-y-3 rounded-lg border border-border bg-card p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="buying-heading" className="text-base font-semibold tracking-tight">
          {t('cp.buy.title')}
        </h2>
        <Link
          to="/supply/buying-prices"
          className="rounded-sm text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {t('cp.buy.spreadsheet')}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t('cp.buy.help')}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs">
          <span className="font-medium">{t('cp.buy.fillAll')}</span>
          <input
            inputMode="decimal"
            value={fill}
            onChange={(event) => setFill(event.target.value)}
            className={box}
          />
        </label>
        <Button
          size="sm"
          variant="outline"
          disabled={fill.trim() === ''}
          onClick={() => setTexts(Object.fromEntries(skus.map((sku) => [sku.id, fill])))}
        >
          {t('cp.buy.fill')}
        </Button>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('cp.buy.title')}</caption>
          <thead>
            <tr className="border-b border-border bg-muted/50 text-left">
              <th scope="col" className={th}>
                {t('cs.col.variant')}
              </th>
              <th scope="col" className={cn(th, 'text-right')}>
                {t('cp.col.avgCost')}
              </th>
              <th scope="col" className={th}>
                {t('cp.col.lastCost')}
              </th>
              <th scope="col" className={cn(th, 'text-right')}>
                {t('cp.col.standardCost')}
              </th>
            </tr>
          </thead>
          <tbody>
            {skus.map((sku) => {
              const cost = costs.get(sku.id);
              const label = variantLabel(sku, kinds) || sku.skuCode;
              const standard = current(sku.id);
              return (
                <tr key={sku.id} className="border-b border-border last:border-b-0">
                  <td className="h-row px-3 font-medium whitespace-nowrap">{label}</td>
                  <td className="h-row px-3 text-right whitespace-nowrap">
                    {cost?.wacPoisha == null ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <Money poisha={cost.wacPoisha} />
                    )}
                  </td>
                  <td className="h-row px-3 whitespace-nowrap">
                    {cost?.lastUnitCostPoisha == null ? (
                      <span className="text-muted-foreground">{t('cp.buy.never')}</span>
                    ) : (
                      <span className="tabular-nums">
                        <Money poisha={cost.lastUnitCostPoisha} />
                        <span className="ms-2 text-xs text-muted-foreground">
                          {[
                            cost.lastReceivedOn ?? '',
                            cost.lastSupplierName === null
                              ? ''
                              : `${t('cp.buy.lastFrom')} ${cost.lastSupplierName}`,
                          ]
                            .filter((part) => part !== '')
                            .join(' · ')}
                        </span>
                      </span>
                    )}
                  </td>
                  <td className="h-row px-3 text-right">
                    <input
                      inputMode="decimal"
                      aria-label={`${t('cp.col.standardCost')} ${label}`}
                      data-testid={`standard-${label}`}
                      value={texts[sku.id] ?? (standard === null ? '' : poishaToTaka(standard))}
                      aria-invalid={typed(sku.id).invalid}
                      onChange={(event) => {
                        setSaved(false);
                        setTexts((state) => ({ ...state, [sku.id]: event.target.value }));
                      }}
                      className={box}
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          size="sm"
          data-testid="save-buying-prices"
          disabled={entries.length === 0 || invalid || save.isPending}
          onClick={() => save.mutate()}
        >
          {t('cp.save')}
        </Button>
        {saved ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('cp.buy.saved')}
          </p>
        ) : null}
        {save.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : t('cp.saveFailed')}
          </p>
        ) : null}
      </div>
    </section>
  );
}
