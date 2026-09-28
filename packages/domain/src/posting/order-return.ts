import { businessDate } from '../dates/index.js';
import { idempotencyKey, LedgerError, type JournalDraft } from '../ledger/index.js';
import { ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * A customer return received back into stock (architecture §7 "Return received"):
 *
 *     Dr Inventory / Cr Goods in transit   (at the dispatch value)
 *
 * The parcel never became a sale, so there is no revenue to reverse: D-003 recognises
 * revenue on delivery, and this order was never delivered. What happened instead is
 * that an asset travelled out and travelled back, and the only job of this journal is
 * to put its value where the units now are.
 *
 * **At the dispatch value, not at today's average.** The same insistence as
 * `handoverDraft`, and the same failure if it is ignored: handover debited goods in
 * transit with Tuesday's average, a supply arrived on Wednesday and moved the average,
 * and a return credited at Thursday's average leaves a residue in goods in transit
 * forever. Both journals balance. Nothing reports an error. The account simply stops
 * being able to reach zero, and the residue looks like stock in the hands of couriers
 * who gave everything back.
 *
 * ## Damaged units are the same journal
 *
 * §7: "Damaged units go to the `damaged` location; writing them off is a separate step
 * that needs approval." A location is an inventory fact, not a ledger one — the chart
 * has one inventory account and the damaged shelf is inside it — so a return of
 * damaged goods posts exactly this and nothing more. The write-off that follows is
 * M07's `stockAdjustmentDraft` behind an approval, which is what keeps "stock
 * disappeared without leaving the building" a decision somebody signed.
 */

export interface OrderReturnInput {
  /** The order's id. `order:<uuid>:returned`. */
  readonly orderId: string;
  readonly occurredAt: Date;
  readonly inventory: PostingAccount;
  readonly goodsInTransit: PostingAccount;
  /** Σ returned qty × the cost recorded on each dispatch movement. Positive. */
  readonly valuePoisha: Poisha;
  readonly branchId: string | null;
  readonly memo: string | null;
}

export function orderReturnDraft(input: OrderReturnInput): JournalDraft {
  assertSubtype(input.inventory, 'inventory', 'Returned stock');
  assertSubtype(input.goodsInTransit, 'goods_in_transit', 'Stock with the courier');

  if (input.valuePoisha <= 0n) {
    // Units carried at nothing. The movements are still the record of the return; there
    // is simply no journal, because a journal of zero cannot exist (§7's balance
    // trigger needs two positive sides). The caller skips the post.
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'Those units are carried at no cost, so the return posts nothing.',
    );
  }

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'order',
    sourceId: input.orderId.toLowerCase(),
    event: 'returned',
    idempotencyKey: idempotencyKey('order', input.orderId, 'returned'),
    memo: input.memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.inventory.accountId,
        debitPoisha: input.valuePoisha,
        creditPoisha: ZERO,
        branchId: lineBranch(input.inventory, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.goodsInTransit.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.valuePoisha,
        branchId: lineBranch(input.goodsInTransit, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
    ],
  };
}
