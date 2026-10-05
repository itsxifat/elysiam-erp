import {
  bpsPercentText,
  marginBps,
  percentTextToBps,
  planBulkPrices,
  type PriceField,
  type PriceRule,
  type PricePlan,
} from '@elysium/domain/pricing';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Money,
  PermissionGate,
  Select,
  StatusBadge,
  cn,
  controlClassName,
  poishaToTaka,
  takaToPoisha,
} from '@elysium/ui';
import { useMutation } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Pencil, Printer } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../../api.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/catalog-pricing.js';
import '../../i18n/stock-tools.js';
import type { StockRow } from '../stock/api.js';
import { updateSku, type CatalogAttribute, type CatalogProduct, type CatalogSku } from './api.js';
import { Field } from './parts.js';
import {
  saveVariantPrices,
  setSkuBarcode,
  setSkuWeight,
  type PriceChange,
  type SkuCost,
} from './pricing-api.js';
import { CopyCode, EanBars } from './stickers.js';
import { marginCost, parseGrams, positivePrice, total, variantLabel } from './variant-grid.js';

/**
 * The product page's variants and stock (D-420), with M39b's prices (D-636, D-640, D-644,
 * D-645): the selling price and the regular price of each variant, and, for a role that may
 * read cost, its average cost, last buying price and margin.
 *
 * **The margin is worked out here**, from the average cost (or the last buying price) the
 * supply module sends this role and the selling price the catalog sends everyone. No route
 * sends a margin, because a margin beside a price is a cost (invariant 5); a role without
 * `read:cost` has no cost to work from and sees no cost column at all.
 *
 * **Edit prices** turns every price and regular price into a box, and opens the bulk editor:
 * choose variants (rows, or every colour of a size, or every size of a colour), say what to do
 * (set, add, subtract, raise or lower by a percentage, round), preview it into the boxes, and
 * save every change in one request, with one reason the price history keeps (the server
 * writes a history row per change, D-636). The arithmetic is `@elysium/domain/pricing`'s, in
 * integer poisha, the same functions the server's tests hold to.
 */

export interface VariantTableProps {
  readonly product: CatalogProduct | undefined;
  readonly attributes: readonly CatalogAttribute[];
  readonly rows: readonly StockRow[];
  readonly locations: readonly { id: string; name: string; code: string; kind: string }[];
  readonly showStock: boolean;
  readonly mayWrite: boolean;
  /** Cost per variant, present only for a role that may read cost. */
  readonly costs: ReadonlyMap<string, SkuCost> | undefined;
  readonly highlighted?: string | undefined;
  readonly onReorder: () => void;
  readonly onPrint: (sku: CatalogSku) => void;
  readonly onDone: () => void;
}

type RuleKind = 'set' | 'add' | 'subtract' | 'up' | 'down';
const RULE_LABELS = {
  set: 'cp.hub.rule.set',
  add: 'cp.hub.rule.add',
  subtract: 'cp.hub.rule.subtract',
  up: 'cp.hub.rule.up',
  down: 'cp.hub.rule.down',
} as const;
const ROUNDS = ['0', '100', '500', '1000', '5000', '10000'] as const;

export { marginCost, variantLabel } from './variant-grid.js';

export function VariantTable({
  product,
  attributes,
  rows,
  locations,
  showStock,
  mayWrite,
  costs,
  highlighted,
  onReorder,
  onPrint,
  onDone,
}: VariantTableProps) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [prices, setPriceTexts] = useState<Record<string, string>>({});
  const [regulars, setRegularTexts] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [field, setField] = useState<PriceField>('price');
  const [ruleKind, setRuleKind] = useState<RuleKind>('up');
  const [amount, setAmount] = useState('');
  const [round, setRound] = useState<(typeof ROUNDS)[number]>('0');
  const [plan, setPlan] = useState<PricePlan | null>(null);
  const [reason, setReason] = useState('');
  const [archiving, setArchiving] = useState<CatalogSku | null>(null);
  const [editingSku, setEditingSku] = useState<CatalogSku | null>(null);
  const skus = product?.skus ?? [];
  const marked = useRef<HTMLTableRowElement>(null);
  const kinds = new Map(attributes.map((attribute) => [attribute.id, attribute.kind]));
  const showCost = costs !== undefined;

  // A scanned variant scrolls into view and takes focus, so the person sees which one it is.
  useEffect(() => {
    if (highlighted === undefined || product === undefined) return;
    marked.current?.scrollIntoView({ block: 'center' });
    marked.current?.focus();
  }, [highlighted, product]);

  // Every active warehouse, then every showroom, then anywhere else this product has
  // stock right now (in transit, damaged). An empty in-transit column is noise.
  const columns = [
    ...locations.filter((location) => location.kind === 'warehouse'),
    ...locations.filter((location) => location.kind !== 'warehouse'),
    ...rows
      .filter((row) => row.onHand > 0)
      .filter((row) => !locations.some((location) => location.id === row.locationId))
      .filter(
        (row, index, all) =>
          all.findIndex((other) => other.locationId === row.locationId) === index,
      )
      .map((row) => ({ id: row.locationId, name: row.locationName, code: row.locationCode })),
  ];
  const cell = (skuId: string, locationId: string) =>
    rows.find((row) => row.skuId === skuId && row.locationId === locationId);

  // What each box reads as now: the typed text when it is a price, else the saved figure.
  const typed = (text: string | undefined) => {
    if (text === undefined) return { set: false, poisha: null as string | null, invalid: false };
    const trimmed = text.trim();
    if (trimmed === '') return { set: true, poisha: null, invalid: false };
    const value = positivePrice(takaToPoisha(trimmed));
    return { set: true, poisha: value, invalid: value === null };
  };
  const priceNow = (sku: CatalogSku): string => {
    const entry = typed(prices[sku.id]);
    return entry.set && entry.poisha !== null ? entry.poisha : sku.pricePoisha;
  };
  const regularNow = (sku: CatalogSku): string | null => {
    const entry = typed(regulars[sku.id]);
    return entry.set ? entry.poisha : sku.compareAtPoisha;
  };
  const invalid = skus.some((sku) => {
    const price = typed(prices[sku.id]);
    const regular = typed(regulars[sku.id]);
    if (price.invalid || regular.invalid) return true;
    if (price.set && price.poisha === null) return true;
    const now = regularNow(sku);
    return now !== null && BigInt(now) <= BigInt(priceNow(sku));
  });
  const changes: PriceChange[] = skus.flatMap((sku) => {
    const price = priceNow(sku);
    const regular = regularNow(sku);
    const priceChanged = price !== sku.pricePoisha;
    const regularChanged = regular !== sku.compareAtPoisha;
    if (!priceChanged && !regularChanged) return [];
    return [
      {
        skuId: sku.id,
        ...(priceChanged ? { pricePoisha: price } : {}),
        ...(regularChanged ? { compareAtPoisha: regular } : {}),
      },
    ];
  });

  const stop = () => {
    setEditing(false);
    setPriceTexts({});
    setRegularTexts({});
    setSelected(new Set());
    setPlan(null);
    setReason('');
  };

  const save = useMutation({
    mutationFn: () =>
      saveVariantPrices({
        prices: changes,
        reason: reason.trim() === '' ? t('cp.hub.reasonDefault') : reason.trim(),
      }),
    onSuccess: () => {
      stop();
      onDone();
    },
  });

  const archive = useMutation({
    mutationFn: (sku: CatalogSku) =>
      updateSku(sku.id, sku.status === 'active' ? 'archived' : 'active'),
    onSuccess: onDone,
  });

  // The bulk editor's rule, from what was chosen and typed (D-636).
  const ruleOf = (): PriceRule | null => {
    const step = BigInt(round);
    const roundToPoisha = step === 0n ? undefined : step;
    if (ruleKind === 'up' || ruleKind === 'down') {
      const bps = percentTextToBps(amount);
      if (bps === null || bps < 0n) return null;
      return { kind: 'percent', basisPoints: ruleKind === 'up' ? bps : -bps, roundToPoisha };
    }
    const poisha = takaToPoisha(amount);
    if (poisha === null || poisha.startsWith('-')) return null;
    const value = BigInt(poisha);
    if (ruleKind === 'set') return { kind: 'set', amountPoisha: value, roundToPoisha };
    return {
      kind: 'add',
      amountPoisha: ruleKind === 'add' ? value : -value,
      roundToPoisha,
    };
  };
  const rule = ruleOf();

  const preview = () => {
    if (rule === null) return;
    const next = planBulkPrices(
      skus.map((sku) => {
        const regular = regularNow(sku);
        return {
          skuId: sku.id,
          pricePoisha: BigInt(priceNow(sku)),
          compareAtPoisha: regular === null ? null : BigInt(regular),
        };
      }),
      selected,
      rule,
      field,
    );
    setPlan(next);
    const write = field === 'price' ? setPriceTexts : setRegularTexts;
    write((current) => {
      const updated = { ...current };
      for (const change of next.changes) {
        updated[change.skuId] = poishaToTaka(change.toPoisha.toString());
      }
      return updated;
    });
  };

  // Every colour of a size, or every size of a colour (D-636).
  const valuesOf = (kind: 'size' | 'colour') => {
    const seen = new Map<string, string>();
    for (const sku of skus) {
      for (const pair of sku.attributes) {
        if (kinds.get(pair.attributeId) === kind) seen.set(pair.valueId, pair.valueLabel);
      }
    }
    return [...seen.entries()];
  };
  const chooseValue = (valueId: string) =>
    setSelected(
      new Set(
        skus
          .filter((sku) => sku.status === 'active')
          .filter((sku) => sku.attributes.some((pair) => pair.valueId === valueId))
          .map((sku) => sku.id),
      ),
    );
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const th = 'h-10 px-3 text-xs font-medium whitespace-nowrap text-muted-foreground';
  const box = cn(controlClassName, 'h-control-sm w-24 text-right tabular-nums');
  const problemWords: Record<string, string> = {
    'not-positive': t('cp.hub.problem.notPositive'),
    'too-large': t('cp.hub.problem.tooLarge'),
    'regular-not-above-price': t('cp.hub.problem.regular'),
  };
  const labelFor = (id: string) => {
    const sku = skus.find((entry) => entry.id === id);
    return sku === undefined ? id : variantLabel(sku, kinds) || sku.skuCode;
  };

  return (
    <section aria-labelledby="variants-heading" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="variants-heading" className="text-base font-semibold tracking-tight">
          {t('cs.hub.variantsStock')}
        </h2>
        <PermissionGate allowed={mayWrite && skus.length > 0}>
          {editing ? (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={stop}>
                {t('cp.cancel')}
              </Button>
              <Button
                size="sm"
                data-testid="save-prices"
                disabled={changes.length === 0 || invalid || save.isPending}
                onClick={() => save.mutate()}
              >
                {`${t('cp.hub.saveCount')} (${String(changes.length)})`}
              </Button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              {showStock ? (
                <Button size="sm" variant="ghost" onClick={onReorder}>
                  {t('cs.reorder.action')}
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                data-testid="edit-prices"
                onClick={() => setEditing(true)}
              >
                {t('cp.hub.editPrices')}
              </Button>
            </div>
          )}
        </PermissionGate>
      </div>

      {editing ? (
        <div
          role="group"
          aria-labelledby="bulk-heading"
          className="space-y-3 rounded-lg border border-border bg-card p-4"
        >
          <div>
            <h3 id="bulk-heading" className="text-sm font-semibold">
              {t('cp.hub.bulkTitle')}
            </h3>
            <p className="text-xs text-muted-foreground">{t('cp.hub.bulkHelp')}</p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="me-1 text-xs font-medium text-muted-foreground">
              {t('cp.hub.choose')}
            </span>
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                setSelected(
                  new Set(skus.filter((sku) => sku.status === 'active').map((sku) => sku.id)),
                )
              }
            >
              {t('cp.all')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setSelected(new Set())}>
              {t('cp.none')}
            </Button>
            {[...valuesOf('size'), ...valuesOf('colour')].map(([id, label]) => (
              <Button
                key={id}
                size="sm"
                variant="ghost"
                data-testid={`choose-${label}`}
                onClick={() => chooseValue(id)}
              >
                {label}
              </Button>
            ))}
            <span className="ms-2 text-xs text-muted-foreground tabular-nums">
              {`${String(selected.size)} ${t('cp.selected')}`}
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-5">
            <Field label={t('cp.hub.field')}>
              <Select
                value={field}
                onValueChange={(value) => setField(value as PriceField)}
                options={[
                  { value: 'price', label: t('cp.hub.field.price') },
                  { value: 'compareAt', label: t('cp.hub.field.compareAt') },
                ]}
              />
            </Field>
            <Field label={t('cp.hub.rule')}>
              <Select
                value={ruleKind}
                onValueChange={(value) => setRuleKind(value as RuleKind)}
                options={(['set', 'add', 'subtract', 'up', 'down'] as const).map((kind) => ({
                  value: kind,
                  label: t(RULE_LABELS[kind]),
                }))}
              />
            </Field>
            <Field label={t('cp.hub.amount')}>
              <input
                inputMode="decimal"
                data-testid="bulk-amount"
                value={amount}
                aria-invalid={amount.trim() !== '' && rule === null}
                onChange={(event) => setAmount(event.target.value)}
                className={cn(controlClassName, 'w-full text-right tabular-nums')}
              />
            </Field>
            <Field label={t('cp.hub.round')}>
              <Select
                value={round}
                onValueChange={(value) => setRound(value as (typeof ROUNDS)[number])}
                options={ROUNDS.map((step) => ({
                  value: step,
                  label: step === '0' ? t('cp.hub.round.none') : `৳${poishaToTaka(step)}`,
                }))}
              />
            </Field>
            <div className="flex items-end">
              <Button
                variant="outline"
                data-testid="bulk-preview"
                disabled={rule === null || selected.size === 0}
                onClick={preview}
              >
                {t('cp.hub.preview')}
              </Button>
            </div>
          </div>
          {amount.trim() !== '' && rule === null ? (
            <p className="text-xs text-destructive">{t('cp.hub.amountInvalid')}</p>
          ) : null}
          {plan === null ? null : (
            <div role="status" className="space-y-1 text-sm" data-testid="bulk-plan">
              <p>
                {plan.changes.length === 0
                  ? t('cp.hub.previewNothing')
                  : `${String(plan.changes.length)} ${t('cp.hub.previewCount')}`}
              </p>
              {plan.problems.length > 0 ? (
                <ul className="list-inside list-disc text-destructive">
                  {plan.problems.map((problem) => (
                    <li key={problem.skuId}>
                      {`${labelFor(problem.skuId)}: ${problemWords[problem.reason] ?? problem.reason}`}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )}
          <Field label={t('cp.hub.reason')}>
            <input
              value={reason}
              maxLength={200}
              placeholder={t('cp.hub.reasonDefault')}
              onChange={(event) => setReason(event.target.value)}
              className={cn(controlClassName, 'w-full')}
            />
          </Field>
        </div>
      ) : null}

      {skus.length === 0 && product !== undefined ? (
        <p className="text-sm text-muted-foreground">{t('cs.hub.noVariants')}</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border bg-card">
          <table className="w-full text-sm">
            <caption className="sr-only">{t('cs.hub.variantsStock')}</caption>
            <thead>
              <tr className="border-b border-border bg-muted/50 text-left">
                {editing ? (
                  <th scope="col" className="h-10 w-10 px-3">
                    <span className="sr-only">{t('cp.selectRow')}</span>
                  </th>
                ) : null}
                <th scope="col" className={th}>
                  {t('cs.col.variant')}
                </th>
                <th scope="col" className={th}>
                  {t('catalog.colCode')}
                </th>
                <th scope="col" className={th}>
                  {t('catalog.colBarcode')}
                </th>
                <th scope="col" className={cn(th, 'text-right')}>
                  {t('cs.col.price')}
                </th>
                <th scope="col" className={cn(th, 'text-right')}>
                  {t('cp.col.regularShort')}
                </th>
                {showCost ? (
                  <>
                    <th scope="col" className={cn(th, 'text-right')}>
                      {t('cp.col.avgCost')}
                    </th>
                    <th scope="col" className={cn(th, 'text-right')}>
                      {t('cp.col.lastCost')}
                    </th>
                    <th scope="col" className={cn(th, 'text-right')} title={t('cp.hub.marginHelp')}>
                      {t('cp.col.margin')}
                    </th>
                  </>
                ) : null}
                {showStock
                  ? columns.map((location) => (
                      <th key={location.id} scope="col" className={cn(th, 'text-right')}>
                        {location.name}
                      </th>
                    ))
                  : null}
                {showStock ? (
                  <th scope="col" className={cn(th, 'text-right')}>
                    {t('cs.col.available')}
                  </th>
                ) : null}
                <th scope="col" className={cn(th, 'sticky right-0 bg-muted text-right')}>
                  <span className="sr-only">{t('cs.col.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {skus.map((sku) => {
                const mine = rows.filter((row) => row.skuId === sku.id);
                const free = total(mine.map((row) => row.available));
                const low = mine.some(
                  (row) => row.reorderLevel > 0 && row.available <= row.reorderLevel,
                );
                const label = variantLabel(sku, kinds) || t('cs.new.oneVariant');
                const cost = costs?.get(sku.id);
                const basis = marginCost(cost);
                const margin =
                  basis === null ? null : marginBps(BigInt(priceNow(sku)), BigInt(basis));
                const changedHere = changes.some((change) => change.skuId === sku.id);
                return (
                  <tr
                    key={sku.id}
                    ref={sku.id === highlighted ? marked : undefined}
                    tabIndex={sku.id === highlighted ? -1 : undefined}
                    data-scanned={sku.id === highlighted ? 'true' : undefined}
                    aria-current={sku.id === highlighted ? 'true' : undefined}
                    data-variant={label}
                    className={cn(
                      'group border-b border-border last:border-b-0 hover:bg-accent/60 focus-visible:outline-none',
                      sku.id === highlighted ? 'bg-primary-subtle ring-2 ring-ring ring-inset' : '',
                      editing && changedHere ? 'bg-selected/60' : '',
                    )}
                  >
                    {editing ? (
                      <td className="h-row px-3">
                        <Checkbox
                          aria-label={`${t('cp.selectRow')} ${label}`}
                          checked={selected.has(sku.id)}
                          onCheckedChange={() => toggle(sku.id)}
                        />
                      </td>
                    ) : null}
                    <td className="h-row px-3 whitespace-nowrap">
                      <span className="font-medium">{label}</span>
                      {sku.status === 'archived' ? (
                        <span className="ms-2">
                          <StatusBadge tone="neutral">{t('catalog.status.archived')}</StatusBadge>
                        </span>
                      ) : null}
                    </td>
                    <td className="h-row px-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      {sku.skuCode}
                    </td>
                    <td className="h-row px-3 whitespace-nowrap">
                      {sku.barcode === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="inline-flex items-center gap-1">
                          <EanBars code={sku.barcode} className="hidden 2xl:block" />
                          <span className="font-mono text-xs tabular-nums">{sku.barcode}</span>
                          <CopyCode code={sku.barcode} />
                          {sku.status === 'active' ? (
                            <Button
                              type="button"
                              size="icon-sm"
                              variant="ghost"
                              aria-label={`${t('st.barcode.print')} ${sku.skuCode}`}
                              onClick={() => onPrint(sku)}
                            >
                              <Printer aria-hidden="true" />
                            </Button>
                          ) : null}
                        </span>
                      )}
                    </td>
                    <td className="h-row px-3 text-right whitespace-nowrap">
                      {editing ? (
                        <>
                          <label className="sr-only" htmlFor={`price-${sku.id}`}>
                            {`${t('cs.col.price')} ${label}`}
                          </label>
                          <input
                            id={`price-${sku.id}`}
                            inputMode="decimal"
                            value={prices[sku.id] ?? poishaToTaka(sku.pricePoisha)}
                            aria-invalid={typed(prices[sku.id]).invalid}
                            onChange={(event) =>
                              setPriceTexts((current) => ({
                                ...current,
                                [sku.id]: event.target.value,
                              }))
                            }
                            className={box}
                          />
                        </>
                      ) : (
                        <Money poisha={sku.pricePoisha} />
                      )}
                    </td>
                    <td className="h-row px-3 text-right whitespace-nowrap">
                      {editing ? (
                        <>
                          <label className="sr-only" htmlFor={`regular-${sku.id}`}>
                            {`${t('cp.col.regular')} ${label}`}
                          </label>
                          <input
                            id={`regular-${sku.id}`}
                            inputMode="decimal"
                            value={
                              regulars[sku.id] ??
                              (sku.compareAtPoisha === null
                                ? ''
                                : poishaToTaka(sku.compareAtPoisha))
                            }
                            aria-invalid={
                              typed(regulars[sku.id]).invalid ||
                              (regularNow(sku) !== null &&
                                BigInt(regularNow(sku) ?? '0') <= BigInt(priceNow(sku)))
                            }
                            onChange={(event) =>
                              setRegularTexts((current) => ({
                                ...current,
                                [sku.id]: event.target.value,
                              }))
                            }
                            className={box}
                          />
                        </>
                      ) : sku.compareAtPoisha === null ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <span className="text-muted-foreground line-through">
                          <Money poisha={sku.compareAtPoisha} />
                        </span>
                      )}
                    </td>
                    {showCost ? (
                      <>
                        <td className="h-row px-3 text-right whitespace-nowrap">
                          {cost?.wacPoisha == null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Money poisha={cost.wacPoisha} />
                          )}
                        </td>
                        <td className="h-row px-3 text-right whitespace-nowrap">
                          {cost?.lastUnitCostPoisha == null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            <Money poisha={cost.lastUnitCostPoisha} />
                          )}
                        </td>
                        <td
                          className={cn(
                            'h-row px-3 text-right whitespace-nowrap tabular-nums',
                            margin !== null && margin < 0n ? 'text-destructive' : '',
                          )}
                        >
                          {margin === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : (
                            `${bpsPercentText(margin)}%`
                          )}
                        </td>
                      </>
                    ) : null}
                    {showStock
                      ? columns.map((location) => {
                          const level = cell(sku.id, location.id);
                          return (
                            <td key={location.id} className="h-row px-3 text-right tabular-nums">
                              {level === undefined ? (
                                <span className="text-muted-foreground">0</span>
                              ) : (
                                <span title={`${t('cs.hub.onHand')} ${String(level.onHand)}`}>
                                  {level.available}
                                  {level.reserved > 0 ? (
                                    <span className="ms-1 text-xs text-muted-foreground">
                                      {`(+${String(level.reserved)} ${t('cs.hub.held')})`}
                                    </span>
                                  ) : null}
                                </span>
                              )}
                            </td>
                          );
                        })
                      : null}
                    {showStock ? (
                      <td className="h-row px-3 text-right">
                        <span className="inline-flex items-center gap-2 tabular-nums">
                          {free}
                          {sku.status === 'active' && free === 0 ? (
                            <StatusBadge tone="danger">{t('cs.hub.out')}</StatusBadge>
                          ) : low ? (
                            <StatusBadge tone="warning">{t('cs.hub.low')}</StatusBadge>
                          ) : null}
                        </span>
                      </td>
                    ) : null}
                    <td className="sticky right-0 h-row bg-card px-2 text-right whitespace-nowrap group-hover:bg-accent">
                      <PermissionGate allowed={mayWrite}>
                        <span className="inline-flex items-center gap-0.5">
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`${t('cp.variant.edit')}: ${label}`}
                            onClick={() => setEditingSku(sku)}
                          >
                            <Pencil aria-hidden="true" />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            aria-label={`${sku.status === 'active' ? t('cs.archive') : t('cs.restore')}: ${label}`}
                            onClick={() => setArchiving(sku)}
                          >
                            {sku.status === 'active' ? (
                              <Archive aria-hidden="true" />
                            ) : (
                              <ArchiveRestore aria-hidden="true" />
                            )}
                          </Button>
                        </span>
                      </PermissionGate>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {showCost ? <p className="text-xs text-muted-foreground">{t('cp.hub.marginHelp')}</p> : null}
      {save.error !== null || archive.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {(save.error ?? archive.error) instanceof ApiError
            ? (save.error ?? archive.error)?.message
            : t('cp.saveFailed')}
        </p>
      ) : null}

      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(next) => {
          if (!next) setArchiving(null);
        }}
        title={archiving?.status === 'active' ? t('cs.hub.archiveSku') : t('cs.hub.restoreSku')}
        description={
          archiving === null
            ? ''
            : archiving.status === 'active'
              ? archiveWarning(archiving, rows, t)
              : t('cs.hub.restoreSkuHelp')
        }
        confirmLabel={archiving?.status === 'active' ? t('cs.archive') : t('cs.restore')}
        cancelLabel={t('cp.cancel')}
        closeLabel={t('cp.close')}
        onConfirm={async () => {
          if (archiving !== null) await archive.mutateAsync(archiving);
        }}
      />
      {editingSku === null ? null : (
        <EditVariantDialog
          key={editingSku.id}
          sku={editingSku}
          label={variantLabel(editingSku, kinds)}
          onClose={() => setEditingSku(null)}
          onDone={onDone}
        />
      )}
    </section>
  );
}

/**
 * The archive confirmation, saying what stays (D-423) and what is held: pieces on hand stay
 * where they are; pieces held for orders mean the archive should wait (the bulk route refuses
 * it outright; this one variant's route is D-423's and only warns).
 */
function archiveWarning(
  sku: CatalogSku,
  rows: readonly StockRow[],
  t: ReturnType<typeof useT>,
): string {
  const mine = rows.filter((row) => row.skuId === sku.id);
  const onHand = total(mine.map((row) => row.onHand));
  const held = total(mine.map((row) => row.reserved));
  const parts = [t('cs.hub.archiveSkuHelp')];
  if (onHand > 0) {
    parts.push(
      `${t('cp.variant.archiveStock')}: ${String(onHand)}${held > 0 ? ` (${String(held)} ${t('cp.variant.archiveHeld')})` : ''}.`,
    );
  }
  if (held > 0) parts.push(t('cp.variant.archiveHeldRefused'));
  return parts.join(' ');
}

/** A variant's own barcode (a supplier's EAN, D-644) and weight (D-645). */
function EditVariantDialog({
  sku,
  label,
  onClose,
  onDone,
}: {
  readonly sku: CatalogSku;
  readonly label: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [barcode, setBarcode] = useState(sku.barcode ?? '');
  const [weight, setWeight] = useState(sku.weightGrams === null ? '' : String(sku.weightGrams));
  const grams = parseGrams(weight);
  const save = useMutation({
    mutationFn: async () => {
      const nextBarcode = barcode.trim() === '' ? null : barcode.trim();
      if (nextBarcode !== sku.barcode) await setSkuBarcode(sku.id, nextBarcode);
      const nextWeight = grams === undefined ? null : grams;
      if (nextWeight !== sku.weightGrams) await setSkuWeight(sku.id, nextWeight);
    },
    onSuccess: () => {
      onDone();
      onClose();
    },
  });
  const control = cn(controlClassName, 'w-full');
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={`${t('cp.variant.edit')}: ${label || sku.skuCode}`}
      description={t('cp.variant.editHelp')}
      closeLabel={t('cp.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cp.cancel')}
          </Button>
          <Button
            data-testid="save-variant"
            disabled={grams === null || save.isPending}
            onClick={() => save.mutate()}
          >
            {t('cp.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-scan="accept">
        <Field label={t('cp.variant.barcode')} hint={t('cp.variant.barcodeHint')}>
          <input
            value={barcode}
            maxLength={48}
            onChange={(event) => setBarcode(event.target.value)}
            className={cn(control, 'font-mono')}
          />
        </Field>
        <Field
          label={t('cp.col.weight')}
          hint={grams === null ? t('cp.new.weightInvalid') : t('cp.variant.weightHint')}
        >
          <input
            inputMode="numeric"
            value={weight}
            aria-invalid={grams === null}
            onChange={(event) => setWeight(event.target.value)}
            className={cn(control, 'text-right tabular-nums')}
          />
        </Field>
        {save.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {save.error instanceof ApiError ? save.error.message : t('cp.saveFailed')}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
