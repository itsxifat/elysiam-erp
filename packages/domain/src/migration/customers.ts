/**
 * The customers importer's rules (M14a; §9).
 *
 * Columns: `phone, name` and, optionally, `delivered, returned, cancelled` (blank is zero)
 * and `spent_taka` (what the buyer paid for their delivered orders; blank is zero). They
 * become the buyer's own counters in `sales.customers` — the same `delivered_count`,
 * `returned_count`, `cancelled_count` and lifetime value the order transitions maintain —
 * so the order desk, the buyer profile and the CRM's segments start from what the brand
 * already knows about a number rather than from "new customer".
 *
 * ## A phone that is already a buyer is skipped, never merged (D-218)
 *
 * History is added once per brand and phone. The counters are only ever incremented by
 * the order transitions, so importing the same buyer twice would double their record —
 * and there is no way to subtract it afterwards that is not a guess. The brand's own
 * buyer row is the record that the history was added: if the phone is a buyer already,
 * either an earlier file imported it or they have ordered here since go-live, and in both
 * cases their counters are already where they should be.
 *
 * No dates are imported. Recency in the CRM is read from delivered orders, which an
 * imported buyer has none of, and a first or last order date that is a guess would be
 * shown on the profile as a fact.
 */

import type { CsvTable } from '../catalog/csv.js';
import { takaTextToPoisha } from '../catalog/price-import.js';
import { ZERO, type Poisha } from '../money/index.js';
import { normalizeBdPhone, type E164Phone } from '../orders/phone.js';
import {
  cell,
  checkColumns,
  MAX_OPENING_AMOUNT_POISHA,
  SeenKeys,
  shapeProblem,
  wholeNumber,
  type ImportProblem,
} from './common.js';

export const CUSTOMERS_REQUIRED = ['phone', 'name'] as const;
export const CUSTOMERS_OPTIONAL = ['delivered', 'returned', 'cancelled', 'spent_taka'] as const;

/** A buyer with more parcels than this is a data-entry error, not a buyer. */
export const MAX_HISTORY_COUNT = 10_000;

export interface CustomerImportRow {
  readonly line: number;
  readonly phoneE164: E164Phone;
  readonly name: string;
  readonly delivered: number;
  readonly returned: number;
  readonly cancelled: number;
  /** Selling money the buyer paid, never a cost. Becomes `ltv_poisha`. */
  readonly spentPoisha: Poisha;
}

export interface CustomersRefs {
  /** E.164 phones that are already buyers of this brand. */
  readonly existingPhones: ReadonlySet<string>;
}

export interface CustomersReview {
  readonly rows: readonly CustomerImportRow[];
  /** Lines whose phone is already a buyer: reported, left alone. */
  readonly skipped: readonly { readonly line: number }[];
  readonly problems: readonly ImportProblem[];
}

function spent(text: string): { ok: true; value: Poisha } | { ok: false; message: string } {
  if (text === '') return { ok: true, value: ZERO };
  if (text.startsWith('-')) return { ok: false, message: 'An amount spent is not negative.' };
  try {
    const value = takaTextToPoisha(text);
    if (value > MAX_OPENING_AMOUNT_POISHA) {
      return {
        ok: false,
        message:
          'That amount is beyond the importer’s ceiling. Check for a misplaced decimal point.',
      };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'Not an amount.' };
  }
}

export function reviewCustomers(table: CsvTable, refs: CustomersRefs): CustomersReview {
  const problems: ImportProblem[] = [];
  if (!checkColumns(table, CUSTOMERS_REQUIRED, CUSTOMERS_OPTIONAL, problems)) {
    return { rows: [], skipped: [], problems };
  }

  const seen = new SeenKeys();
  const rows: CustomerImportRow[] = [];
  const skipped: { line: number }[] = [];

  for (const row of table.rows) {
    const shape = shapeProblem(row);
    if (shape !== null) {
      problems.push(shape);
      continue;
    }
    const { line } = row;
    const before = problems.length;

    let phone: E164Phone | null = null;
    try {
      phone = normalizeBdPhone(cell(row, 'phone'));
    } catch {
      // The number itself is never echoed into the report: it is personal data, and the
      // report is printed to a terminal and may be pasted into a chat (invariant 10).
      problems.push({
        line,
        column: 'phone',
        message: 'Not a Bangladeshi mobile number (01XXXXXXXXX, +8801XXXXXXXXX).',
      });
    }

    const name = cell(row, 'name');
    if (name === '' || name.length > 200) {
      problems.push({ line, column: 'name', message: 'A name is 1 to 200 characters.' });
    }

    const counts = (['delivered', 'returned', 'cancelled'] as const).map((column) => {
      const parsed = wholeNumber(cell(row, column), `${column} count`, {
        min: 0,
        max: MAX_HISTORY_COUNT,
        blank: 0,
      });
      if (!parsed.ok) problems.push({ line, column, message: parsed.message });
      return parsed.ok ? parsed.value : 0;
    });
    const [delivered = 0, returned = 0, cancelled = 0] = counts;

    const amount = spent(cell(row, 'spent_taka'));
    if (!amount.ok) problems.push({ line, column: 'spent_taka', message: amount.message });
    else if (amount.value > 0n && delivered === 0) {
      problems.push({
        line,
        column: 'spent_taka',
        message: 'Money spent needs a delivered count: only a delivered order is paid for.',
      });
    }

    if (problems.length !== before || phone === null || !amount.ok) continue;

    const first = seen.claim(phone, line);
    if (first !== undefined) {
      problems.push({
        line,
        column: 'phone',
        message: `The same number is on line ${String(first)}. One row per buyer.`,
      });
      continue;
    }

    if (refs.existingPhones.has(phone)) {
      skipped.push({ line });
      continue;
    }

    rows.push({
      line,
      phoneE164: phone,
      name,
      delivered,
      returned,
      cancelled,
      spentPoisha: amount.value,
    });
  }

  return { rows, skipped, problems };
}
