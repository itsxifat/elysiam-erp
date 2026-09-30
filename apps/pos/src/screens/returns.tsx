import { Button, EmptyState, Input, Label, Money } from '@elysium/ui';
import { Minus, Plus, Search } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { useLocale, usePosT } from '../i18n/locale.js';
import { endpoints, NetworkError, type ReceiptLookup, type Session } from '../lib/api.js';
import { divideRounded, refundForUnits } from '../lib/money.js';
import { recordDocument } from '../lib/store.js';
import type { ReceiptData } from '../receipt/receipt.js';

/**
 * Returns and exchanges, by receipt (§14).
 *
 * The lookup needs the server — which units of a receipt are still returnable is
 * a fact about every till, not this one — but the return itself goes through the
 * same queue as a sale, so a connection that drops between the lookup and the
 * refund loses nothing.
 *
 * The refund is what the customer paid for the units, by the same cumulative rule
 * the server checks (`refundForUnits` in `lib/money.ts`), so partial returns always
 * sum to the line exactly.
 */

type Tender = 'cash' | 'bkash' | 'card';

export function Returns({
  session,
  online,
  onRecorded,
  onExchange,
}: {
  readonly session: Session & { readonly openShift: NonNullable<Session['openShift']> };
  readonly online: boolean;
  readonly onRecorded: (receipt: ReceiptData) => void;
  readonly onExchange: (returnId: string) => void;
}) {
  const t = usePosT();
  const { locale } = useLocale();
  const [receiptNo, setReceiptNo] = useState('');
  const [sale, setSale] = useState<ReceiptLookup | null>(null);
  const [qty, setQty] = useState<Record<number, number>>({});
  const [tender, setTender] = useState<Tender>('cash');
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function find(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    setSale(null);
    setQty({});
    if (!online) {
      setMessage(t('pos.returns.offline'));
      return;
    }
    setBusy(true);
    try {
      const { items } = await endpoints.receipt(receiptNo.trim().toUpperCase());
      const found = items[0];
      if (found === undefined) setMessage(t('pos.returns.notFound'));
      else if (found.status === 'voided') setMessage(t('pos.returns.voided'));
      else setSale(found);
    } catch (error) {
      setMessage(
        error instanceof NetworkError ? t('pos.returns.offline') : t('pos.returns.notFound'),
      );
    } finally {
      setBusy(false);
    }
  }

  const chosen = (sale?.lines ?? [])
    .map((line) => ({ line, qty: qty[line.lineNo] ?? 0 }))
    .filter((entry) => entry.qty > 0)
    .map((entry) => ({
      ...entry,
      refund: refundForUnits(
        BigInt(entry.line.netPoisha),
        entry.line.qty,
        entry.line.returnedQty,
        entry.qty,
      ),
    }));
  const total = chosen.reduce((sum, entry) => sum + entry.refund, 0n);

  async function record(exchange: boolean) {
    if (sale === null || chosen.length === 0) {
      setMessage(t('pos.returns.nothing'));
      return;
    }
    const shift = session.openShift;
    const id = crypto.randomUUID();
    const occurredAt = new Date();
    setBusy(true);
    try {
      const entry = await recordDocument({
        shiftId: shift.id,
        kind: 'return',
        build: (seq) => {
          const slipNo = `${session.register.code}-${String(shift.shiftNo)}-R${String(seq).padStart(4, '0')}`;
          const document = {
            kind: 'return' as const,
            id,
            registerId: session.register.id,
            shiftId: shift.id,
            saleId: sale.id,
            receiptNo: slipNo,
            occurredAt: occurredAt.toISOString(),
            ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
            lines: chosen.map((entry, index) => ({
              lineNo: index + 1,
              saleLineNo: entry.line.lineNo,
              qty: entry.qty,
              refundPoisha: entry.refund.toString(),
            })),
            tenders: total > 0n ? [{ tender, amountPoisha: total.toString() }] : [],
            refundPoisha: total.toString(),
          };
          const receipt: ReceiptData = {
            kind: 'return',
            receiptNo: slipNo,
            occurredAt: occurredAt.toISOString(),
            registerCode: session.register.code,
            header: session.receiptHeader,
            lines: chosen.map((entry) => ({
              name: entry.line.name,
              code: entry.line.skuCode,
              qty: entry.qty,
              unitPricePoisha: divideRounded(entry.refund, BigInt(entry.qty)).toString(),
              discountPoisha: '0',
              netPoisha: entry.refund.toString(),
            })),
            grossPoisha: total.toString(),
            discountPoisha: '0',
            netPoisha: total.toString(),
            tenders: total > 0n ? [{ tender, amountPoisha: total.toString() }] : [],
            cashReceivedPoisha: null,
            changePoisha: '0',
            againstReceiptNo: sale.receiptNo,
          };
          return { document, receipt };
        },
      });
      setSale(null);
      setQty({});
      setReceiptNo('');
      setReason('');
      setMessage(t('pos.returns.saved'));
      onRecorded(entry.receipt as ReceiptData);
      if (exchange) onExchange(id);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="main" className="mx-auto w-full max-w-3xl space-y-6 p-6">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">{t('pos.returns.title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t('pos.returns.detail')}</p>
      </header>

      <form className="flex items-end gap-2" onSubmit={(event) => void find(event)}>
        <div className="flex-1 space-y-1.5">
          <Label htmlFor="receipt-no">{t('pos.returns.receiptNo')}</Label>
          <Input
            id="receipt-no"
            autoFocus
            autoComplete="off"
            value={receiptNo}
            onChange={(event) => {
              setReceiptNo(event.target.value);
            }}
            className="h-control-lg font-mono uppercase"
          />
        </div>
        <Button type="submit" size="lg" disabled={busy || receiptNo.trim() === ''}>
          <Search aria-hidden />
          {t('pos.returns.find')}
        </Button>
      </form>

      {message === null ? null : (
        <p role="status" className="rounded-md border border-border bg-muted px-3 py-2 text-sm">
          {message}
        </p>
      )}
      {!online && sale === null ? <EmptyState title={t('pos.returns.offline')} /> : null}

      {sale === null ? null : (
        <section className="space-y-4" aria-label={sale.receiptNo}>
          <table className="w-full text-sm">
            <thead className="bg-muted text-muted-foreground">
              <tr>
                <th className="h-row px-3 text-left font-medium">{t('pos.sell.item')}</th>
                <th className="h-row px-3 text-right font-medium">{t('pos.returns.sold')}</th>
                <th className="h-row px-3 text-right font-medium">{t('pos.returns.returnable')}</th>
                <th className="h-row px-3 text-center font-medium">{t('pos.returns.returnQty')}</th>
              </tr>
            </thead>
            <tbody>
              {sale.lines.map((line) => {
                const current = qty[line.lineNo] ?? 0;
                return (
                  <tr key={line.lineNo} className="border-t border-border">
                    <td className="px-3 py-2">
                      <span className="block font-medium">{line.name}</span>
                      <span className="block font-mono text-xs text-muted-foreground">
                        {line.skuCode}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{line.qty}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{line.returnableQty}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-control-lg w-control-lg"
                          aria-label={`${t('pos.sell.decrease')}: ${line.name}`}
                          disabled={current <= 0}
                          onClick={() => {
                            setQty({ ...qty, [line.lineNo]: current - 1 });
                          }}
                        >
                          <Minus aria-hidden />
                        </Button>
                        <span className="w-8 text-center tabular-nums">{current}</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-control-lg w-control-lg"
                          aria-label={`${t('pos.sell.increase')}: ${line.name}`}
                          disabled={current >= line.returnableQty}
                          onClick={() => {
                            setQty({ ...qty, [line.lineNo]: current + 1 });
                          }}
                        >
                          <Plus aria-hidden />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <fieldset className="space-y-2">
            <legend className="text-sm font-medium">{t('pos.returns.refundBy')}</legend>
            <div className="flex gap-2">
              {session.register.tenders.map((option) => (
                <Button
                  key={option}
                  size="lg"
                  variant={tender === option ? 'primary' : 'outline'}
                  aria-pressed={tender === option}
                  onClick={() => {
                    setTender(option);
                  }}
                >
                  {t(
                    option === 'cash'
                      ? 'pos.pay.cash'
                      : option === 'bkash'
                        ? 'pos.pay.bkash'
                        : 'pos.pay.card',
                  )}
                </Button>
              ))}
            </div>
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="return-reason">{t('pos.returns.reason')}</Label>
            <Input
              id="return-reason"
              maxLength={200}
              value={reason}
              onChange={(event) => {
                setReason(event.target.value);
              }}
              className="h-control-lg"
            />
          </div>

          <div className="flex items-center justify-between border-t border-border pt-4">
            <p className="text-sm text-muted-foreground">
              {t('pos.returns.refundTotal')}{' '}
              <Money
                poisha={total}
                locale={locale}
                align="start"
                className="text-xl font-semibold text-foreground"
              />
            </p>
            <div className="flex gap-2">
              <Button
                size="lg"
                variant="outline"
                disabled={busy || chosen.length === 0}
                onClick={() => void record(true)}
              >
                {t('pos.returns.exchange')}
              </Button>
              <Button
                size="lg"
                disabled={busy || chosen.length === 0}
                onClick={() => void record(false)}
              >
                {t('pos.returns.confirm')}
              </Button>
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
