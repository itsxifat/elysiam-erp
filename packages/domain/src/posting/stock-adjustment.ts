import { businessDate } from '../dates/index.js';
import {
  idempotencyKey,
  LedgerError,
  type JournalDraft,
  type JournalLineDraft,
} from '../ledger/index.js';
import { ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * Stock write-off and stock gain (architecture §7, last two rows), and the opening count
 * correction (D-955):
 *
 *     write-off:                 Dr Inventory write-off  / Cr Inventory
 *     gain:                      Dr Inventory            / Cr Inventory adjustment gain
 *     opening correction, loss:  Dr Opening equity       / Cr Inventory
 *     opening correction, gain:  Dr Inventory            / Cr Opening equity
 *
 * Both need approval, and §7 says so for a reason that is worth stating plainly:
 * a write-off is the one way to make stock disappear without anything leaving the
 * building. It is the entry a thief writes. So the approval is not a workflow
 * nicety — it is the control, the type is in the approvals enum, and §6 routes it
 * to org_admin or to the branch manager whose branch the stock sits in.
 *
 * **Why the opening correction is not a write-off (D-955).** Stock in hand at the start
 * comes in as Dr Inventory / Cr Opening equity: it was never bought in the ERP's books,
 * so it never touched profit. When that count turns out to be wrong (a sheet entered
 * twice, 39 typed for 1), taking the extra pieces back out is undoing part of that
 * opening entry, and it has to land on the same account. Posting it as a write-off
 * books a loss the business never had: Elysiam's first week showed Tk 73,020 of
 * "Inventory write-off" that was in fact its own double-entered opening sheets.
 *
 * A write-off already posted that turns out to have been an opening correction is fixed
 * the ledger's one way (invariant 2): its journal is reversed, and this rule posts it again
 * with `cause: 'opening_correction'` under its own key (`…:opening_corrected`).
 *
 * The amount is qty × WAC, which makes it cost information: `stock_write_off` and
 * `stock_gain` are in `COST_VALUED_APPROVAL_TYPES`, so the approval event carries
 * `amountWithheld` rather than the value (D-074). Nothing about that is this
 * function's business, but it is why the value is computed by the server and
 * never accepted from a client (D-072): a person who could type the amount could
 * write off a lakh of stock at a claimed value of one taka and stay under every
 * threshold.
 */

export type StockAdjustmentDirection = 'loss' | 'gain';

/**
 * What the adjustment is (D-955). `shrinkage` is a real loss or find and goes through profit;
 * `opening_correction` fixes the stock in hand entered at the start and goes to opening
 * equity, only while the opening stock window is open.
 */
export type StockAdjustmentCause = 'shrinkage' | 'opening_correction';

export const STOCK_ADJUSTMENT_CAUSES: readonly StockAdjustmentCause[] = [
  'shrinkage',
  'opening_correction',
];

/** The account an adjustment's other side posts to. */
export function adjustmentCounterSubtype(
  direction: StockAdjustmentDirection,
  cause: StockAdjustmentCause,
): 'inventory_writeoff' | 'inventory_adjustment_gain' | 'opening_equity' {
  if (cause === 'opening_correction') return 'opening_equity';
  return direction === 'loss' ? 'inventory_writeoff' : 'inventory_adjustment_gain';
}

export interface StockAdjustmentInput {
  /** The adjustment row's id. `stock_adjustment:<uuid>:written_off | gained | opening_corrected`. */
  readonly adjustmentId: string;
  readonly occurredAt: Date;
  readonly direction: StockAdjustmentDirection;
  /** Defaults to `shrinkage`. */
  readonly cause?: StockAdjustmentCause;
  readonly inventory: PostingAccount;
  /** See `adjustmentCounterSubtype`. */
  readonly counterAccount: PostingAccount;
  /** qty × WAC, computed by the server. Positive. */
  readonly valuePoisha: Poisha;
  readonly branchId: string | null;
  readonly memo: string | null;
}

function line(account: PostingAccount, branchId: string | null, debit: Poisha, credit: Poisha) {
  return {
    accountId: account.accountId,
    debitPoisha: debit,
    creditPoisha: credit,
    branchId: lineBranch(account, branchId),
    partyType: null,
    partyId: null,
    memo: null,
  } satisfies JournalLineDraft;
}

function assertPositive(valuePoisha: Poisha): void {
  if (valuePoisha <= 0n) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'An adjustment of no value posts nothing; record the movement without a journal.',
    );
  }
}

export function stockAdjustmentDraft(input: StockAdjustmentInput): JournalDraft {
  const cause = input.cause ?? 'shrinkage';
  assertSubtype(input.inventory, 'inventory', 'Adjusted stock');
  assertSubtype(
    input.counterAccount,
    adjustmentCounterSubtype(input.direction, cause),
    cause === 'opening_correction'
      ? 'An opening count correction'
      : input.direction === 'loss'
        ? 'A write-off'
        : 'A stock gain',
  );
  assertPositive(input.valuePoisha);

  const event =
    cause === 'opening_correction'
      ? 'opening_corrected'
      : input.direction === 'loss'
        ? 'written_off'
        : 'gained';
  const value = input.valuePoisha;

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'stock_adjustment',
    sourceId: input.adjustmentId.toLowerCase(),
    event,
    idempotencyKey: idempotencyKey('stock_adjustment', input.adjustmentId, event),
    memo: input.memo,
    reversesJournalId: null,
    lines:
      input.direction === 'loss'
        ? [
            line(input.counterAccount, input.branchId, value, ZERO),
            line(input.inventory, input.branchId, ZERO, value),
          ]
        : [
            line(input.inventory, input.branchId, value, ZERO),
            line(input.counterAccount, input.branchId, ZERO, value),
          ],
  };
}
