/**
 * The reconciliation an accountant signs before go-live (M14a check 5).
 *
 * Three columns per line of the opening position, each from a different place:
 *
 * - **imported**: what the staged files said, through `openingPosition`;
 * - **journal**: what the one opening journal actually carried, read back from the ledger;
 * - **module**: what the owning module reports now — the inventory module's own valuation
 *   (Σ WAC × on hand), and each wallet's, supplier's and courier's ledger balance as of the
 *   opening date.
 *
 * A line agrees only when all three are equal to the poisha. They can differ for real
 * reasons, which is why the report exists: a journal posted before the opening date into
 * the same account, a stock movement since, a wallet that was used before it was opened.
 * Nothing here decides which column is right; it shows the accountant where to look.
 *
 * Stock is the inventory module's valuation *now*, the others are as of the opening date,
 * so the report is run and signed before the brand trades: after the first sale the stock
 * line is expected to move, and the signed copy is the record.
 *
 * Every amount is on its account's normal side and positive when normal: an asset is
 * debit − credit, a liability and equity are credit − debit. A negative figure is the
 * account on its wrong side, shown as it is rather than folded into a sign convention.
 */

import { poisha, sum, ZERO, type Poisha } from '../money/index.js';
import type { OpeningPosition, OpeningSection } from './opening-position.js';

/** One account-and-party figure from one source. `refId` is null for inventory and equity. */
export interface ReconciliationFigure {
  readonly section: OpeningSection;
  readonly refId: string | null;
  readonly amountPoisha: Poisha;
}

export interface ReconciliationInput {
  readonly position: OpeningPosition;
  /** The opening journal's lines, by section, on the normal side. */
  readonly journal: readonly ReconciliationFigure[];
  readonly journalDebitPoisha: Poisha;
  readonly journalCreditPoisha: Poisha;
  /** What each module reports for the same keys. A key it has nothing for is zero. */
  readonly modules: readonly ReconciliationFigure[];
}

export interface ReconciliationRow {
  readonly section: OpeningSection;
  readonly refId: string | null;
  readonly label: string;
  readonly importedPoisha: Poisha;
  readonly journalPoisha: Poisha;
  readonly modulePoisha: Poisha;
  readonly agrees: boolean;
}

export interface Reconciliation {
  readonly rows: readonly ReconciliationRow[];
  readonly journalDebitPoisha: Poisha;
  readonly journalCreditPoisha: Poisha;
  /** The opening journal's own trial balance is zero (check 4). */
  readonly journalBalanced: boolean;
  /** Every row agrees and the journal balances: what a sign-off requires. */
  readonly agrees: boolean;
}

/** The order sections are reported in: assets, then liabilities, then the plug. */
const SECTION_ORDER: readonly OpeningSection[] = [
  'inventory',
  'wallet',
  'supplier_advance',
  'courier_receivable',
  'supplier_payable',
  'opening_equity',
];

const CREDIT_NORMAL: ReadonlySet<OpeningSection> = new Set(['supplier_payable', 'opening_equity']);

function keyOf(section: OpeningSection, refId: string | null): string {
  return `${section}|${refId ?? ''}`;
}

function totals(figures: readonly ReconciliationFigure[]): Map<string, Poisha> {
  const out = new Map<string, Poisha>();
  for (const figure of figures) {
    const key = keyOf(figure.section, figure.refId);
    out.set(key, sum([out.get(key) ?? ZERO, figure.amountPoisha]));
  }
  return out;
}

/** A position line as a normal-side figure. */
export function positionFigures(position: OpeningPosition): ReconciliationFigure[] {
  return position.lines.map((line) => ({
    section: line.section,
    refId: line.refId,
    amountPoisha: poisha(
      CREDIT_NORMAL.has(line.section)
        ? line.creditPoisha - line.debitPoisha
        : line.debitPoisha - line.creditPoisha,
    ),
  }));
}

/** A ledger line or balance, debit and credit, as a normal-side figure for its section. */
export function normalSide(
  section: OpeningSection,
  debitPoisha: bigint,
  creditPoisha: bigint,
): Poisha {
  return poisha(
    CREDIT_NORMAL.has(section) ? creditPoisha - debitPoisha : debitPoisha - creditPoisha,
  );
}

export function reconcileOpening(input: ReconciliationInput): Reconciliation {
  const imported = totals(positionFigures(input.position));
  const journal = totals(input.journal);
  const modules = totals(input.modules);

  const labels = new Map<string, string>();
  const keys: { section: OpeningSection; refId: string | null }[] = [];
  const seen = new Set<string>();
  const add = (section: OpeningSection, refId: string | null, label: string) => {
    const key = keyOf(section, refId);
    if (!labels.has(key)) labels.set(key, label);
    if (seen.has(key)) return;
    seen.add(key);
    keys.push({ section, refId });
  };
  for (const line of input.position.lines) add(line.section, line.refId, line.label);
  // A journal line the files did not account for is the most important row of all, and a
  // balance a module holds that neither the files nor the journal explain comes next.
  for (const figure of input.journal) add(figure.section, figure.refId, figure.refId ?? '');
  for (const figure of input.modules) {
    if (figure.amountPoisha !== 0n) add(figure.section, figure.refId, figure.refId ?? '');
  }

  keys.sort((a, b) => SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section));

  const rows: ReconciliationRow[] = keys.map(({ section, refId }) => {
    const key = keyOf(section, refId);
    const importedPoisha = imported.get(key) ?? ZERO;
    const journalPoisha = journal.get(key) ?? ZERO;
    const modulePoisha = modules.get(key) ?? ZERO;
    return {
      section,
      refId,
      label: labels.get(key) ?? '',
      importedPoisha,
      journalPoisha,
      modulePoisha,
      agrees: importedPoisha === journalPoisha && journalPoisha === modulePoisha,
    };
  });

  const journalBalanced = input.journalDebitPoisha === input.journalCreditPoisha;
  return {
    rows,
    journalDebitPoisha: input.journalDebitPoisha,
    journalCreditPoisha: input.journalCreditPoisha,
    journalBalanced,
    agrees: journalBalanced && rows.length > 0 && rows.every((row) => row.agrees),
  };
}
