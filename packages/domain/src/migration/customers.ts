/**
 * The customers importer's rules (M14a; §9, §10).
 *
 * Columns: `phone, name` and, optionally, `delivered, returned, cancelled` (blank is zero)
 * and `last_incident_date` (`YYYY-MM-DD`, the last return or cancellation). The counts
 * are the buyer's history with this brand, so M13's fraud score starts from what the brand
 * already knows about a number rather than from "new customer".
 *
 * ## A phone that is already a buyer is skipped, never merged (D-218)
 *
 * History is added once per brand and phone. The fraud counters are shared by all five
 * brands and only ever incremented, so importing the same buyer twice would double their
 * record everywhere — and there is no way to subtract it afterwards that is not a guess.
 * The brand's own buyer row is the record that the history was added: if the phone is a
 * buyer already, either an earlier file imported it or they have ordered here, and in both
 * cases the history is already where it should be.
 */

import type { CsvTable } from '../catalog/csv.js';
import { isIsoDate } from '../dates/index.js';
import { normalizeBdPhone, type E164Phone } from '../orders/phone.js';
import {
  cell,
  checkColumns,
  SeenKeys,
  shapeProblem,
  wholeNumber,
  type ImportProblem,
} from './common.js';

export const CUSTOMERS_REQUIRED = ['phone', 'name'] as const;
export const CUSTOMERS_OPTIONAL = [
  'delivered',
  'returned',
  'cancelled',
  'last_incident_date',
] as const;

/** A buyer with more parcels than this is a data-entry error, not a buyer. */
export const MAX_HISTORY_COUNT = 10_000;

export interface CustomerImportRow {
  readonly line: number;
  readonly phoneE164: E164Phone;
  readonly name: string;
  readonly delivered: number;
  readonly returned: number;
  readonly cancelled: number;
  /** A Dhaka calendar date, or null. Required by nothing; drives the recency penalty. */
  readonly lastIncidentDate: string | null;
}

export interface CustomersRefs {
  /** E.164 phones that are already buyers of this brand. */
  readonly existingPhones: ReadonlySet<string>;
  /** Today in Dhaka, so a history dated in the future is refused. */
  readonly today: string;
}

export interface CustomersReview {
  readonly rows: readonly CustomerImportRow[];
  /** Lines whose phone is already a buyer: reported, left alone. */
  readonly skipped: readonly { readonly line: number }[];
  readonly problems: readonly ImportProblem[];
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
      // report is shown on a screen and may be pasted into a chat (invariant 10).
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

    const dateText = cell(row, 'last_incident_date');
    const lastIncidentDate = dateText === '' ? null : dateText;
    if (lastIncidentDate !== null) {
      if (!isIsoDate(lastIncidentDate)) {
        problems.push({
          line,
          column: 'last_incident_date',
          message: 'A date is written YYYY-MM-DD, such as 2026-03-14.',
        });
      } else if (lastIncidentDate > refs.today) {
        problems.push({
          line,
          column: 'last_incident_date',
          message: 'That date is in the future.',
        });
      } else if ((counts[1] ?? 0) + (counts[2] ?? 0) === 0) {
        problems.push({
          line,
          column: 'last_incident_date',
          message: 'A last return or cancellation date needs a returned or cancelled count.',
        });
      }
    }

    if (problems.length !== before || phone === null) continue;

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
      delivered: counts[0] ?? 0,
      returned: counts[1] ?? 0,
      cancelled: counts[2] ?? 0,
      lastIncidentDate,
    });
  }

  return { rows, skipped, problems };
}
