import { takaText, type Poisha } from '@elysium/domain';

import { DOCUMENT_FONT_STACK, fontFaceCss, type FontFile } from '../files/pdf/fonts.js';

/**
 * The payslip (architecture §12, §22, §24; M43).
 *
 * In formal English (D-750: the brands never wanted Bangla), in Inter (D-753), with every
 * amount as `Tk 1,250.00` through the money module's `takaText` (D-751) and the same black,
 * hairline-ruled page as the order documents, so it prints cleanly on any office printer.
 *
 * ## What is deliberately not on it
 *
 * **No national ID and no bank account number**, not even masked. A payslip is the document
 * most likely to be photographed, forwarded and left on a desk, and nothing on it needs an
 * identity number to be useful (invariant 10). The employee code identifies the person to the
 * company, which is what a payslip is for.
 *
 * **No signature line.** The document is generated, and a printed line saying "authorised
 * signatory" above nothing is worse than saying so.
 */

export interface PayslipBrand {
  readonly displayName: string;
  readonly legalName: string;
  readonly address?: string | undefined;
  /** Kept for callers that pass the brand block's accent; the page is black ink only. */
  readonly accentHue?: number | undefined;
}

export interface PayslipRow {
  readonly label: string;
  readonly amountPoisha: Poisha;
}

export interface PayslipData {
  /** `2026-03`. Rendered as `March 2026`. */
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

const MONTHS: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** `2026-03` → `March 2026`. */
export function payslipMonth(month: string): string {
  const index = Number(month.slice(5, 7)) - 1;
  return `${MONTHS[index] ?? month.slice(5, 7)} ${month.slice(0, 4)}`;
}

/** `2026-03-07` → `7 Mar 2026`; anything else is printed as it came. */
function printedDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match === null) return value;
  const [, year = '', month = '', day = ''] = match;
  return `${String(Number(day))} ${(MONTHS[Number(month) - 1] ?? month).slice(0, 3)} ${year}`;
}

/**
 * HTML-escape.
 *
 * Every interpolated value goes through this without exception: an employee's name is text a
 * person typed and this document is rendered by a real browser inside Gotenberg. The dev
 * container runs `--chromium-disable-javascript=true`, and relying on a container flag for
 * correctness is exactly the dependency that breaks when somebody tunes the compose file.
 */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function rows(list: readonly PayslipRow[]): string {
  if (list.length === 0) {
    return `<tr><td colspan="2" class="empty">None</td></tr>`;
  }
  return list
    .map(
      (row) => `
      <tr>
        <td>${escape(row.label)}</td>
        <td class="money">${escape(takaText(row.amountPoisha))}</td>
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
  const paid = data.runStatus === 'paid';

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escape(data.employeeCode)} ${escape(data.month)}</title>
    <style>
${fontFaceCss(fonts)}
      :root { --ink: #000; --ink-soft: #2b2b2b; --ink-muted: #555; --hairline: #bdbdbd; }
      * { box-sizing: border-box; }
      html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      body {
        margin: 0;
        font-family: ${DOCUMENT_FONT_STACK};
        font-size: 9.5pt;
        line-height: 1.45;
        color: var(--ink);
      }
      .caption {
        font-size: 7pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
        color: var(--ink-muted);
      }
      .gap { margin-top: 2.4mm; }
      header {
        display: flex; justify-content: space-between; align-items: flex-start; gap: 7mm;
        padding-bottom: 4mm; border-bottom: 2pt solid var(--ink);
      }
      .brand-name { font-size: 15pt; font-weight: 700; letter-spacing: -0.01em; line-height: 1.15; }
      .brand-meta { margin-top: 1.2mm; font-size: 8pt; color: var(--ink-muted); }
      .doc { text-align: right; }
      .doc-title { font-size: 7pt; font-weight: 700; letter-spacing: 0.22em; text-transform: uppercase; }
      .month { margin-top: 0.6mm; font-size: 22pt; font-weight: 700; line-height: 1.05; }
      .status { margin-top: 1.6mm; display: inline-block; border: 1pt solid var(--ink); padding: 0.6mm 2mm; font-size: 7.5pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }

      .facts { display: grid; grid-template-columns: 1.2fr 1fr 1fr; gap: 7mm; margin-top: 7mm; }
      .facts .caption { margin-bottom: 1mm; }
      .facts .value { font-weight: 600; }
      .facts .name { font-size: 13pt; font-weight: 700; line-height: 1.2; }

      .columns { display: grid; grid-template-columns: 1fr 1fr; gap: 7mm; margin-top: 7mm; }
      table { width: 100%; border-collapse: collapse; }
      thead th {
        font-size: 7pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase;
        text-align: left; padding: 0 0 1.6mm; border-bottom: 1.5pt solid var(--ink);
      }
      tbody td { padding: 2mm 0; border-bottom: 1px solid var(--hairline); }
      tbody tr:last-child td { border-bottom: 1pt solid var(--ink); }
      .money { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
      thead th.money { text-align: right; }
      .empty { color: var(--ink-muted); }

      .summary { display: grid; grid-template-columns: 1fr 80mm; gap: 7mm; margin-top: 7mm; align-items: start; }
      .attendance { display: grid; grid-template-columns: repeat(4, 1fr); margin-top: 1.6mm; border-top: 1pt solid var(--ink); border-bottom: 1pt solid var(--ink); }
      .attendance > div { padding: 2mm 2.4mm; border-left: 1px solid var(--hairline); }
      .attendance > div:first-child { border-left: none; padding-left: 0; }
      .attendance .value { margin-top: 0.5mm; font-size: 12pt; font-weight: 700; }
      .totals td { padding: 1.2mm 0; border: none; }
      .totals td + td { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
      .totals .label { color: var(--ink-soft); }
      .net { margin-top: 2mm; border: 2pt solid var(--ink); }
      .net-label { background: #000; color: #fff; padding: 1.4mm 3mm; font-size: 7pt; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
      .net-amount { padding: 2.2mm 3mm; font-size: 20pt; font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }

      .notice { margin-top: 6mm; border-left: 2pt solid var(--ink); padding: 0.6mm 0 0.6mm 3mm; font-weight: 500; }

      footer {
        margin-top: 10mm; padding-top: 3mm; border-top: 1px solid var(--hairline);
        color: var(--ink-soft); font-size: 8pt;
      }
    </style>
  </head>
  <body>
    <header>
      <div>
        <div class="brand-name">${escape(brand.displayName)}</div>
        <div class="brand-meta">${escape(brand.legalName)}${
          brand.address === undefined ? '' : `<br />${escape(brand.address)}`
        }</div>
      </div>
      <div class="doc">
        <div class="doc-title">Payslip</div>
        <div class="month">${escape(payslipMonth(data.month))}</div>
        <div class="status">${paid ? 'Paid' : 'Approved, not yet paid'}</div>
      </div>
    </header>

    <section class="facts">
      <div>
        <div class="caption">Employee</div>
        <div class="name">${escape(data.employeeName)}</div>
        ${data.designation === null ? '' : `<div class="value">${escape(data.designation)}</div>`}
      </div>
      <div>
        <div class="caption">Employee code</div>
        <div class="value">${escape(data.employeeCode)}</div>
        <div class="caption gap">Joined</div>
        <div class="value">${escape(printedDate(data.joinDate))}</div>
      </div>
      <div>
        <div class="caption">Pay period</div>
        <div class="value">${escape(payslipMonth(data.month))}</div>
        ${
          data.paidOn === null
            ? ''
            : `<div class="caption gap">Paid on</div><div class="value">${escape(printedDate(data.paidOn))}</div>`
        }
      </div>
    </section>

    <div class="columns">
      <section>
        <table>
          <thead><tr><th>Earnings</th><th class="money">Amount</th></tr></thead>
          <tbody>${rows(data.earnings)}
          </tbody>
        </table>
      </section>
      <section>
        <table>
          <thead><tr><th>Deductions</th><th class="money">Amount</th></tr></thead>
          <tbody>${rows(data.deductions)}
          </tbody>
        </table>
      </section>
    </div>

    <section class="summary">
      <div>
        <div class="caption">Attendance</div>
        <div class="attendance">
          <div><div class="caption">Working days</div><div class="value">${String(data.workingDays)}</div></div>
          <div><div class="caption">Present</div><div class="value">${String(data.presentDays)}</div></div>
          <div><div class="caption">Absent</div><div class="value">${String(data.absentDays)}</div></div>
          <div><div class="caption">Half days</div><div class="value">${String(data.halfDays)}</div></div>
        </div>
      </div>
      <div>
        <table class="totals">
          <tbody>
            <tr><td class="label">Total earnings</td><td>${escape(takaText(data.grossPoisha))}</td></tr>
            <tr><td class="label">Total deductions</td><td>${escape(takaText(data.deductionsPoisha))}</td></tr>
          </tbody>
        </table>
        <div class="net">
          <div class="net-label">Net pay</div>
          <div class="net-amount">${escape(takaText(data.netPoisha))}</div>
        </div>
      </div>
    </section>

    ${
      data.loanShortfallPoisha > 0n
        ? `<p class="notice">${escape(takaText(data.loanShortfallPoisha))} of this month's loan instalment could not be deducted; the balance will be deducted from next month's salary.</p>`
        : ''
    }

    <footer>
      <div>This payslip is computer-generated and needs no signature.</div>
      <div>If anything here looks wrong, please contact the HR department.</div>
    </footer>
  </body>
</html>`;
}
