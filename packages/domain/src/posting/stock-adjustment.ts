import { businessDate } from '../dates/index.js';
import { idempotencyKey, LedgerError, type JournalDraft } from '../ledger/index.js';
import { ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * Stock write-off and stock gain (architecture §7, last two rows):
 *
 *     write-off: Dr Inventory write-off / Cr Inventory
 *     gain:      Dr Inventory          / Cr Inventory adjustment gain
 *
 * Both need approval, and §7 says so for a reason that is worth stating plainly:
 * a write-off is the one way to make stock disappear without anything leaving the
 * building. It is the entry a thief writes. So the approval is not a workflow
 * nicety — it is the control, the type is in the approvals enum, and §6 routes it
 * to org_admin or to the branch manager whose branch the stock sits in.
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

export interface StockAdjustmentInput {
  /** The adjustment row's id. `stock_adjustment:<uuid>:written_off | gained`. */
  readonly adjustmentId: string;
  readonly occurredAt: Date;
  readonly direction: StockAdjustmentDirection;
  readonly inventory: PostingAccount;
  /** `inventory_writeoff` for a loss, `inventory_adjustment_gain` for a gain. */
  readonly counterAccount: PostingAccount;
  /** qty × WAC, computed by the server. Positive. */
  readonly valuePoisha: Poisha;
  readonly branchId: string | null;
  readonly memo: string | null;
}

export function stockAdjustmentDraft(input: StockAdjustmentInput): JournalDraft {
  assertSubtype(input.inventory, 'inventory', 'Adjusted stock');
  assertSubtype(
    input.counterAccount,
    input.direction === 'loss' ? 'inventory_writeoff' : 'inventory_adjustment_gain',
    input.direction === 'loss' ? 'A write-off' : 'A stock gain',
  );
  if (input.valuePoisha <= 0n) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'An adjustment of no value posts nothing; record the movement without a journal.',
    );
  }

  const event = input.direction === 'loss' ? 'written_off' : 'gained';
  const inventoryBranch = lineBranch(input.inventory, input.branchId);
  const counterBranch = lineBranch(input.counterAccount, input.branchId);

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
            {
              accountId: input.counterAccount.accountId,
              debitPoisha: input.valuePoisha,
              creditPoisha: ZERO,
              branchId: counterBranch,
              partyType: null,
              partyId: null,
              memo: null,
            },
            {
              accountId: input.inventory.accountId,
              debitPoisha: ZERO,
              creditPoisha: input.valuePoisha,
              branchId: inventoryBranch,
              partyType: null,
              partyId: null,
              memo: null,
            },
          ]
        : [
            {
              accountId: input.inventory.accountId,
              debitPoisha: input.valuePoisha,
              creditPoisha: ZERO,
              branchId: inventoryBranch,
              partyType: null,
              partyId: null,
              memo: null,
            },
            {
              accountId: input.counterAccount.accountId,
              debitPoisha: ZERO,
              creditPoisha: input.valuePoisha,
              branchId: counterBranch,
              partyType: null,
              partyId: null,
              memo: null,
            },
          ],
  };
}
