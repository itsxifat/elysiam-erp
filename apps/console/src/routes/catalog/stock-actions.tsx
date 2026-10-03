import { Button, Dialog, Money, takaToPoisha } from '@elysium/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { dispatchTransfer, listLocations, requestAdjustment, type StockRow } from '../stock/api.js';
import { createDraft, createEntry, listSupplierOptions } from '../supply/api.js';
import { parseQty } from './variant-grid.js';

/**
 * The product page's three stock actions (D-420): receive, adjust and transfer, each a
 * dialog with one quantity box per variant of this product.
 *
 * None of them changes stock directly, because nothing in the console can (invariant 3):
 *
 * - **Receive** posts one supply entry (`POST /v1/supply/entries`) with the supplier and
 *   the cost per piece, which is where purchase cost enters the books (invariant 5) and
 *   the journal is posted. A person without `read Cost` saves a quantity-only draft that
 *   accounts prices later (D-005), and the dialog says so.
 * - **Adjust** raises one adjustment request for approval; the stock moves when someone
 *   else approves it.
 * - **Transfer** dispatches one transfer; the stock arrives when the other end receives it.
 *
 * Cost is typed in taka and converted by `takaToPoisha`, which is integer arithmetic.
 */

export interface VariantInfo {
  readonly id: string;
  readonly skuCode: string;
  readonly label: string;
  readonly status: 'active' | 'archived';
}

const control =
  'h-8 rounded-md border border-border bg-background px-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring';
const wide = 'w-[min(44rem,calc(100vw-2rem))]';

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

/** One quantity box per variant; `limit` caps it (what is available to send). */
function QtyTable({
  variants,
  quantities,
  onChange,
  limit,
  idPrefix,
}: {
  readonly variants: readonly VariantInfo[];
  readonly quantities: Readonly<Record<string, string>>;
  readonly onChange: (skuId: string, value: string) => void;
  readonly limit?: ((skuId: string) => number) | undefined;
  readonly idPrefix: string;
}) {
  const t = useT();
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{t('cs.qty.caption')}</caption>
      <thead>
        <tr className="border-b border-border text-left text-xs text-muted-foreground">
          <th scope="col" className="py-1.5">
            {t('cs.col.variant')}
          </th>
          {limit === undefined ? null : (
            <th scope="col" className="py-1.5 text-right">
              {t('cs.col.available')}
            </th>
          )}
          <th scope="col" className="w-28 py-1.5 text-right">
            {t('cs.col.qty')}
          </th>
        </tr>
      </thead>
      <tbody>
        {variants.map((variant) => {
          const max = limit?.(variant.id);
          const text = quantities[variant.id] ?? '';
          const qty = parseQty(text);
          const over = max !== undefined && qty !== null && qty > max;
          return (
            <tr key={variant.id} className="border-b border-border/60">
              <td className="py-1.5">
                <span className="font-medium">{variant.label === '' ? '—' : variant.label}</span>
                <span className="ms-2 font-mono text-xs text-muted-foreground">
                  {variant.skuCode}
                </span>
              </td>
              {max === undefined ? null : <td className="py-1.5 text-right tabular-nums">{max}</td>}
              <td className="py-1.5 text-right">
                <label className="sr-only" htmlFor={`${idPrefix}-${variant.id}`}>
                  {`${t('cs.col.qty')} ${variant.label || variant.skuCode}`}
                </label>
                <input
                  id={`${idPrefix}-${variant.id}`}
                  inputMode="numeric"
                  value={text}
                  placeholder="0"
                  aria-invalid={over || (text.trim() !== '' && qty === null)}
                  onChange={(event) => onChange(variant.id, event.target.value)}
                  className={`${control} w-24 text-right tabular-nums aria-[invalid=true]:border-destructive`}
                />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function linesFrom(
  quantities: Readonly<Record<string, string>>,
): { skuId: string; qty: number }[] | null {
  const lines: { skuId: string; qty: number }[] = [];
  for (const [skuId, text] of Object.entries(quantities)) {
    if (text.trim() === '') continue;
    const qty = parseQty(text);
    if (qty === null) return null;
    lines.push({ skuId, qty });
  }
  return lines;
}

function Field({
  label,
  id,
  hint,
  children,
}: {
  readonly label: string;
  readonly id: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// --- receive -------------------------------------------------------------------

export function ReceiveStockDialog({
  open,
  onOpenChange,
  variants,
  onDone,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly variants: readonly VariantInfo[];
  readonly onDone: () => void;
}) {
  const t = useT();
  const ability = useAbility();
  const mayPrice = ability.can('read', 'Cost');

  const [supplierId, setSupplierId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [costTaka, setCostTaka] = useState('');
  const [invoice, setInvoice] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [done, setDone] = useState<'entry' | 'draft' | null>(null);

  const suppliers = useQuery({
    queryKey: ['supply', 'suppliers', 'options'],
    queryFn: listSupplierOptions,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const receivable = (locations.data?.items ?? []).filter(
    (location) =>
      location.isActive && (location.kind === 'warehouse' || location.kind === 'showroom'),
  );
  const chosenLocation =
    locationId !== '' ? locationId : (receivable.find((l) => l.kind === 'warehouse')?.id ?? '');

  const lines = linesFrom(quantities);
  const costPoisha = takaToPoisha(costTaka);
  const units = (lines ?? []).reduce((sum, line) => sum + line.qty, 0);
  const ready =
    supplierId !== '' &&
    chosenLocation !== '' &&
    lines !== null &&
    lines.length > 0 &&
    (!mayPrice || costPoisha !== null);

  const submit = useMutation({
    mutationFn: async () => {
      const chosen = lines ?? [];
      if (mayPrice) {
        await createEntry({
          supplyId: crypto.randomUUID(),
          supplierId,
          locationId: chosenLocation,
          ...(invoice.trim() === '' ? {} : { invoiceNumber: invoice.trim() }),
          lines: chosen.map((line) => ({ ...line, unitCostPoisha: costPoisha ?? '0' })),
        });
        return 'entry' as const;
      }
      await createDraft({
        draftId: crypto.randomUUID(),
        supplierId,
        locationId: chosenLocation,
        ...(invoice.trim() === '' ? {} : { invoiceNumber: invoice.trim() }),
        lines: chosen,
      });
      return 'draft' as const;
    },
    onSuccess: (kind) => {
      setDone(kind);
      setQuantities({});
      onDone();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDone(null);
        onOpenChange(next);
      }}
      title={t('cs.receive.title')}
      description={t(mayPrice ? 'cs.receive.help' : 'cs.receive.helpDraft')}
      closeLabel={t('cs.close')}
      className={wide}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cs.cancel')}
          </Button>
          <Button disabled={!ready || submit.isPending} onClick={() => submit.mutate()}>
            {t(mayPrice ? 'cs.receive.submit' : 'cs.receive.submitDraft')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('cs.supplier')} id="receive-supplier">
            <select
              id="receive-supplier"
              value={supplierId}
              onChange={(event) => setSupplierId(event.target.value)}
              className={control}
            >
              <option value="">{t('cs.chooseSupplier')}</option>
              {(suppliers.data?.items ?? []).map((supplier) => (
                <option key={supplier.id} value={supplier.id}>
                  {supplier.name} ({supplier.code})
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('cs.location')} id="receive-location">
            <select
              id="receive-location"
              value={chosenLocation}
              onChange={(event) => setLocationId(event.target.value)}
              className={control}
            >
              {receivable.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </Field>
          {mayPrice ? (
            <Field label={t('cs.costPerPiece')} id="receive-cost" hint={t('cs.costHint')}>
              <input
                id="receive-cost"
                inputMode="decimal"
                value={costTaka}
                onChange={(event) => setCostTaka(event.target.value)}
                className={`${control} text-right tabular-nums`}
              />
            </Field>
          ) : null}
          <Field label={t('cs.invoice')} id="receive-invoice">
            <input
              id="receive-invoice"
              value={invoice}
              maxLength={64}
              onChange={(event) => setInvoice(event.target.value)}
              className={control}
            />
          </Field>
        </div>
        {(suppliers.data?.items ?? []).length === 0 && suppliers.isSuccess ? (
          <p className="text-sm text-muted-foreground">{t('cs.noSuppliers')}</p>
        ) : null}

        <QtyTable
          idPrefix="receive"
          variants={variants.filter((variant) => variant.status === 'active')}
          quantities={quantities}
          onChange={(skuId, value) => setQuantities((current) => ({ ...current, [skuId]: value }))}
        />

        {mayPrice && costPoisha !== null && units > 0 ? (
          <p className="text-sm">
            {t('cs.receive.total')}{' '}
            <Money poisha={(BigInt(costPoisha) * BigInt(units)).toString()} />
          </p>
        ) : null}
        {done !== null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t(done === 'entry' ? 'cs.receive.done' : 'cs.receive.doneDraft')}
          </p>
        ) : null}
        {submit.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(submit.error, t('cs.saveFailed'))}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// --- adjust --------------------------------------------------------------------

const REASONS = ['damaged', 'lost', 'found', 'count'] as const;

export function AdjustStockDialog({
  open,
  onOpenChange,
  variants,
  stock,
  onDone,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly variants: readonly VariantInfo[];
  readonly stock: readonly StockRow[];
  readonly onDone: () => void;
}) {
  const t = useT();
  const [locationId, setLocationId] = useState('');
  const [direction, setDirection] = useState<'loss' | 'gain'>('loss');
  const [reasonKind, setReasonKind] = useState<(typeof REASONS)[number]>('damaged');
  const [note, setNote] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [raised, setRaised] = useState<string | null>(null);

  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const choosable = (locations.data?.items ?? []).filter(
    (location) => location.isActive && location.kind !== 'in_transit',
  );
  const chosenLocation =
    locationId !== '' ? locationId : (choosable.find((l) => l.kind === 'warehouse')?.id ?? '');

  const available = (skuId: string) =>
    stock.find((row) => row.skuId === skuId && row.locationId === chosenLocation)?.available ?? 0;

  const lines = linesFrom(quantities);
  const tooMany =
    direction === 'loss' && (lines ?? []).some((line) => line.qty > available(line.skuId));
  const reasonText = `${t(`cs.reason.${reasonKind}`)}${note.trim() === '' ? '' : ` — ${note.trim()}`}`;
  const ready = chosenLocation !== '' && lines !== null && lines.length > 0 && !tooMany;

  const submit = useMutation({
    mutationFn: () =>
      requestAdjustment({
        locationId: chosenLocation,
        direction,
        reason: reasonText,
        lines: lines ?? [],
      }),
    onSuccess: (row) => {
      setRaised(row.status);
      setQuantities({});
      setNote('');
      onDone();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRaised(null);
        onOpenChange(next);
      }}
      title={t('cs.adjust.title')}
      description={t('cs.adjust.help')}
      closeLabel={t('cs.close')}
      className={wide}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cs.cancel')}
          </Button>
          <Button disabled={!ready || submit.isPending} onClick={() => submit.mutate()}>
            {t('cs.adjust.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('cs.location')} id="adjust-location">
            <select
              id="adjust-location"
              value={chosenLocation}
              onChange={(event) => setLocationId(event.target.value)}
              className={control}
            >
              {choosable.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </Field>
          <fieldset className="flex flex-col gap-1">
            <legend className="text-xs font-medium">{t('cs.adjust.direction')}</legend>
            <div className="flex gap-4 pt-1.5">
              {(['loss', 'gain'] as const).map((value) => (
                <label key={value} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="radio"
                    name="adjust-direction"
                    checked={direction === value}
                    onChange={() => {
                      setDirection(value);
                      setReasonKind(value === 'loss' ? 'damaged' : 'found');
                    }}
                    className="size-4 accent-primary focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {t(value === 'loss' ? 'cs.adjust.loss' : 'cs.adjust.gain')}
                </label>
              ))}
            </div>
          </fieldset>
        </div>

        <fieldset className="space-y-1.5">
          <legend className="text-xs font-medium">{t('cs.adjust.reason')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {REASONS.filter((reason) =>
              direction === 'loss' ? reason !== 'found' : reason === 'found' || reason === 'count',
            ).map((reason) => (
              <Button
                key={reason}
                type="button"
                size="sm"
                variant={reasonKind === reason ? 'secondary' : 'outline'}
                aria-pressed={reasonKind === reason}
                onClick={() => setReasonKind(reason)}
              >
                {t(`cs.reason.${reason}`)}
              </Button>
            ))}
          </div>
          <label className="sr-only" htmlFor="adjust-note">
            {t('cs.adjust.note')}
          </label>
          <input
            id="adjust-note"
            value={note}
            maxLength={400}
            placeholder={t('cs.adjust.note')}
            onChange={(event) => setNote(event.target.value)}
            className={`${control} w-full`}
          />
        </fieldset>

        <QtyTable
          idPrefix="adjust"
          variants={variants}
          quantities={quantities}
          limit={direction === 'loss' ? available : undefined}
          onChange={(skuId, value) => setQuantities((current) => ({ ...current, [skuId]: value }))}
        />

        {tooMany ? (
          <p role="alert" className="text-sm text-destructive">
            {t('cs.adjust.tooMany')}
          </p>
        ) : null}
        {raised !== null ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t(raised === 'posted' ? 'cs.adjust.posted' : 'cs.adjust.pending')}
          </p>
        ) : null}
        {submit.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(submit.error, t('cs.saveFailed'))}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

// --- transfer ------------------------------------------------------------------

export function TransferStockDialog({
  open,
  onOpenChange,
  variants,
  stock,
  onDone,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly variants: readonly VariantInfo[];
  readonly stock: readonly StockRow[];
  readonly onDone: () => void;
}) {
  const t = useT();
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [memo, setMemo] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [sent, setSent] = useState(false);

  const locations = useQuery({
    queryKey: ['stock', 'locations'],
    queryFn: listLocations,
    enabled: open,
    staleTime: 5 * 60_000,
  });
  const ends = (locations.data?.items ?? []).filter(
    (location) =>
      location.isActive && (location.kind === 'warehouse' || location.kind === 'showroom'),
  );
  const from = fromId !== '' ? fromId : (ends.find((l) => l.kind === 'warehouse')?.id ?? '');
  const to = toId !== '' ? toId : (ends.find((l) => l.id !== from)?.id ?? '');

  const available = (skuId: string) =>
    stock.find((row) => row.skuId === skuId && row.locationId === from)?.available ?? 0;
  const lines = linesFrom(quantities);
  const tooMany = (lines ?? []).some((line) => line.qty > available(line.skuId));
  const ready =
    from !== '' && to !== '' && from !== to && lines !== null && lines.length > 0 && !tooMany;

  const submit = useMutation({
    mutationFn: () =>
      dispatchTransfer({
        fromLocationId: from,
        toLocationId: to,
        ...(memo.trim() === '' ? {} : { memo: memo.trim() }),
        lines: lines ?? [],
      }),
    onSuccess: () => {
      setSent(true);
      setQuantities({});
      onDone();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setSent(false);
        onOpenChange(next);
      }}
      title={t('cs.transfer.title')}
      description={t('cs.transfer.help')}
      closeLabel={t('cs.close')}
      className={wide}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cs.cancel')}
          </Button>
          <Button disabled={!ready || submit.isPending} onClick={() => submit.mutate()}>
            {t('cs.transfer.submit')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {ends.length < 2 && locations.isSuccess ? (
          <p className="text-sm text-muted-foreground">{t('cs.transfer.needTwo')}</p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label={t('cs.transfer.from')} id="transfer-from">
            <select
              id="transfer-from"
              value={from}
              onChange={(event) => setFromId(event.target.value)}
              className={control}
            >
              {ends.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('cs.transfer.to')} id="transfer-to">
            <select
              id="transfer-to"
              value={to}
              onChange={(event) => setToId(event.target.value)}
              className={control}
            >
              {ends
                .filter((location) => location.id !== from)
                .map((location) => (
                  <option key={location.id} value={location.id}>
                    {location.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <Field label={t('cs.transfer.memo')} id="transfer-memo">
          <input
            id="transfer-memo"
            value={memo}
            maxLength={400}
            onChange={(event) => setMemo(event.target.value)}
            className={control}
          />
        </Field>

        <QtyTable
          idPrefix="transfer"
          variants={variants}
          quantities={quantities}
          limit={available}
          onChange={(skuId, value) => setQuantities((current) => ({ ...current, [skuId]: value }))}
        />

        {tooMany ? (
          <p role="alert" className="text-sm text-destructive">
            {t('cs.transfer.tooMany')}
          </p>
        ) : null}
        {sent ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('cs.transfer.sent')}
          </p>
        ) : null}
        {submit.error !== null ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(submit.error, t('cs.saveFailed'))}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
