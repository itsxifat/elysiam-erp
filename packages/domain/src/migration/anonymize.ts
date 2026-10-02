/**
 * Anonymising a brand's migration files for the training org (M14a, D-223).
 *
 * The demo org is seeded by running the real importers over these tables, so what comes
 * out has to be a valid import file — and it must not carry a buyer's phone or name.
 *
 * - **Phones are replaced by position, not derived from the number.** A fake computed
 *   from the real phone — any hash, keyed or not — can be reversed by trying all of
 *   Bangladesh's mobile numbers, which a laptop does in minutes. A fake that depends only
 *   on the row's position carries nothing about the buyer at all, and is still
 *   deterministic: the same file gives the same demo.
 * - **Names come from a fixed list**, by position, for the same reason.
 * - **Money is scaled by one constant**, rounded half away from zero to whole poisha. The
 *   same input amount always gives the same output, so a SKU's one cost stays one cost
 *   (D-216). The constant is in this file, so scaling hides nothing from anyone who reads
 *   it: this protects people, not a brand's figures, which is why `pnpm demo:org` runs the
 *   repository's synthetic sample only and takes no other directory (D-223).
 * - **A courier reference becomes `DEMO-<n>`**: a consignment id is a key into the
 *   courier's own records of a real parcel to a real address.
 *
 * Product names, SKU codes, locations, supplier and courier codes are the brand's
 * catalogue and set-up, not personal data, and are kept so the demo looks like the brand.
 */

import type { CsvRow, CsvTable } from '../catalog/csv.js';
import { takaTextToPoisha } from '../catalog/price-import.js';
import { divideRounded } from '../money/index.js';
import { normalizeBdPhone } from '../orders/phone.js';
import type { MigrationKind } from './common.js';

/** Names a trainee will recognise as made up. Bangla and English, as buyers write them. */
export const DEMO_NAMES: readonly string[] = [
  'Demo Buyer',
  'Training Customer',
  'Rahim Demo',
  'Karim Practice',
  'Ayesha Sample',
  'Nusrat Example',
  'ডেমো ক্রেতা',
  'অনুশীলন গ্রাহক',
];

/** The money scale: the demo's figures are 7/10 of the source's. */
export const DEMO_MONEY_SCALE = { numerator: 7n, denominator: 10n } as const;

const MONEY_COLUMNS = new Set(['price_taka', 'unit_cost_taka', 'amount_taka', 'spent_taka']);

/**
 * The fake phone for the row at `index`: `+88019` and eight digits of the index.
 *
 * Valid by `normalizeBdPhone`'s rules, because the importer refuses anything else. It is
 * still a real number range, which is why the notify module suppresses every message the
 * training org queues (D-223): a trainee practising templates must not text a stranger.
 */
export function demoPhone(index: number): string {
  return `+88019${String(90_000_000 + (index % 10_000_000)).padStart(8, '0')}`;
}

export function demoName(index: number): string {
  return DEMO_NAMES[index % DEMO_NAMES.length] ?? 'Demo Buyer';
}

/**
 * Taka text scaled by `DEMO_MONEY_SCALE`. Zero stays zero; anything else never falls
 * below one poisha, so a valid amount stays a valid amount.
 */
export function scaleTaka(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return trimmed;
  const amount = takaTextToPoisha(trimmed);
  if (amount === 0n) return '0.00';
  const scaled = divideRounded(amount * DEMO_MONEY_SCALE.numerator, DEMO_MONEY_SCALE.denominator);
  const atLeast = scaled < 1n ? 1n : scaled;
  const whole = atLeast / 100n;
  const fraction = atLeast % 100n;
  return `${whole.toString()}.${fraction.toString().padStart(2, '0')}`;
}

/**
 * The fake phone for each row, by position, skipping any number the file itself holds.
 *
 * Position alone could hand a row a fake that happens to be a real buyer's number in the
 * same file — the demo range is a real number range — and then the demo would carry that
 * buyer's phone after all. Skipping the file's own numbers rules it out, and the result
 * is still deterministic: the same file gives the same fakes.
 */
function fakePhones(table: CsvTable): string[] {
  const source = new Set<string>();
  for (const row of table.rows) {
    try {
      source.add(normalizeBdPhone(row.values.phone ?? ''));
    } catch {
      // Not a phone; the importer reports it, and it cannot collide with a fake.
    }
  }
  const phones: string[] = [];
  let next = 0;
  for (const _row of table.rows) {
    while (source.has(demoPhone(next))) next += 1;
    phones.push(demoPhone(next));
    next += 1;
  }
  return phones;
}

/** The same table with every personal field replaced and every amount scaled. */
export function anonymizeTable(kind: MigrationKind, table: CsvTable): CsvTable {
  const phones = kind === 'customers' ? fakePhones(table) : [];
  const rows: CsvRow[] = table.rows.map((row, index) => {
    const values: Record<string, string> = {};
    for (const header of table.headers) {
      const value = row.values[header] ?? '';
      if (kind === 'customers' && header === 'phone') {
        values[header] = phones[index] ?? demoPhone(index);
      } else if (kind === 'customers' && header === 'name') values[header] = demoName(index);
      else if (kind === 'courier_cod' && header === 'reference') {
        values[header] = `DEMO-${String(index + 1).padStart(5, '0')}`;
      } else if (MONEY_COLUMNS.has(header)) values[header] = scaleTaka(value);
      else values[header] = value;
    }
    return { line: row.line, values };
  });
  return { headers: table.headers, rows };
}

function quoted(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Back to CSV text the importers read: header row, then one line per row, `\n` endings. */
export function toCsv(table: CsvTable): string {
  const lines = [table.headers.map(quoted).join(',')];
  for (const row of table.rows) {
    lines.push(table.headers.map((header) => quoted(row.values[header] ?? '')).join(','));
  }
  return `${lines.join('\n')}\n`;
}
