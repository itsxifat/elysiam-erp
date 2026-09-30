import { formatDateTime, formatMoney, localiseDigits } from '@elysium/i18n';
import { createPortal } from 'react-dom';

import type { ReceiptHeader } from '../lib/api.js';
import { translate, type PosLocale } from '../i18n/locale.js';
import type { PosMessageKey } from '../i18n/messages.js';

/**
 * The 80 mm receipt (architecture §14: "80 mm receipts via print CSS"; M23 check 4).
 *
 * Printed by the browser, not by a driver or a PDF service: a showroom's thermal
 * printer is an ordinary system printer, and `window.print()` on a page whose print
 * stylesheet is 80 mm wide is the one path that works on every till, offline, with
 * nothing installed. `print.css` sets the page to 80 mm and no margin; the classes
 * below hide everything but this block when printing (`print:hidden` on the app,
 * `hidden print:block` here).
 *
 * **Bangla by default** (D-036): the receipt is the customer's document, so it
 * prints in Bangla whatever the cashier's screen language, with Bangla digits in
 * the amounts. Every amount goes through `formatMoney` — the same formatter
 * `<Money>` uses — never through `toFixed`.
 *
 * No cost appears here and none can: the receipt is built from the till's own
 * document, which never carries one (invariant 5).
 */

export interface ReceiptLine {
  readonly name: string;
  readonly code: string;
  readonly qty: number;
  readonly unitPricePoisha: string;
  readonly discountPoisha: string;
  readonly netPoisha: string;
}

export interface ReceiptData {
  readonly kind: 'sale' | 'return';
  readonly receiptNo: string;
  readonly occurredAt: string;
  readonly registerCode: string;
  readonly header: ReceiptHeader;
  readonly lines: readonly ReceiptLine[];
  readonly grossPoisha: string;
  readonly discountPoisha: string;
  readonly netPoisha: string;
  readonly tenders: readonly { readonly tender: 'cash' | 'bkash' | 'card'; readonly amountPoisha: string }[];
  readonly cashReceivedPoisha: string | null;
  readonly changePoisha: string;
  readonly againstReceiptNo: string | null;
}

const TENDER_KEY: Record<'cash' | 'bkash' | 'card', PosMessageKey> = {
  cash: 'receipt.paidCash',
  bkash: 'receipt.paidBkash',
  card: 'receipt.paidCard',
};

export function Receipt({
  data,
  locale = 'bn',
  pending = false,
}: {
  readonly data: ReceiptData;
  readonly locale?: PosLocale;
  readonly pending?: boolean;
}) {
  const t = (key: PosMessageKey) => translate(locale, key);
  const money = (poisha: string) => formatMoney(poisha, { locale });
  const isReturn = data.kind === 'return';

  return (
    <article
      data-receipt
      aria-label={t(isReturn ? 'receipt.returnTitle' : 'receipt.title')}
      className={`w-[80mm] bg-background px-3 py-4 text-xs leading-snug text-foreground ${locale === 'bn' ? 'font-bangla' : 'font-sans'}`}
    >
      <header className="text-center">
        <p className="text-sm font-semibold">{data.header.legalName || data.header.displayName}</p>
        <p>{data.header.branchName}</p>
        {data.header.address === null ? null : <p>{data.header.address}</p>}
        {data.header.phone === null ? null : <p className="tabular-nums">{data.header.phone}</p>}
        {data.header.vatNo === null ? null : (
          <p>
            {t('receipt.vat')}: <span className="tabular-nums">{data.header.vatNo}</span>
          </p>
        )}
        <p className="mt-2 text-sm font-semibold uppercase tracking-wide">
          {t(isReturn ? 'receipt.returnTitle' : 'receipt.title')}
        </p>
      </header>

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 border-y border-dashed border-foreground py-1">
        <dt>{t('receipt.no')}</dt>
        <dd className="text-right tabular-nums" data-testid="receipt-no">
          {data.receiptNo}
        </dd>
        <dt>{t('receipt.date')}</dt>
        <dd className="text-right tabular-nums">{formatDateTime(new Date(data.occurredAt), { locale })}</dd>
        {data.againstReceiptNo === null ? null : (
          <>
            <dt>{t('receipt.against')}</dt>
            <dd className="text-right tabular-nums">{data.againstReceiptNo}</dd>
          </>
        )}
      </dl>

      <table className="mt-1 w-full border-collapse">
        <thead>
          <tr className="border-b border-dashed border-foreground">
            <th className="py-0.5 text-left font-medium">{t('receipt.item')}</th>
            <th className="py-0.5 text-right font-medium">{t('receipt.qty')}</th>
            <th className="py-0.5 text-right font-medium">{t('receipt.amount')}</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((line, index) => (
            <tr key={`${line.code}-${String(index)}`} className="align-top">
              <td className="py-0.5 pr-1">
                <span className="block">{line.name}</span>
                <span className="block tabular-nums">
                  {line.code} @ {money(line.unitPricePoisha)}
                </span>
                {line.discountPoisha === '0' ? null : (
                  <span className="block tabular-nums">
                    {t('receipt.discount')} −{money(line.discountPoisha)}
                  </span>
                )}
              </td>
              <td className="py-0.5 text-right tabular-nums">
                {localiseDigits(String(line.qty), locale)}
              </td>
              <td className="py-0.5 text-right tabular-nums">{money(line.netPoisha)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="mt-1 grid grid-cols-[1fr_auto] gap-x-2 border-t border-dashed border-foreground pt-1">
        {isReturn ? null : (
          <>
            <dt>{t('receipt.subtotal')}</dt>
            <dd className="text-right tabular-nums">{money(data.grossPoisha)}</dd>
            {data.discountPoisha === '0' ? null : (
              <>
                <dt>{t('receipt.discount')}</dt>
                <dd className="text-right tabular-nums">−{money(data.discountPoisha)}</dd>
              </>
            )}
          </>
        )}
        <dt className="text-sm font-semibold">{t(isReturn ? 'receipt.refund' : 'receipt.total')}</dt>
        <dd className="text-right text-sm font-semibold tabular-nums" data-testid="receipt-total">
          {money(data.netPoisha)}
        </dd>
        {data.tenders.map((tender) => (
          <div key={tender.tender} className="contents">
            <dt>{t(TENDER_KEY[tender.tender])}</dt>
            <dd className="text-right tabular-nums">{money(tender.amountPoisha)}</dd>
          </div>
        ))}
        {data.cashReceivedPoisha === null ? null : (
          <>
            <dt>{t('receipt.cashReceived')}</dt>
            <dd className="text-right tabular-nums">{money(data.cashReceivedPoisha)}</dd>
            <dt>{t('receipt.change')}</dt>
            <dd className="text-right tabular-nums">{money(data.changePoisha)}</dd>
          </>
        )}
      </dl>

      <footer className="mt-3 text-center">
        {pending ? <p className="font-medium">{t('receipt.pending')}</p> : null}
        <p>{data.header.footer ?? t('receipt.thanks')}</p>
      </footer>
    </article>
  );
}

/**
 * The receipt's print region: rendered into `<body>` outside the app, hidden on
 * screen and the only thing visible on paper.
 */
export function PrintArea({ data, locale }: { readonly data: ReceiptData | null; readonly locale?: PosLocale }) {
  if (data === null) return null;
  return createPortal(
    <div id="print-root" className="hidden print:block" data-testid="print-root">
      <Receipt data={data} {...(locale === undefined ? {} : { locale })} />
    </div>,
    document.body,
  );
}

/**
 * Print, in the light theme.
 *
 * Thermal paper is white and prints black; the dark theme's tokens would print a
 * black slab. Rather than duplicate token values for print, the `dark` class is
 * lifted for the duration of the print and restored after — the tokens stay the
 * one source of colour.
 */
export function printReceipt(): void {
  const root = document.documentElement;
  const wasDark = root.classList.contains('dark');
  if (wasDark) root.classList.remove('dark');
  const restore = () => {
    if (wasDark) root.classList.add('dark');
    window.removeEventListener('afterprint', restore);
  };
  window.addEventListener('afterprint', restore);
  window.print();
}
