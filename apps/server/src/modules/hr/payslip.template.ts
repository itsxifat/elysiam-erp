import { takaParts, type Poisha } from '@elysium/domain';

import { fontFaceCss, type FontFile } from '../files/pdf/fonts.js';

/**
 * The payslip, in Bangla (architecture §12 "payslip PDF in Bangla", §22, §24, D-036).
 *
 * ## Why it is Bangla and not English
 *
 * D-036: the staff console is English and everything the business hands to a person
 * outside it is Bangla. A payslip is handed to a packer in a Gazipur warehouse and a
 * showroom assistant in Gulshan. Writing it in English would be a decision to give
 * somebody a document about their own pay that they cannot read, and doing that "for
 * now" is how it ships forever.
 *
 * The labels below are real Bangla, and several of them exercise the shaping that §22's
 * font requirement exists for: `বেতনের`, `কর্তন`, `প্রাপ্য` and `উপস্থিতি` each contain a
 * conjunct that a font without the right GSUB table renders as separate letters. Numbers
 * stay in Latin digits per D-036, and the taka sign ৳ is U+09F3 from the Bengali block —
 * which is why a single amount needs both font subsets present.
 *
 * ## What is deliberately not on it
 *
 * **No national ID and no bank account number**, not even masked. A payslip is the
 * document most likely to be photographed, forwarded on WhatsApp and left on a desk, and
 * nothing on it needs an identity number to be useful (invariant 10). The employee code
 * identifies the person to the company, which is what a payslip is for.
 *
 * **No signature line.** The document is generated, and a printed line saying
 * "authorised signatory" above nothing is worse than saying so.
 */

export interface PayslipBrand {
  readonly displayName: string;
  readonly legalName: string;
  readonly address?: string | undefined;
  /** OKLCH hue, 0–360. The one accent (§24). Defaults to a neutral ink. */
  readonly accentHue?: number | undefined;
}

export interface PayslipRow {
  readonly label: string;
  readonly amountPoisha: Poisha;
}

export interface PayslipData {
  /** `2026-03`. Rendered as a Bangla month name plus a Latin year. */
  readonly month: string;
  readonly employeeCode: string;
  readonly employeeName: string;
  readonly designation: string | null;
  readonly joinDate: string;
  readonly workingDays: number;
  readonly presentDays: number;
  readonly absentDays: number;
  readonly halfDays: number;
  readonly earnings: readonly PayslipRow[];
  readonly deductions: readonly PayslipRow[];
  readonly grossPoisha: Poisha;
  readonly deductionsPoisha: Poisha;
  readonly netPoisha: Poisha;
  /** What was due on a loan and could not be taken. Omitted when zero. */
  readonly loanShortfallPoisha: Poisha;
  /** `posted` or `paid`, so an unpaid payslip does not claim to be a receipt. */
  readonly runStatus: string;
  readonly paidOn: string | null;
}

/** Bangla month names, indexed by the `MM` in a `YYYY-MM`. */
const BANGLA_MONTHS: readonly string[] = [
  'জানুয়ারি',
  'ফেব্রুয়ারি',
  'মার্চ',
  'এপ্রিল',
  'মে',
  'জুন',
  'জুলাই',
  'আগস্ট',
  'সেপ্টেম্বর',
  'অক্টোবর',
  'নভেম্বর',
  'ডিসেম্বর',
];

export function banglaMonth(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  return `${BANGLA_MONTHS[index] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;
}

/**
 * HTML-escape.
 *
 * Every interpolated value goes through this without exception, the same rule
 * `invoice.template.ts` states: an employee's name is text a person typed and this
 * document is rendered by a real browser inside Gotenberg. The dev container runs
 * `--chromium-disable-javascript=true`, and relying on a container flag for correctness
 * is exactly the dependency that breaks when somebody tunes the compose file.
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
 * Never a float and never division into a `number` (invariant 1): the split happens in
 * bigint arithmetic inside `takaParts`, and only the already-split integer parts become
 * strings. A `poisha / 100` here would be the exact bug the invariant exists to prevent,
 * and on a payslip it would be visible to the person whose salary it is.
 */
export function formatTaka(amount: Poisha): string {
  const { negative, taka, poisha } = takaParts(amount);
  const grouped = taka.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${negative ? '−' : ''}৳${grouped}.${poisha.toString().padStart(2, '0')}`;
}

function rows(list: readonly PayslipRow[]): string {
  if (list.length === 0) {
    return `<tr><td colspan="2" class="empty">—</td></tr>`;
  }
  return list
    .map(
      (row) => `
      <tr>
        <td>${escape(row.label)}</td>
        <td class="money">${formatTaka(row.amountPoisha)}</td>
      </tr>`,
    )
    .join('');
}

export function renderPayslipHtml(input: {
  readonly brand: PayslipBrand;
  readonly data: PayslipData;
  readonly fonts: readonly FontFile[];
}): string {
  const { brand, data, fonts } = input;
  const accent = `oklch(0.55 0.12 ${String(brand.accentHue ?? 250)})`;

  return `<!doctype html>
<html lang="bn">
  <head>
    <meta charset="utf-8" />
    <title>${escape(data.employeeCode)} ${escape(data.month)}</title>
    <style>
${fontFaceCss(fonts)}

      /* §24: neutral chrome, one accent, hairlines rather than shadows. A printed
         document has no hover states and no dark mode, so the token set collapses to
         ink, hairline and the org's accent. */
      :root {
        --ink: oklch(0.22 0.01 260);
        --muted: oklch(0.52 0.01 260);
        --hairline: oklch(0.9 0.005 260);
        --accent: ${accent};
      }

      * { box-sizing: border-box; }

      body {
        margin: 0;
        /* Hind Siliguri for both scripts, so Bangla labels and Latin digits sit on one
           baseline. The fallback exists so a missing font is visibly a different
           typeface rather than a row of boxes. */
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

      .facts { display: flex; gap: 32px; margin: 18px 0 8px; }
      .fact { flex: 1; }
      .fact h2 {
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
      tbody td { padding: 7px 8px; border-bottom: 1px solid var(--hairline); }
      /* Tabular figures so the money column aligns digit for digit (§24). */
      .money { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
      thead th.money { text-align: right; }
      .empty { color: var(--muted); }

      .columns { display: flex; gap: 20px; margin-top: 12px; }
      .columns > section { flex: 1; }

      .totals { margin-top: 16px; margin-left: auto; width: 55%; }
      .totals tr td { border: none; padding: 3px 8px; }
      .totals .label { color: var(--muted); }
      .totals .grand td {
        border-top: 1px solid var(--hairline);
        padding-top: 8px;
        font-weight: 600;
        font-size: 12.5pt;
      }
      .totals .grand .money { color: var(--accent); }

      .attendance { margin-top: 14px; font-size: 10pt; color: var(--muted); }
      .attendance strong { color: var(--ink); font-variant-numeric: tabular-nums; }

      .notice {
        margin-top: 14px;
        padding: 8px 10px;
        border: 1px solid var(--hairline);
        border-radius: 6px;
        font-size: 9.5pt;
        color: var(--muted);
      }

      footer {
        margin-top: 24px;
        padding-top: 10px;
        border-top: 1px solid var(--hairline);
        color: var(--muted);
        font-size: 9.5pt;
      }
    </style>
  </head>
  <body>
    <header>
      <div>
        <div class="brand-name">${escape(brand.displayName)}</div>
        <div class="brand-legal">${escape(brand.legalName)}</div>
        ${brand.address === undefined ? '' : `<div class="brand-legal">${escape(brand.address)}</div>`}
      </div>
      <div>
        <div class="doc-title">বেতনের বিবরণী</div>
        <div class="doc-meta">মাস: ${escape(banglaMonth(data.month))}</div>
        <div class="doc-meta">
          ${data.runStatus === 'paid' ? 'পরিশোধিত' : 'অনুমোদিত, পরিশোধ বাকি'}
        </div>
      </div>
    </header>

    <section class="facts">
      <div class="fact">
        <h2>কর্মীর বিবরণ</h2>
        <div>${escape(data.employeeName)}</div>
        <div class="brand-legal">কর্মী নম্বর: ${escape(data.employeeCode)}</div>
        ${data.designation === null ? '' : `<div class="brand-legal">পদ: ${escape(data.designation)}</div>`}
      </div>
      <div class="fact">
        <h2>চাকরির তথ্য</h2>
        <div class="brand-legal">যোগদান: ${escape(data.joinDate)}</div>
        ${
          data.paidOn === null
            ? ''
            : `<div class="brand-legal">পরিশোধের তারিখ: ${escape(data.paidOn)}</div>`
        }
      </div>
    </section>

    <div class="columns">
      <section>
        <table>
          <thead>
            <tr>
              <th>বেতন ও ভাতা</th>
              <th class="money">টাকা</th>
            </tr>
          </thead>
          <tbody>${rows(data.earnings)}
          </tbody>
        </table>
      </section>
      <section>
        <table>
          <thead>
            <tr>
              <th>কর্তন</th>
              <th class="money">টাকা</th>
            </tr>
          </thead>
          <tbody>${rows(data.deductions)}
          </tbody>
        </table>
      </section>
    </div>

    <table class="totals">
      <tbody>
        <tr>
          <td class="label">মোট বেতন ও ভাতা</td>
          <td class="money">${formatTaka(data.grossPoisha)}</td>
        </tr>
        <tr>
          <td class="label">মোট কর্তন</td>
          <td class="money">${formatTaka(data.deductionsPoisha)}</td>
        </tr>
        <tr class="grand">
          <td>প্রাপ্য বেতন</td>
          <td class="money">${formatTaka(data.netPoisha)}</td>
        </tr>
      </tbody>
    </table>

    <p class="attendance">
      উপস্থিতি — কর্মদিবস <strong>${String(data.workingDays)}</strong>,
      উপস্থিত <strong>${String(data.presentDays)}</strong>,
      অনুপস্থিত <strong>${String(data.absentDays)}</strong>,
      অর্ধদিবস <strong>${String(data.halfDays)}</strong>
    </p>

    ${
      data.loanShortfallPoisha > 0n
        ? `<p class="notice">
             এই মাসে ঋণের কিস্তি থেকে ${formatTaka(data.loanShortfallPoisha)} কাটা যায়নি;
             বাকি অংশ পরের মাসের বেতন থেকে কাটা হবে।
           </p>`
        : ''
    }

    <footer>
      <div>এই বিবরণীটি কম্পিউটারে তৈরি, তাই কোনো স্বাক্ষরের প্রয়োজন নেই।</div>
      <div>হিসাবে কোনো ভুল মনে হলে এইচআর বিভাগে যোগাযোগ করুন।</div>
    </footer>
  </body>
</html>`;
}
