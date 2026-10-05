import { businessDate } from '../dates/index.js';
import { idempotencyKey, isUuid, LedgerError, type JournalDraft } from '../ledger/index.js';
import { mulQty, sum, ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * Stock in hand at the start: **Dr Inventory / Cr Opening balance equity** (M38a, D-602).
 *
 * A brand starting fresh on the ERP already holds stock it bought before the ERP existed.
 * That stock came from no supplier the books know, so it cannot be a supply receipt (which
 * would credit a payable nobody is owed); what it is, in the accountant's words, is the
 * owner's opening position: the brand owns the goods, and the other side is equity, in
 * `3350 Opening balance equity` where the accountant can see it and later clear it.
 *
 * ## How this differs from M14a's opening journal
 *
 * M14a's `openingBalanceDraft` is **one** journal per brand, posted once, whose equity line
 * is a plug against six imported files. This rule is the opposite shape on purpose: one
 * journal **per entry** (a shelf, a box, a product counted in), each keyed on its own entry
 * id, because staff count stock in over days, not in one import. Both sides are derived from
 * the same lines here, so nothing is plugged: the equity credit is exactly Σ qty × cost per
 * piece, the value the movements write into inventory at that cost.
 *
 * Only while the brand's opening stock window is open (D-602): that check is the service's
 * and the database's, not this function's. What this function refuses is a line without a
 * real cost: a piece entered at zero would sit in inventory at nothing and make every later
 * receipt's average wrong, so free stock is not "stock in hand" (it is a stock gain, which
 * needs an approval).
 */

export interface StockInHandLine {
  readonly qty: number;
  /** What one piece cost the brand. Positive: a cost of zero is refused (D-602). */
  readonly unitCostPoisha: Poisha;
}

export interface StockInHandInput {
  /** The entry's id. The idempotency key is `stock_in_hand:<entryId>:posted`. */
  readonly entryId: string;
  readonly occurredAt: Date;
  readonly inventory: PostingAccount;
  /** `3350 Opening balance equity`, subtype `opening_equity`. */
  readonly equity: PostingAccount;
  readonly lines: readonly StockInHandLine[];
  /** The branch the stock is held at, or null for an org-level warehouse. */
  readonly branchId: string | null;
  readonly memo: string | null;
}

/** The most lines one entry holds: a shelf or a delivery, not the whole warehouse. */
export const STOCK_IN_HAND_MAX_LINES = 500;

/** Σ qty × cost per piece, refusing anything that is not a real line. */
export function stockInHandValue(lines: readonly StockInHandLine[]): Poisha {
  if (lines.length === 0) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'Stock in hand needs at least one line.');
  }
  return sum(
    lines.map((line) => {
      if (!Number.isSafeInteger(line.qty) || line.qty <= 0) {
        throw new LedgerError('POSTING_INPUT_INVALID', 'A quantity in hand must be positive.');
      }
      if (line.unitCostPoisha <= 0n) {
        throw new LedgerError(
          'POSTING_INPUT_INVALID',
          'Stock in hand is entered at what each piece cost; a cost of zero is not a cost.',
        );
      }
      return mulQty(line.unitCostPoisha, line.qty);
    }),
  );
}

export function stockInHandDraft(input: StockInHandInput): JournalDraft {
  assertSubtype(input.inventory, 'inventory', 'Stock in hand');
  assertSubtype(input.equity, 'opening_equity', 'The other side of stock in hand');
  if (!isUuid(input.entryId)) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'Stock in hand is keyed on its entry id.');
  }
  if (input.lines.length > STOCK_IN_HAND_MAX_LINES) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'Too many lines for one entry.');
  }

  const total = stockInHandValue(input.lines);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'stock_in_hand',
    sourceId: input.entryId.toLowerCase(),
    event: 'posted',
    // The entry's own key, never the org's: M14a's `opening_balance:<org>:posted` is a
    // different journal that a brand posts once, and this must never collide with it.
    idempotencyKey: idempotencyKey('stock_in_hand', input.entryId, 'posted'),
    memo: input.memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.inventory.accountId,
        debitPoisha: total,
        creditPoisha: ZERO,
        branchId: lineBranch(input.inventory, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.equity.accountId,
        debitPoisha: ZERO,
        creditPoisha: total,
        branchId: lineBranch(input.equity, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
    ],
  };
}
