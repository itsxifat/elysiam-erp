/**
 * The three money importers (M14a): supplier dues and advances, wallet balances, and
 * courier COD still in transit.
 *
 * Each turns a file into lines of the opening journal and nothing else. Every amount is
 * positive and lands on its account's normal side — a payable is credited, an advance,
 * a wallet and a courier receivable are debited — and the equity plug is whatever is
 * left (D-213). So a sign typed in a file is never interpreted: a negative wallet is an
 * overdraft somebody must explain, not an amount to flip.
 *
 * Every importer refuses a key that appears twice — in the file, or in a file already
 * staged — rather than adding the two. Two rows for one supplier means the file was
 * assembled from two sources, and summing them would be a decision the operator did not
 * know they were making.
 */

import type { CsvTable } from '../catalog/csv.js';
import { sum, ZERO, type Poisha } from '../money/index.js';
import {
  cell,
  checkColumns,
  positiveAmount,
  SeenKeys,
  shapeProblem,
  type ImportProblem,
  type Review,
} from './common.js';

function total(rows: readonly { readonly amountPoisha: Poisha }[]): Poisha {
  return rows.length === 0 ? ZERO : sum(rows.map((row) => row.amountPoisha));
}

// --- supplier dues and advances ----------------------------------------------------

export const SUPPLIER_BALANCE_REQUIRED = ['supplier', 'kind', 'amount_taka'] as const;
export const SUPPLIER_BALANCE_OPTIONAL = ['note'] as const;

/** `payable`: the brand owes the supplier. `advance`: the brand paid ahead. */
export type SupplierBalanceKind = 'payable' | 'advance';

export interface SupplierBalanceRow {
  readonly line: number;
  readonly supplierId: string;
  readonly supplierCode: string;
  readonly kind: SupplierBalanceKind;
  readonly amountPoisha: Poisha;
}

export interface SupplierBalanceRefs {
  /** By upper-case code. */
  readonly suppliers: ReadonlyMap<string, { readonly id: string }>;
  readonly staged: readonly SupplierBalanceRow[];
}

export interface SupplierBalanceTotals {
  readonly rows: number;
  readonly payablePoisha: Poisha;
  readonly advancePoisha: Poisha;
}

export function supplierBalanceTotals(rows: readonly SupplierBalanceRow[]): SupplierBalanceTotals {
  return {
    rows: rows.length,
    payablePoisha: total(rows.filter((row) => row.kind === 'payable')),
    advancePoisha: total(rows.filter((row) => row.kind === 'advance')),
  };
}

export function reviewSupplierBalances(
  table: CsvTable,
  refs: SupplierBalanceRefs,
): Review<SupplierBalanceRow> & { readonly totals: SupplierBalanceTotals } {
  const problems: ImportProblem[] = [];
  if (!checkColumns(table, SUPPLIER_BALANCE_REQUIRED, SUPPLIER_BALANCE_OPTIONAL, problems)) {
    return { rows: [], problems, totals: supplierBalanceTotals([]) };
  }

  const staged = new Set(refs.staged.map((row) => `${row.supplierId}|${row.kind}`));
  const seen = new SeenKeys();
  const rows: SupplierBalanceRow[] = [];

  for (const row of table.rows) {
    const shape = shapeProblem(row);
    if (shape !== null) {
      problems.push(shape);
      continue;
    }
    const { line } = row;
    const before = problems.length;

    const code = cell(row, 'supplier').toUpperCase();
    const supplier = refs.suppliers.get(code);
    if (code === '') problems.push({ line, column: 'supplier', message: 'The supplier is blank.' });
    else if (supplier === undefined) {
      problems.push({ line, column: 'supplier', message: `No supplier "${code}" in this brand.` });
    }

    const kindText = cell(row, 'kind').toLowerCase();
    const kind: SupplierBalanceKind | null =
      kindText === 'payable' || kindText === 'advance' ? kindText : null;
    if (kind === null) {
      problems.push({
        line,
        column: 'kind',
        message: 'The kind is "payable" (the brand owes the supplier) or "advance" (paid ahead).',
      });
    }

    const amount = positiveAmount(cell(row, 'amount_taka'), 'amount');
    if (!amount.ok) problems.push({ line, column: 'amount_taka', message: amount.message });

    if (problems.length !== before || supplier === undefined || kind === null || !amount.ok) {
      continue;
    }

    const key = `${supplier.id}|${kind}`;
    const first = seen.claim(key, line);
    if (first !== undefined) {
      problems.push({
        line,
        column: 'supplier',
        message: `The ${kind} for "${code}" also appears on line ${String(first)}. One row per supplier and kind.`,
      });
      continue;
    }
    if (staged.has(key)) {
      problems.push({
        line,
        column: 'supplier',
        message: `The ${kind} for "${code}" is already in a staged file. Discard that file first to replace it.`,
      });
      continue;
    }

    rows.push({
      line,
      supplierId: supplier.id,
      supplierCode: code,
      kind,
      amountPoisha: amount.value,
    });
  }

  return { rows, problems, totals: supplierBalanceTotals(rows) };
}

// --- wallet balances -----------------------------------------------------------------

export const WALLET_BALANCE_REQUIRED = ['wallet', 'amount_taka'] as const;
export const WALLET_BALANCE_OPTIONAL = ['note'] as const;

export interface WalletBalanceRow {
  readonly line: number;
  readonly walletId: string;
  /** The wallet's ledger account code, which is how the file names it. */
  readonly accountCode: string;
  readonly amountPoisha: Poisha;
}

export interface WalletBalanceRefs {
  /** By ledger account code, active wallets only. */
  readonly wallets: ReadonlyMap<string, { readonly id: string }>;
  readonly staged: readonly WalletBalanceRow[];
}

export interface WalletBalanceTotals {
  readonly rows: number;
  readonly amountPoisha: Poisha;
}

export function walletBalanceTotals(rows: readonly WalletBalanceRow[]): WalletBalanceTotals {
  return { rows: rows.length, amountPoisha: total(rows) };
}

export function reviewWalletBalances(
  table: CsvTable,
  refs: WalletBalanceRefs,
): Review<WalletBalanceRow> & { readonly totals: WalletBalanceTotals } {
  const problems: ImportProblem[] = [];
  if (!checkColumns(table, WALLET_BALANCE_REQUIRED, WALLET_BALANCE_OPTIONAL, problems)) {
    return { rows: [], problems, totals: walletBalanceTotals([]) };
  }

  const staged = new Set(refs.staged.map((row) => row.walletId));
  const seen = new SeenKeys();
  const rows: WalletBalanceRow[] = [];

  for (const row of table.rows) {
    const shape = shapeProblem(row);
    if (shape !== null) {
      problems.push(shape);
      continue;
    }
    const { line } = row;
    const before = problems.length;

    const code = cell(row, 'wallet').toUpperCase();
    const wallet = refs.wallets.get(code);
    if (code === '') problems.push({ line, column: 'wallet', message: 'The wallet is blank.' });
    else if (wallet === undefined) {
      problems.push({
        line,
        column: 'wallet',
        message: `No wallet with account code "${code}" in this brand, or it is closed.`,
      });
    }

    const amount = positiveAmount(cell(row, 'amount_taka'), 'balance');
    if (!amount.ok) problems.push({ line, column: 'amount_taka', message: amount.message });

    if (problems.length !== before || wallet === undefined || !amount.ok) continue;

    const first = seen.claim(wallet.id, line);
    if (first !== undefined) {
      problems.push({
        line,
        column: 'wallet',
        message: `"${code}" also appears on line ${String(first)}. One row per wallet.`,
      });
      continue;
    }
    if (staged.has(wallet.id)) {
      problems.push({
        line,
        column: 'wallet',
        message: `"${code}" is already in a staged file. Discard that file first to replace it.`,
      });
      continue;
    }

    rows.push({ line, walletId: wallet.id, accountCode: code, amountPoisha: amount.value });
  }

  return { rows, problems, totals: walletBalanceTotals(rows) };
}

// --- courier COD in transit ----------------------------------------------------------

export const COURIER_COD_REQUIRED = ['courier', 'reference', 'amount_taka'] as const;
export const COURIER_COD_OPTIONAL = ['note'] as const;

/** A legacy parcel reference: what the courier's own statement will print. */
const REFERENCE_SHAPE = /^[\x21-\x7e]{1,64}$/;

export interface CourierCodRow {
  readonly line: number;
  readonly courierId: string;
  readonly courierCode: string;
  readonly reference: string;
  readonly amountPoisha: Poisha;
}

export interface CourierCodRefs {
  /** By lower-case courier code (`steadfast`, `pathao`, …). */
  readonly couriers: ReadonlyMap<string, { readonly id: string }>;
  readonly staged: readonly CourierCodRow[];
}

export interface CourierCodTotals {
  readonly rows: number;
  readonly amountPoisha: Poisha;
}

export function courierCodTotals(rows: readonly CourierCodRow[]): CourierCodTotals {
  return { rows: rows.length, amountPoisha: total(rows) };
}

export function reviewCourierCod(
  table: CsvTable,
  refs: CourierCodRefs,
): Review<CourierCodRow> & { readonly totals: CourierCodTotals } {
  const problems: ImportProblem[] = [];
  if (!checkColumns(table, COURIER_COD_REQUIRED, COURIER_COD_OPTIONAL, problems)) {
    return { rows: [], problems, totals: courierCodTotals([]) };
  }

  const staged = new Set(refs.staged.map((row) => `${row.courierId}|${row.reference}`));
  const seen = new SeenKeys();
  const rows: CourierCodRow[] = [];

  for (const row of table.rows) {
    const shape = shapeProblem(row);
    if (shape !== null) {
      problems.push(shape);
      continue;
    }
    const { line } = row;
    const before = problems.length;

    const code = cell(row, 'courier').toLowerCase();
    const courier = refs.couriers.get(code);
    if (code === '') problems.push({ line, column: 'courier', message: 'The courier is blank.' });
    else if (courier === undefined) {
      problems.push({ line, column: 'courier', message: `No courier "${code}" in this brand.` });
    }

    const reference = cell(row, 'reference');
    if (!REFERENCE_SHAPE.test(reference)) {
      problems.push({
        line,
        column: 'reference',
        message:
          "The parcel reference is the courier's consignment id: up to 64 characters, no spaces.",
      });
    }

    const amount = positiveAmount(cell(row, 'amount_taka'), 'amount');
    if (!amount.ok) problems.push({ line, column: 'amount_taka', message: amount.message });

    if (problems.length !== before || courier === undefined || !amount.ok) continue;

    const key = `${courier.id}|${reference}`;
    const first = seen.claim(key, line);
    if (first !== undefined) {
      problems.push({
        line,
        column: 'reference',
        message: `"${reference}" also appears on line ${String(first)}. One row per parcel.`,
      });
      continue;
    }
    if (staged.has(key)) {
      problems.push({
        line,
        column: 'reference',
        message: `"${reference}" is already in a staged file. Discard that file first to replace it.`,
      });
      continue;
    }

    rows.push({
      line,
      courierId: courier.id,
      courierCode: code,
      reference,
      amountPoisha: amount.value,
    });
  }

  return { rows, problems, totals: courierCodTotals(rows) };
}
