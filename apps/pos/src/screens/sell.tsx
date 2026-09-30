import {
  Button,
  EmptyState,
  Input,
  Label,
  Money,
  Skeleton,
  StatusBadge,
  takaToPoisha,
} from '@elysium/ui';
import { Minus, Plus, Percent, Printer, ScanLine, Trash2, Wallet } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import { useLocale, usePosT } from '../i18n/locale.js';
import { endpoints, NetworkError, type Session } from '../lib/api.js';
import {
  cartTotals,
  lineGross,
  lineNet,
  lookup,
  receiptNumber,
  saleDocument,
  settle,
  withinCeiling,
  type Cart,
  type CartAction,
  type PriceListItem,
  type TenderDraft,
} from '../lib/cart.js';
import { maxDiscountFor, percentOf, percentToBps } from '../lib/money.js';
import { recordDocument } from '../lib/store.js';
import { printReceipt, Receipt, type ReceiptData } from '../receipt/receipt.js';
import { Modal } from './modal.js';

/**
 * The sale screen: scan, basket, discount, split payment, receipt (§14).
 *
 * Keyboard-first (§24): the scan field holds focus, a barcode scanner is just a
 * keyboard that types a code and presses Enter, and every action has a key.
 * Everything a sale needs is already on the till — the price list and the session
 * are in IndexedDB — so nothing on this screen waits for the network. Completing a
 * sale writes it to the queue and prints; the sync engine sends it when it can.
 */

export function Sell({
  session,
  priceList,
  cart,
  dispatch,
  online,
  onRecorded,
}: {
  readonly session: Session & { readonly openShift: NonNullable<Session['openShift']> };
  readonly priceList: {
    readonly items: readonly PriceListItem[];
    readonly state: 'loading' | 'ready' | 'failed';
  };
  readonly cart: Cart;
  readonly dispatch: React.Dispatch<CartAction>;
  readonly online: boolean;
  readonly onRecorded: (receipt: ReceiptData) => void;
}) {
  const t = usePosT();
  const { locale } = useLocale();
  const scanRef = useRef<HTMLInputElement>(null);
  const [scan, setScan] = useState('');
  const [notFound, setNotFound] = useState(false);
  const [selected, setSelected] = useState(0);
  const [paying, setPaying] = useState(false);
  const [discounting, setDiscounting] = useState<number | null>(null);
  const [lastReceipt, setLastReceipt] = useState<ReceiptData | null>(null);
  const totals = cartTotals(cart);

  useEffect(() => {
    if (!paying && discounting === null && lastReceipt === null) scanRef.current?.focus();
  }, [paying, discounting, lastReceipt, cart]);

  function add() {
    const item = lookup(priceList.items, scan);
    if (item === undefined) {
      setNotFound(true);
      return;
    }
    setNotFound(false);
    dispatch({ type: 'add', item });
    setScan('');
    setSelected(cart.lines.length);
  }

  function onKey(event: KeyboardEvent) {
    if (event.key === 'F2' && cart.lines.length > 0) {
      event.preventDefault();
      setPaying(true);
    } else if (event.key === 'F4' && cart.lines[selected] !== undefined) {
      event.preventDefault();
      setDiscounting(selected);
    } else if (event.key === 'Delete' && cart.lines[selected] !== undefined && scan === '') {
      event.preventDefault();
      dispatch({ type: 'remove', index: selected });
      setSelected(Math.max(0, selected - 1));
    } else if (event.key === 'ArrowDown') {
      setSelected(Math.min(cart.lines.length - 1, selected + 1));
    } else if (event.key === 'ArrowUp') {
      setSelected(Math.max(0, selected - 1));
    }
  }

  async function complete(tenders: TenderDraft, references: { bkash?: string; card?: string }) {
    const shift = session.openShift;
    const id = crypto.randomUUID();
    const occurredAt = new Date();
    const entry = await recordDocument({
      shiftId: shift.id,
      kind: 'sale',
      build: (seq) => {
        const receiptNo = receiptNumber(session.register.code, shift.shiftNo, seq);
        const document = saleDocument({
          id,
          registerId: session.register.id,
          shiftId: shift.id,
          receiptNo,
          occurredAt,
          cart,
          tenders,
          references,
        });
        const receipt: ReceiptData = {
          kind: 'sale',
          receiptNo,
          occurredAt: occurredAt.toISOString(),
          registerCode: session.register.code,
          header: session.receiptHeader,
          lines: cart.lines.map((line) => ({
            name: line.name,
            code: line.code,
            qty: line.qty,
            unitPricePoisha: line.unitPricePoisha.toString(),
            discountPoisha: line.discountPoisha.toString(),
            netPoisha: lineNet(line).toString(),
          })),
          grossPoisha: totals.grossPoisha.toString(),
          discountPoisha: totals.discountPoisha.toString(),
          netPoisha: totals.netPoisha.toString(),
          tenders: document.tenders.map((tender) => ({
            tender: tender.tender,
            amountPoisha: tender.amountPoisha,
          })),
          cashReceivedPoisha:
            tenders.cashPoisha > 0n ? tenders.cashReceivedPoisha.toString() : null,
          changePoisha: (tenders.cashPoisha > 0n
            ? tenders.cashReceivedPoisha - tenders.cashPoisha
            : 0n
          ).toString(),
          againstReceiptNo: null,
        };
        return { document, receipt };
      },
    });
    dispatch({ type: 'clear' });
    setPaying(false);
    setLastReceipt(entry.receipt as ReceiptData);
    onRecorded(entry.receipt as ReceiptData);
  }

  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-1 gap-0 lg:grid-cols-[1fr_22rem]"
      onKeyDown={onKey}
    >
      <section
        className="flex min-h-0 flex-col border-border lg:border-r"
        aria-label={t('pos.sell.item')}
      >
        <form
          className="flex items-end gap-2 border-b border-border p-4"
          onSubmit={(event) => {
            event.preventDefault();
            add();
          }}
        >
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="scan">{t('pos.sell.scanLabel')}</Label>
            <Input
              id="scan"
              ref={scanRef}
              autoComplete="off"
              value={scan}
              onChange={(event) => {
                setScan(event.target.value);
                setNotFound(false);
              }}
              aria-describedby="scan-hint"
              className="h-control-lg font-mono"
            />
            <p id="scan-hint" className="text-xs text-muted-foreground">
              {notFound ? (
                <span role="alert" className="text-destructive">
                  {t('pos.sell.notFound')}
                </span>
              ) : (
                t('pos.sell.scanHint')
              )}
            </p>
          </div>
          <Button type="submit" size="lg" aria-label={t('pos.sell.add')}>
            <ScanLine aria-hidden />
          </Button>
        </form>

        {cart.exchangeReturnId === null ? null : (
          <p className="border-b border-border bg-info-subtle px-4 py-2 text-sm text-info-subtle-foreground">
            {t('pos.sell.exchangeBanner')}
          </p>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {priceList.state === 'loading' && priceList.items.length === 0 ? (
            <div className="space-y-2 p-4" aria-label={t('pos.sell.catalogLoading')}>
              <Skeleton className="h-row w-full" />
              <Skeleton className="h-row w-full" />
              <Skeleton className="h-row w-full" />
            </div>
          ) : priceList.state === 'failed' && priceList.items.length === 0 ? (
            <div className="p-4">
              <EmptyState title={t('pos.sell.catalogFailed')} />
            </div>
          ) : cart.lines.length === 0 ? (
            <div className="p-4">
              <EmptyState title={t('pos.sell.emptyTitle')} detail={t('pos.sell.emptyDetail')} />
            </div>
          ) : (
            <table className="w-full text-sm" data-testid="cart">
              <thead className="sticky top-0 bg-muted text-muted-foreground">
                <tr>
                  <th className="h-row px-4 text-left font-medium">{t('pos.sell.item')}</th>
                  <th className="h-row px-2 text-center font-medium">{t('pos.sell.qty')}</th>
                  <th className="h-row px-2 text-right font-medium">{t('pos.sell.price')}</th>
                  <th className="h-row px-2 text-right font-medium">{t('pos.sell.discount')}</th>
                  <th className="h-row px-4 text-right font-medium">{t('pos.sell.lineTotal')}</th>
                  <th className="h-row w-10 px-2">
                    <span className="sr-only">{t('pos.sell.remove')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {cart.lines.map((line, index) => (
                  <tr
                    key={`${line.skuId}-${String(index)}`}
                    aria-selected={index === selected}
                    onClick={() => {
                      setSelected(index);
                    }}
                    className={`border-t border-border ${index === selected ? 'bg-accent text-accent-foreground' : ''}`}
                  >
                    <td className="px-4 py-2">
                      <span className="block font-medium">{line.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {line.code}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-control-lg w-control-lg"
                          aria-label={t('pos.sell.decrease')}
                          disabled={line.qty <= 1}
                          onClick={() => {
                            dispatch({ type: 'setQty', index, qty: line.qty - 1 });
                          }}
                        >
                          <Minus aria-hidden />
                        </Button>
                        <span className="w-8 text-center tabular-nums">{line.qty}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-control-lg w-control-lg"
                          aria-label={t('pos.sell.increase')}
                          onClick={() => {
                            dispatch({ type: 'setQty', index, qty: line.qty + 1 });
                          }}
                        >
                          <Plus aria-hidden />
                        </Button>
                      </div>
                    </td>
                    <td className="px-2 py-2">
                      <Money poisha={line.unitPricePoisha} locale={locale} />
                    </td>
                    <td className="px-2 py-2 text-right">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-control-lg"
                        onClick={() => {
                          setDiscounting(index);
                        }}
                        aria-label={`${t('pos.discount.title')}: ${line.name}`}
                      >
                        {line.discountPoisha === 0n ? (
                          <Percent aria-hidden />
                        ) : (
                          <Money poisha={line.discountPoisha} locale={locale} />
                        )}
                      </Button>
                      {withinCeiling(line, session.discountCeilingBps) ? null : (
                        <StatusBadge tone="warning">{t('pos.discount.over')}</StatusBadge>
                      )}
                    </td>
                    <td className="px-4 py-2">
                      <Money poisha={lineNet(line)} locale={locale} className="font-medium" />
                    </td>
                    <td className="px-2 py-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-control-lg w-control-lg"
                        aria-label={`${t('pos.sell.remove')}: ${line.name}`}
                        onClick={() => {
                          dispatch({ type: 'remove', index });
                        }}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="border-t border-border px-4 py-2 text-xs text-muted-foreground">
          {t('pos.sell.shortcuts')}
        </p>
      </section>

      <aside className="flex flex-col gap-4 p-4" aria-label={t('pos.sell.total')}>
        <dl className="grid grid-cols-[1fr_auto] gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('pos.sell.subtotal')}</dt>
          <dd>
            <Money poisha={totals.grossPoisha} locale={locale} />
          </dd>
          <dt className="text-muted-foreground">{t('pos.sell.discounts')}</dt>
          <dd>
            <Money poisha={totals.discountPoisha} locale={locale} />
          </dd>
          <dt className="border-t border-border pt-2 text-base font-semibold">
            {t('pos.sell.total')}
          </dt>
          <dd
            className="border-t border-border pt-2 text-2xl font-semibold"
            data-testid="cart-total"
          >
            <Money poisha={totals.netPoisha} locale={locale} />
          </dd>
          <dt className="text-muted-foreground">{t('pos.sell.units')}</dt>
          <dd className="text-right tabular-nums">{totals.units}</dd>
        </dl>
        <Button
          size="lg"
          className="w-full"
          disabled={cart.lines.length === 0}
          onClick={() => {
            setPaying(true);
          }}
        >
          <Wallet aria-hidden />
          {t('pos.sell.pay')} <kbd className="ml-1 text-xs opacity-80">F2</kbd>
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="w-full"
          disabled={cart.lines.length === 0}
          onClick={() => {
            dispatch({ type: 'clear' });
          }}
        >
          {t('pos.sell.clear')}
        </Button>
        <PromoCode
          registerId={session.register.id}
          basketPoisha={totals.grossPoisha}
          online={online}
        />
      </aside>

      {paying ? (
        <PayDialog
          netPoisha={totals.netPoisha}
          tenders={session.register.tenders}
          onCancel={() => {
            setPaying(false);
          }}
          onConfirm={complete}
        />
      ) : null}

      {discounting === null || cart.lines[discounting] === undefined ? null : (
        <DiscountDialog
          grossPoisha={lineGross(cart.lines[discounting])}
          current={cart.lines[discounting].discountPoisha}
          ceilingBps={session.discountCeilingBps}
          onCancel={() => {
            setDiscounting(null);
          }}
          onApply={(discountPoisha) => {
            dispatch({ type: 'discount', index: discounting, discountPoisha });
            setDiscounting(null);
          }}
        />
      )}

      {lastReceipt === null ? null : (
        <Modal
          title={online ? t('pos.pay.saved') : t('pos.pay.savedOffline')}
          onClose={() => {
            setLastReceipt(null);
          }}
          footer={
            <>
              <Button
                size="lg"
                variant="outline"
                onClick={() => {
                  printReceipt();
                }}
              >
                <Printer aria-hidden />
                {t('pos.receipt.print')}
              </Button>
              <Button
                size="lg"
                autoFocus
                onClick={() => {
                  setLastReceipt(null);
                }}
              >
                {t('pos.receipt.newSale')}
              </Button>
            </>
          }
        >
          <div className="flex justify-center rounded-md border border-border">
            <Receipt data={lastReceipt} pending={!online} />
          </div>
        </Modal>
      )}
    </div>
  );
}

function PromoCode({
  registerId,
  basketPoisha,
  online,
}: {
  readonly registerId: string;
  readonly basketPoisha: bigint;
  readonly online: boolean;
}) {
  const t = usePosT();
  const [code, setCode] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  async function check() {
    if (!online) {
      setMessage(t('pos.discount.promoOffline'));
      return;
    }
    try {
      const verdict = await endpoints.checkPromo({
        registerId,
        code: code.trim(),
        basketPoisha: basketPoisha.toString(),
      });
      // Until M16 binds promotions, every answer is "not available" (NoPromoCodes).
      setMessage(verdict.valid ? null : t('pos.discount.promoUnavailable'));
    } catch (error) {
      setMessage(
        error instanceof NetworkError ? t('pos.discount.promoOffline') : t('pos.error.generic'),
      );
    }
  }

  return (
    <form
      className="space-y-1.5 border-t border-border pt-4"
      onSubmit={(event) => {
        event.preventDefault();
        void check();
      }}
    >
      <Label htmlFor="promo">{t('pos.discount.promo')}</Label>
      <div className="flex gap-2">
        <Input
          id="promo"
          value={code}
          disabled={!online}
          onChange={(event) => {
            setCode(event.target.value);
          }}
          className="h-control-lg"
        />
        <Button type="submit" size="lg" variant="outline" disabled={code.trim() === ''}>
          {t('pos.discount.promoCheck')}
        </Button>
      </div>
      {!online ? (
        <p className="text-xs text-muted-foreground">{t('pos.discount.promoOffline')}</p>
      ) : null}
      {message === null ? null : (
        <p className="text-xs text-muted-foreground" role="status">
          {message}
        </p>
      )}
    </form>
  );
}

function DiscountDialog({
  grossPoisha,
  current,
  ceilingBps,
  onCancel,
  onApply,
}: {
  readonly grossPoisha: bigint;
  readonly current: bigint;
  readonly ceilingBps: number;
  readonly onCancel: () => void;
  readonly onApply: (discountPoisha: bigint) => void;
}) {
  const t = usePosT();
  const { locale } = useLocale();
  const [percent, setPercent] = useState('');
  const [amount, setAmount] = useState(current === 0n ? '' : toTaka(current));
  const [error, setError] = useState<string | null>(null);

  const typed = useMemo((): bigint | null => {
    if (percent.trim() !== '') {
      const bps = percentToBps(percent);
      return bps === null ? null : percentOf(grossPoisha, bps);
    }
    if (amount.trim() === '') return 0n;
    const poisha = takaToPoisha(amount);
    return poisha === null || poisha.startsWith('-') ? null : BigInt(poisha);
  }, [percent, amount, grossPoisha]);

  const limit = `${String(ceilingBps / 100)}%`;
  const over = typed !== null && typed > maxDiscountFor(grossPoisha, ceilingBps);

  return (
    <Modal
      title={t('pos.discount.title')}
      description={t('pos.discount.detail', { limit })}
      onClose={onCancel}
      footer={
        <>
          <Button size="lg" variant="outline" onClick={onCancel}>
            {t('pos.action.cancel')}
          </Button>
          <Button
            size="lg"
            onClick={() => {
              if (typed === null || typed > grossPoisha) {
                setError(t('pos.discount.invalid'));
                return;
              }
              onApply(typed);
            }}
          >
            {t('pos.discount.apply')}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="discount-percent">{t('pos.discount.percent')}</Label>
          <Input
            id="discount-percent"
            inputMode="decimal"
            autoFocus
            value={percent}
            onChange={(event) => {
              setPercent(event.target.value);
              setAmount('');
            }}
            className="h-control-lg text-right tabular-nums"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="discount-amount">{t('pos.discount.amount')}</Label>
          <Input
            id="discount-amount"
            inputMode="decimal"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setPercent('');
            }}
            className="h-control-lg text-right tabular-nums"
          />
        </div>
      </div>
      {typed === null ? null : (
        <p className="mt-3 text-sm">
          <Money poisha={typed} locale={locale} align="start" />
        </p>
      )}
      {over ? (
        <p role="status" className="mt-2 text-sm text-warning">
          {t('pos.discount.over')}
        </p>
      ) : null}
      {error === null ? null : (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {error}
        </p>
      )}
    </Modal>
  );
}

function PayDialog({
  netPoisha,
  tenders,
  onCancel,
  onConfirm,
}: {
  readonly netPoisha: bigint;
  readonly tenders: readonly ('cash' | 'bkash' | 'card')[];
  readonly onCancel: () => void;
  readonly onConfirm: (
    tenders: TenderDraft,
    references: { bkash?: string; card?: string },
  ) => Promise<void>;
}) {
  const t = usePosT();
  const { locale } = useLocale();
  const takes = (tender: 'bkash' | 'card') => tenders.includes(tender);
  const [cash, setCash] = useState(toTaka(netPoisha));
  const [bkash, setBkash] = useState('');
  const [card, setCard] = useState('');
  const [received, setReceived] = useState('');
  const [bkashRef, setBkashRef] = useState('');
  const [cardRef, setCardRef] = useState('');
  const [busy, setBusy] = useState(false);

  const draft: TenderDraft = {
    cashPoisha: parse(cash),
    bkashPoisha: takes('bkash') ? parse(bkash) : 0n,
    cardPoisha: takes('card') ? parse(card) : 0n,
    cashReceivedPoisha: received.trim() === '' ? parse(cash) : parse(received),
  };
  const { problem, changePoisha } = settle(netPoisha, draft);
  const remaining = netPoisha - draft.cashPoisha - draft.bkashPoisha - draft.cardPoisha;

  function all(tender: 'cash' | 'bkash' | 'card') {
    setCash(tender === 'cash' ? toTaka(netPoisha) : '');
    setBkash(tender === 'bkash' ? toTaka(netPoisha) : '');
    setCard(tender === 'card' ? toTaka(netPoisha) : '');
  }

  return (
    <Modal
      title={t('pos.pay.title')}
      description={t('pos.pay.detail')}
      onClose={onCancel}
      footer={
        <>
          <Button size="lg" variant="outline" onClick={onCancel}>
            {t('pos.action.cancel')}
          </Button>
          <Button
            size="lg"
            disabled={problem !== null || busy}
            onClick={() => {
              setBusy(true);
              void onConfirm(draft, {
                ...(bkashRef.trim() === '' ? {} : { bkash: bkashRef.trim() }),
                ...(cardRef.trim() === '' ? {} : { card: cardRef.trim() }),
              }).finally(() => {
                setBusy(false);
              });
            }}
          >
            {t('pos.pay.confirm')}
          </Button>
        </>
      }
    >
      <p className="text-center text-3xl font-semibold" data-testid="pay-total">
        <Money poisha={netPoisha} locale={locale} align="start" />
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          size="lg"
          variant="outline"
          onClick={() => {
            all('cash');
          }}
        >
          {t('pos.pay.allCash')}
        </Button>
        {takes('bkash') ? (
          <Button
            size="lg"
            variant="outline"
            onClick={() => {
              all('bkash');
            }}
          >
            {t('pos.pay.allBkash')}
          </Button>
        ) : null}
        {takes('card') ? (
          <Button
            size="lg"
            variant="outline"
            onClick={() => {
              all('card');
            }}
          >
            {t('pos.pay.allCard')}
          </Button>
        ) : null}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <TakaField
          id="pay-cash"
          label={t('pos.pay.cash')}
          value={cash}
          onChange={setCash}
          autoFocus
        />
        <TakaField
          id="pay-received"
          label={t('pos.pay.cashReceived')}
          value={received}
          onChange={setReceived}
        />
        {takes('bkash') ? (
          <>
            <TakaField
              id="pay-bkash"
              label={t('pos.pay.bkash')}
              value={bkash}
              onChange={setBkash}
            />
            <TextField
              id="pay-bkash-ref"
              label={t('pos.pay.reference')}
              value={bkashRef}
              onChange={setBkashRef}
            />
          </>
        ) : null}
        {takes('card') ? (
          <>
            <TakaField id="pay-card" label={t('pos.pay.card')} value={card} onChange={setCard} />
            <TextField
              id="pay-card-ref"
              label={t('pos.pay.reference')}
              value={cardRef}
              onChange={setCardRef}
            />
          </>
        ) : null}
      </div>
      <dl className="mt-4 grid grid-cols-[1fr_auto] gap-y-1 text-sm">
        <dt className="text-muted-foreground">{t('pos.pay.remaining')}</dt>
        <dd>
          <Money poisha={remaining > 0n ? remaining : 0n} locale={locale} />
        </dd>
        <dt className="font-medium">{t('pos.pay.change')}</dt>
        <dd className="font-medium" data-testid="pay-change">
          <Money poisha={changePoisha} locale={locale} />
        </dd>
      </dl>
      {problem === 'over' ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t('pos.pay.over')}
        </p>
      ) : null}
      {problem === 'cashShort' ? (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {t('pos.pay.cashShort')}
        </p>
      ) : null}
    </Modal>
  );
}

function TakaField({
  id,
  label,
  value,
  onChange,
  autoFocus = false,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly autoFocus?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        autoFocus={autoFocus}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="h-control-lg text-right tabular-nums"
      />
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        maxLength={40}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="h-control-lg"
      />
    </div>
  );
}

/** Typed taka to poisha; anything unreadable is zero, which the settle check refuses. */
function parse(taka: string): bigint {
  const poisha = takaToPoisha(taka);
  return poisha === null || poisha.startsWith('-') ? 0n : BigInt(poisha);
}

function toTaka(poisha: bigint): string {
  const whole = poisha / 100n;
  const paisa = poisha % 100n;
  return paisa === 0n
    ? whole.toString()
    : `${whole.toString()}.${paisa.toString().padStart(2, '0')}`;
}
