import { sum, takaParts, type Poisha } from '@elysium/domain';

import { fontFaceCss, type FontFile } from './fonts.js';

/**
 * The sample invoice (architecture §22, §24, D-034).
 *
 * §22 lists six templates and says every one of them takes the active org's
 * `brand` block: logo, legal name, address, VAT number, invoice footer. This is
 * the first, and it is deliberately the whole shape rather than a stub — the
 * five that follow are this file with different rows.
 *
 * ## Why the text is Bangla
 *
 * D-036: the staff console is English and *everything customer-facing is
 * Bangla*. An invoice goes in the parcel. Writing it in English would be a
 * decision to ship the wrong document, and doing that "for now" is how it
 * ships forever.
 *
 * The labels below are therefore real Bangla, chosen partly because they
 * exercise the shaping that §22's font requirement exists for:
 * `ক্ষুদ্র`, `প্রতিষ্ঠান`, `ধন্যবাদ` and `মূল্য` each contain a conjunct that a
 * font without the right GSUB table renders as separate letters. Acceptance
 * check 5 rasterizes page 1 so a human can see that they did not.
 *
 * Numbers stay in Latin digits, per D-036 ("Latin digits by default"). The taka
 * sign ৳ is U+09F3 and lives in the Bengali subset, which is why both font
 * subsets have to be present for a single price to render.
 */

export interface InvoiceBrand {
  readonly legalName: string;
  readonly displayName: string;
  readonly address?: string | undefined;
  readonly vatNo?: string | undefined;
  readonly invoiceFooter?: string | undefined;
  /** OKLCH hue, 0-360. The one accent (§24). Defaults to a neutral ink. */
  readonly accentHue?: number | undefined;
}

export interface InvoiceLine {
  readonly name: string;
  readonly sku: string;
  readonly quantity: number;
  readonly unitPricePoisha: Poisha;
}

export interface InvoiceData {
  readonly invoiceNo: string;
  /** An Asia/Dhaka calendar date, already formatted (invariant 8). */
  readonly issuedOn: string;
  readonly customerName: string;
  /** Masked before it gets here. Invariant 10 covers documents too. */
  readonly customerPhone: string;
  readonly customerAddress: string;
  readonly lines: readonly InvoiceLine[];
  readonly deliveryChargePoisha: Poisha;
  readonly paidPoisha: Poisha;
}

/**
 * HTML-escape.
 *
 * Every interpolated value goes through this without exception. A customer's
 * name is attacker-controlled text and this document is rendered by a real
 * browser: `<script>` in a name would execute inside Gotenberg's Chromium,
 * which can read the other files uploaded with the document. The dev container
 * runs `--chromium-disable-javascript=true`, which makes that harmless *there*
 * — and relying on a container flag for correctness is exactly the kind of
 * dependency that breaks when somebody tunes the compose file.
 */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Money, from integer poisha, with thousands separators.
 *
 * Never a float and never division into a `number` (invariant 1): the split
 * happens in bigint arithmetic in `takaParts`, and only the already-split
 * integer parts become strings. A `poisha / 100` here would be exactly the bug
 * the invariant exists to prevent, and on an invoice it would be visible to the
 * customer.
 */
export function formatTaka(amount: Poisha): string {
  const { negative, taka, poisha } = takaParts(amount);
  const grouped = taka.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}৳${grouped}.${poisha.toString().padStart(2, '0')}`;
}

export function invoiceTotals(data: InvoiceData): {
  readonly subtotal: Poisha;
  readonly total: Poisha;
  readonly due: Poisha;
} {
  const subtotal = sum(
    data.lines.map((line) => (BigInt(line.unitPricePoisha) * BigInt(line.quantity)) as Poisha),
  );
  const total = (BigInt(subtotal) + BigInt(data.deliveryChargePoisha)) as Poisha;
  const due = (BigInt(total) - BigInt(data.paidPoisha)) as Poisha;
  return { subtotal, total, due };
}

/**
 * The document, as one self-contained HTML string.
 *
 * Inline `<style>` rather than a separate stylesheet upload: one fewer moving
 * part, and the CSS is specific to this template. The fonts are the exception
 * because they are binary and shared between every template.
 */
export function renderInvoiceHtml(input: {
  readonly brand: InvoiceBrand;
  readonly data: InvoiceData;
  readonly fonts: readonly FontFile[];
}): string {
  const { brand, data, fonts } = input;
  const { subtotal, total, due } = invoiceTotals(data);
  const accent = `oklch(0.55 0.12 ${String(brand.accentHue ?? 250)})`;

  const rows = data.lines
    .map(
      (line, index) => `
      <tr>
        <td class="num">${String(index + 1)}</td>
        <td>
          <div class="item">${escape(line.name)}</div>
          <div class="sku">${escape(line.sku)}</div>
        </td>
        <td class="num">${String(line.quantity)}</td>
        <td class="money">${formatTaka(line.unitPricePoisha)}</td>
        <td class="money">${formatTaka((BigInt(line.unitPricePoisha) * BigInt(line.quantity)) as Poisha)}</td>
      </tr>`,
    )
    .join('');

  return `<!doctype html>
<html lang="bn">
  <head>
    <meta charset="utf-8" />
    <title>${escape(data.invoiceNo)}</title>
    <style>
${fontFaceCss(fonts)}

      /* §24: neutral chrome, one accent, hairlines rather than shadows. A
         printed document has no hover states and no dark mode, so the token
         set collapses to ink, hairline and the org's accent. */
      :root {
        --ink: oklch(0.22 0.01 260);
        --muted: oklch(0.52 0.01 260);
        --hairline: oklch(0.9 0.005 260);
        --accent: ${accent};
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        /* Hind Siliguri for both scripts, so Bangla labels and Latin digits sit
           on the same baseline. The fallback list is what a machine without the
           uploaded fonts would use — it exists so a missing font is visibly a
           different typeface rather than invisible boxes. */
        font-family: 'Hind Siliguri', 'Noto Sans Bengali', sans-serif;
        font-size: 11pt;
        line-height: 1.6;
        color: var(--ink);
      }

      header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 24px;
        padding-bottom: 14px;
        border-bottom: 2px solid var(--accent);
      }

      .brand-name { font-size: 17pt; font-weight: 600; line-height: 1.3; }
      .brand-legal { color: var(--muted); font-size: 9.5pt; }
      .doc-title { font-size: 15pt; font-weight: 600; text-align: right; }
      .doc-meta { color: var(--muted); font-size: 9.5pt; text-align: right; }

      .parties { display: flex; gap: 32px; margin: 18px 0 20px; }
      .party { flex: 1; }
      .party h2 {
        margin: 0 0 4px;
        font-size: 9.5pt;
        font-weight: 600;
        color: var(--muted);
        letter-spacing: 0.04em;
      }

      table { width: 100%; border-collapse: collapse; }
      thead th {
        background: oklch(0.97 0.004 260);
        font-size: 9.5pt;
        font-weight: 600;
        text-align: left;
        padding: 7px 8px;
        border-bottom: 1px solid var(--hairline);
      }
      tbody td { padding: 8px; border-bottom: 1px solid var(--hairline); vertical-align: top; }
      .item { font-weight: 500; }
      .sku { color: var(--muted); font-size: 9pt; }
      .num { text-align: center; width: 9%; }
      /* Tabular figures so the money column aligns digit for digit (§24). */
      .money { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      thead th.num { text-align: center; }
      thead th.money { text-align: right; }

      .totals { margin-top: 14px; margin-left: auto; width: 52%; }
      .totals tr td { border: none; padding: 3px 8px; }
      .totals .label { color: var(--muted); }
      .totals .grand td {
        border-top: 1px solid var(--hairline);
        padding-top: 8px;
        font-weight: 600;
        font-size: 12pt;
      }
      .totals .due td { color: var(--accent); font-weight: 600; }

      footer {
        margin-top: 28px;
        padding-top: 10px;
        border-top: 1px solid var(--hairline);
        color: var(--muted);
        font-size: 9.5pt;
      }
      .thanks { color: var(--ink); font-weight: 500; margin-bottom: 4px; }
    </style>
  </head>
  <body>
    <header>
      <div>
        <div class="brand-name">${escape(brand.displayName)}</div>
        <div class="brand-legal">${escape(brand.legalName)}</div>
        ${brand.address === undefined ? '' : `<div class="brand-legal">${escape(brand.address)}</div>`}
        ${brand.vatNo === undefined ? '' : `<div class="brand-legal">ভ্যাট নিবন্ধন নম্বর: ${escape(brand.vatNo)}</div>`}
      </div>
      <div>
        <div class="doc-title">বিক্রয় চালান</div>
        <div class="doc-meta">চালান নম্বর: ${escape(data.invoiceNo)}</div>
        <div class="doc-meta">তারিখ: ${escape(data.issuedOn)}</div>
      </div>
    </header>

    <section class="parties">
      <div class="party">
        <h2>ক্রেতার বিবরণ</h2>
        <div>${escape(data.customerName)}</div>
        <div>${escape(data.customerPhone)}</div>
        <div>${escape(data.customerAddress)}</div>
      </div>
      <div class="party">
        <h2>পরিশোধের ধরন</h2>
        <div>ক্যাশ অন ডেলিভারি</div>
        <div class="brand-legal">পণ্য বুঝে নেওয়ার সময় মূল্য পরিশোধ করুন।</div>
      </div>
    </section>

    <table>
      <thead>
        <tr>
          <th class="num">ক্রম</th>
          <th>পণ্যের বিবরণ</th>
          <th class="num">পরিমাণ</th>
          <th class="money">একক মূল্য</th>
          <th class="money">মোট</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>

    <table class="totals">
      <tbody>
        <tr>
          <td class="label">উপমোট</td>
          <td class="money">${formatTaka(subtotal)}</td>
        </tr>
        <tr>
          <td class="label">ডেলিভারি চার্জ</td>
          <td class="money">${formatTaka(data.deliveryChargePoisha)}</td>
        </tr>
        <tr class="grand">
          <td>সর্বমোট</td>
          <td class="money">${formatTaka(total)}</td>
        </tr>
        <tr>
          <td class="label">পরিশোধিত</td>
          <td class="money">${formatTaka(data.paidPoisha)}</td>
        </tr>
        <tr class="due">
          <td>বকেয়া</td>
          <td class="money">${formatTaka(due)}</td>
        </tr>
      </tbody>
    </table>

    <footer>
      <div class="thanks">আমাদের সঙ্গে থাকার জন্য আন্তরিক ধন্যবাদ।</div>
      <div>${escape(brand.invoiceFooter ?? 'পণ্য বদলাতে চাইলে ডেলিভারির ৭ দিনের মধ্যে যোগাযোগ করুন।')}</div>
      <div>এই চালানটি কম্পিউটারে তৈরি, তাই কোনো স্বাক্ষরের প্রয়োজন নেই।</div>
    </footer>
  </body>
</html>`;
}
