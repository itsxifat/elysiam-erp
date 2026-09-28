import { businessDate } from '../dates/index.js';
import { idempotencyKey, LedgerError, type JournalDraft } from '../ledger/index.js';
import { mulQty, sum, ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * Order handed to the courier: **Dr Goods in transit / Cr Inventory**
 * (architecture §7).
 *
 * The value is qty × WAC **at handover**, and the emphasis is §7's own: that
 * number is recorded on the dispatch movement, and every later journal about the
 * same parcel — delivered, returned, written off — uses the recorded figure
 * rather than today's average.
 *
 * Skipping that is the subtle way to break invariant 2 without ever posting an
 * unbalanced journal. Handover debits goods in transit at Tuesday's average; a
 * supply arrives Wednesday and the average rises; delivery on Thursday credits
 * goods in transit at the new average. Both journals balance. Goods in transit
 * never returns to zero, and nothing in the system reports an error — it just
 * accumulates a residue that looks like stock in the hands of couriers who
 * delivered everything.
 *
 * Revenue is not recognized here (D-003): handover moves an asset between two
 * asset accounts and nothing else.
 */

export interface HandoverLine {
  readonly qty: number;
  /** The weighted average at the moment of handover, recorded on the movement. */
  readonly unitCostPoisha: Poisha;
}

export interface HandoverInput {
  /** The order's id. `order:<uuid>:handover`. */
  readonly orderId: string;
  readonly occurredAt: Date;
  readonly goodsInTransit: PostingAccount;
  readonly inventory: PostingAccount;
  readonly lines: readonly HandoverLine[];
  readonly branchId: string | null;
  readonly memo: string | null;
}

export function handoverDraft(input: HandoverInput): JournalDraft {
  assertSubtype(input.goodsInTransit, 'goods_in_transit', 'Stock with the courier');
  assertSubtype(input.inventory, 'inventory', 'Dispatched stock');
  if (input.lines.length === 0) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A handover needs at least one line.');
  }

  const total = sum(
    input.lines.map((line) => {
      if (!Number.isSafeInteger(line.qty) || line.qty <= 0) {
        throw new LedgerError('POSTING_INPUT_INVALID', 'A dispatched quantity must be positive.');
      }
      if (line.unitCostPoisha < 0n) {
        throw new LedgerError('POSTING_INPUT_INVALID', 'A dispatch cost cannot be negative.');
      }
      return mulQty(line.unitCostPoisha, line.qty);
    }),
  );
  if (total <= 0n) {
    /*
     * A handover of units whose weighted average is zero.
     *
     * Possible and not absurd — stock entered as an opening balance with no cost,
     * or a sample nobody paid for — but there is no journal to post for it, and a
     * zero journal cannot exist (§7's balance trigger needs two positive sides).
     * The caller records the movement and skips the posting; saying so with a
     * code lets it do that deliberately instead of catching a generic error.
     */
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'Those units are carried at no cost, so a handover posts nothing.',
    );
  }

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'order',
    sourceId: input.orderId.toLowerCase(),
    event: 'handover',
    idempotencyKey: idempotencyKey('order', input.orderId, 'handover'),
    memo: input.memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.goodsInTransit.accountId,
        debitPoisha: total,
        creditPoisha: ZERO,
        branchId: lineBranch(input.goodsInTransit, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.inventory.accountId,
        debitPoisha: ZERO,
        creditPoisha: total,
        branchId: lineBranch(input.inventory, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
    ],
  };
}
