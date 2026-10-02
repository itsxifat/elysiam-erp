/**
 * The opening trial balance, from the staged rows alone (M14a check 1).
 *
 * What an accountant looks at before anything is posted: every line the opening journal
 * will carry, grouped the way the journal groups them, and the equity plug that balances
 * it (D-213). Computed here with no database, so the dry run, the posting step and the
 * reconciliation report all read the same arithmetic — a dry run with its own idea of the
 * totals is worse than no dry run, because it teaches people to trust it.
 *
 * Each amount lands on its account's normal side and nowhere else: stock, wallet money,
 * supplier advances and courier receivable are debits; supplier payables are credits. The
 * plug goes to whichever side balances, credit when the brand owns more than it owes.
 */

import type { IsoDate } from '../dates/index.js';
import { LedgerError, type JournalDraft } from '../ledger/index.js';
import { mulQty, negate, sum, ZERO, type Poisha } from '../money/index.js';
import { openingBalanceDraft, type OpeningLine } from '../posting/opening-balance.js';
import type { PostingAccount } from '../posting/supply-received.js';
import type { CourierCodRow, SupplierBalanceRow, WalletBalanceRow } from './balances.js';
import type { OpeningStockRow } from './opening-stock.js';

export type OpeningSection =
  | 'inventory'
  | 'wallet'
  | 'supplier_advance'
  | 'courier_receivable'
  | 'supplier_payable'
  | 'opening_equity';

export interface OpeningPositionLine {
  readonly section: OpeningSection;
  /** The wallet, supplier or courier the line belongs to; null for inventory and equity. */
  readonly refId: string | null;
  /** How the files named it: a wallet's account code, a supplier or courier code. */
  readonly label: string;
  readonly debitPoisha: Poisha;
  readonly creditPoisha: Poisha;
}

export interface OpeningPositionInput {
  readonly stock: readonly OpeningStockRow[];
  readonly suppliers: readonly SupplierBalanceRow[];
  readonly wallets: readonly WalletBalanceRow[];
  readonly couriers: readonly CourierCodRow[];
}

export interface OpeningPosition {
  readonly lines: readonly OpeningPositionLine[];
  readonly totalDebitPoisha: Poisha;
  readonly totalCreditPoisha: Poisha;
  /** Assets − liabilities. Positive is credited to equity, negative debited. */
  readonly equityPoisha: Poisha;
  readonly balanced: boolean;
  /** Σ(qty × unit cost) over every stock row: the inventory line, and check 1's figure. */
  readonly stockValuePoisha: Poisha;
  readonly units: number;
}

function totalOf(values: readonly Poisha[]): Poisha {
  return values.length === 0 ? ZERO : sum(values);
}

/** Sum amounts per key, keeping the first label seen and the order keys first appear in. */
function grouped<Row>(
  rows: readonly Row[],
  key: (row: Row) => string,
  label: (row: Row) => string,
  amount: (row: Row) => Poisha,
): { refId: string; label: string; amountPoisha: Poisha }[] {
  const out = new Map<string, { refId: string; label: string; amounts: Poisha[] }>();
  for (const row of rows) {
    const id = key(row);
    const entry = out.get(id) ?? { refId: id, label: label(row), amounts: [] };
    entry.amounts.push(amount(row));
    out.set(id, entry);
  }
  return [...out.values()].map((entry) => ({
    refId: entry.refId,
    label: entry.label,
    amountPoisha: totalOf(entry.amounts),
  }));
}

export function openingPosition(input: OpeningPositionInput): OpeningPosition {
  const stockValuePoisha = totalOf(input.stock.map((row) => mulQty(row.unitCostPoisha, row.qty)));
  const units = input.stock.reduce((count, row) => count + row.qty, 0);

  const debit = (section: OpeningSection, refId: string | null, label: string, amount: Poisha) =>
    ({ section, refId, label, debitPoisha: amount, creditPoisha: ZERO }) as const;
  const credit = (section: OpeningSection, refId: string | null, label: string, amount: Poisha) =>
    ({ section, refId, label, debitPoisha: ZERO, creditPoisha: amount }) as const;

  const lines: OpeningPositionLine[] = [];
  if (stockValuePoisha > 0n) lines.push(debit('inventory', null, 'Inventory', stockValuePoisha));

  for (const wallet of grouped(
    input.wallets,
    (row) => row.walletId,
    (row) => row.accountCode,
    (row) => row.amountPoisha,
  )) {
    lines.push(debit('wallet', wallet.refId, wallet.label, wallet.amountPoisha));
  }

  for (const advance of grouped(
    input.suppliers.filter((row) => row.kind === 'advance'),
    (row) => row.supplierId,
    (row) => row.supplierCode,
    (row) => row.amountPoisha,
  )) {
    lines.push(debit('supplier_advance', advance.refId, advance.label, advance.amountPoisha));
  }

  for (const courier of grouped(
    input.couriers,
    (row) => row.courierId,
    (row) => row.courierCode,
    (row) => row.amountPoisha,
  )) {
    lines.push(debit('courier_receivable', courier.refId, courier.label, courier.amountPoisha));
  }

  for (const payable of grouped(
    input.suppliers.filter((row) => row.kind === 'payable'),
    (row) => row.supplierId,
    (row) => row.supplierCode,
    (row) => row.amountPoisha,
  )) {
    lines.push(credit('supplier_payable', payable.refId, payable.label, payable.amountPoisha));
  }

  const assets = totalOf(lines.map((line) => line.debitPoisha));
  const liabilities = totalOf(lines.map((line) => line.creditPoisha));
  const equityPoisha = (assets - liabilities) as Poisha;

  if (equityPoisha > 0n) {
    lines.push(credit('opening_equity', null, 'Opening balance equity', equityPoisha));
  }
  if (equityPoisha < 0n) {
    lines.push(debit('opening_equity', null, 'Opening balance equity', negate(equityPoisha)));
  }

  const totalDebitPoisha = totalOf(lines.map((line) => line.debitPoisha));
  const totalCreditPoisha = totalOf(lines.map((line) => line.creditPoisha));

  return {
    lines,
    totalDebitPoisha,
    totalCreditPoisha,
    equityPoisha,
    balanced: totalDebitPoisha === totalCreditPoisha,
    stockValuePoisha,
    units,
  };
}

/** The accounts the opening journal posts to, resolved by the caller from the org's chart. */
export interface OpeningAccounts {
  readonly inventory: PostingAccount;
  readonly supplierAdvance: PostingAccount;
  readonly supplierPayable: PostingAccount;
  readonly courierReceivable: PostingAccount;
  readonly equity: PostingAccount;
  /** Each staged wallet's own ledger account, by wallet id. */
  readonly wallets: ReadonlyMap<string, PostingAccount>;
}

/**
 * The opening journal for a position (D-213), through the posting rule.
 *
 * One journal line per position line except the plug, which `openingBalanceDraft`
 * derives itself — and the result is checked against the position's own equity figure,
 * so the trial balance the accountant was shown and the journal that posts cannot be two
 * different pieces of arithmetic.
 */
export function openingJournal(
  position: OpeningPosition,
  input: {
    readonly orgId: string;
    readonly asOf: IsoDate;
    readonly accounts: OpeningAccounts;
    readonly memo?: string | null;
  },
): JournalDraft {
  const { accounts } = input;
  const assets: OpeningLine[] = [];
  const liabilities: OpeningLine[] = [];

  for (const line of position.lines) {
    switch (line.section) {
      case 'inventory':
        assets.push({
          account: accounts.inventory,
          amountPoisha: line.debitPoisha,
          memo: 'Opening stock',
        });
        break;
      case 'wallet': {
        const account = line.refId === null ? undefined : accounts.wallets.get(line.refId);
        if (account === undefined) {
          throw new LedgerError(
            'POSTING_INPUT_INVALID',
            `The wallet ${line.label} has no ledger account to open into.`,
          );
        }
        assets.push({ account, amountPoisha: line.debitPoisha, memo: 'Opening balance' });
        break;
      }
      case 'supplier_advance':
        assets.push({
          account: accounts.supplierAdvance,
          amountPoisha: line.debitPoisha,
          partyType: 'supplier',
          partyId: line.refId,
          memo: 'Opening advance',
        });
        break;
      case 'courier_receivable':
        assets.push({
          account: accounts.courierReceivable,
          amountPoisha: line.debitPoisha,
          partyType: 'courier',
          partyId: line.refId,
          memo: 'COD in transit at opening',
        });
        break;
      case 'supplier_payable':
        liabilities.push({
          account: accounts.supplierPayable,
          amountPoisha: line.creditPoisha,
          partyType: 'supplier',
          partyId: line.refId,
          memo: 'Opening due',
        });
        break;
      case 'opening_equity':
        // Derived by the posting rule from the lines above, and checked below.
        break;
    }
  }

  const draft = openingBalanceDraft({
    orgId: input.orgId,
    asOf: input.asOf,
    assets,
    liabilities,
    equity: accounts.equity,
    memo: input.memo ?? null,
  });

  const plug = draft.lines
    .filter((line) => line.accountId === accounts.equity.accountId)
    .reduce((total, line) => total + line.creditPoisha - line.debitPoisha, 0n);
  if (plug !== position.equityPoisha) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'The opening journal and the opening position disagree on equity.',
    );
  }
  return draft;
}
