import { businessDate } from '../dates/index.js';
import {
  idempotencyKey,
  LedgerError,
  type JournalDraft,
  type JournalLineDraft,
} from '../ledger/index.js';
import { add, mulQty, sub, sum, ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * Delivered, in full or in part (architecture §7 "Delivered (full)" and
 * "Partially delivered"; D-003).
 *
 *     Dr Courier receivable (what the courier collected)
 *     Dr Customer advance   (whatever the buyer had already paid)
 *     Dr Sales discounts    (any shortfall between the two and the value)
 *       Cr Sales revenue          (net item value of the delivered units)
 *       Cr Delivery charge income (the charge, whole)
 *     Dr COGS
 *       Cr Goods in transit  (the delivered units at their dispatch cost)
 *
 * This is the journal that recognises revenue, and D-003 says it happens **here** and
 * nowhere earlier. The reason is COD: a parcel handed to a courier in Bangladesh has a
 * real chance of coming back, and recognising the sale at dispatch overstates a
 * month's P&L by the return rate and then corrects it in the next month, so no monthly
 * figure is ever true. Nothing in this system posts revenue at confirm, pack or
 * handover; handover moves value between two asset accounts (`handoverDraft`) and this
 * is where it becomes a sale.
 *
 * ## One rule for full and partial delivery
 *
 * §7 describes partial delivery as "delivered lines post as above", and the honest way
 * to implement that sentence is one function whose caller passes the delivered
 * quantities. A second `orderPartiallyDeliveredDraft` would be this file with two
 * numbers changed, and the pair would drift the first time a field was added — the
 * kind of drift where the full-delivery path is correct, the partial path is off by a
 * delivery charge, and the difference hides inside a Sales discounts balance.
 *
 * The **collection difference** is the other half of §7's partial rule, and it applies
 * to full deliveries too. What the courier reports collecting rarely disagrees with
 * what we computed, but when it does the difference has to land somewhere, and §7
 * names Sales discounts with a reason. Forcing it onto the courier receivable instead
 * — the tempting shortcut — makes the courier's statement disagree with our
 * receivable, and that disagreement is discovered at settlement, weeks later, as an
 * unexplained gap across hundreds of parcels rather than one order with a note on it.
 *
 * ## Why the cost side takes a dispatch value rather than today's average
 *
 * `costPoisha` is Σ (delivered qty × the unit cost recorded on the dispatch movement),
 * computed by the caller from those movements. Crediting goods in transit at the
 * current weighted average instead would balance perfectly and leave a permanent
 * residue in the account — the failure `handoverDraft` explains at length. Same
 * number, both ends, or the account never returns to zero.
 */

export interface OrderDeliveredInput {
  /** The order's id. `order:<uuid>:delivered` or `:partially_delivered`. */
  readonly orderId: string;
  readonly occurredAt: Date;
  /** True when some ordered units did not arrive, which changes only the event name. */
  readonly partial: boolean;

  readonly courierReceivable: PostingAccount;
  /** The courier the parcel went with: `courier_receivable` is a party subtype (§7). */
  readonly courierId: string;
  readonly salesRevenue: PostingAccount;
  readonly deliveryIncome: PostingAccount;
  readonly cogs: PostingAccount;
  readonly goodsInTransit: PostingAccount;
  /** Needed only when an advance is applied or a collection difference exists. */
  readonly customerAdvance?: PostingAccount | undefined;
  readonly salesDiscounts?: PostingAccount | undefined;

  /** Net item value of the delivered units: items − discount, already apportioned. */
  readonly netItemsPoisha: Poisha;
  /** The delivery charge, whole: the van made the journey once. */
  readonly deliveryChargePoisha: Poisha;
  /** What the buyer had already paid, applied against this delivery. */
  readonly advanceAppliedPoisha: Poisha;
  /** What the courier actually collected at the door. */
  readonly collectedPoisha: Poisha;
  /** Σ delivered qty × the cost recorded on each dispatch movement. */
  readonly costPoisha: Poisha;
  /** Why the collection differs, when it does. §7 asks for one. */
  readonly differenceReason?: string | null;

  readonly branchId: string | null;
  readonly memo: string | null;
}

export function orderDeliveredDraft(input: OrderDeliveredInput): JournalDraft {
  assertSubtype(input.courierReceivable, 'courier_receivable', 'The courier balance');
  assertSubtype(input.salesRevenue, 'sales_revenue', 'Sales');
  assertSubtype(input.deliveryIncome, 'delivery_charge_income', 'The delivery charge');
  assertSubtype(input.cogs, 'cogs', 'Cost of goods sold');
  assertSubtype(input.goodsInTransit, 'goods_in_transit', 'Stock with the courier');

  if (input.courierId.length === 0) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A delivery names the courier that made it.');
  }
  for (const [what, amount] of [
    ['The net item value', input.netItemsPoisha],
    ['The delivery charge', input.deliveryChargePoisha],
    ['The advance applied', input.advanceAppliedPoisha],
    ['The amount collected', input.collectedPoisha],
    ['The dispatch cost', input.costPoisha],
  ] as const) {
    if (amount < 0n) {
      throw new LedgerError('POSTING_INPUT_INVALID', `${what} cannot be negative.`);
    }
  }

  const earned = add(input.netItemsPoisha, input.deliveryChargePoisha);
  if (earned <= 0n) {
    /*
     * A delivery worth nothing.
     *
     * Real — a free replacement, a warranty swap — but there is no revenue journal for
     * it: §7's balance trigger needs two positive sides, and a journal of zero cannot
     * exist. The cost side still has to post, so the caller handles that case by
     * posting the return-style cost journal alone. Refusing here with a code lets it
     * decide deliberately rather than catch a generic failure.
     */
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'This delivery earned nothing, so there is no revenue journal to post.',
    );
  }

  /*
   * The difference, and which side it falls on.
   *
   * `earned` is what the delivery was worth. `advance + collected` is what we have.
   * Short means the courier collected less than the door price — a haggle, a damaged
   * box, a rounding to the nearest note — and §7 sends it to Sales discounts as a
   * debit. Over means they collected more, which is a credit to the same account
   * rather than to revenue: revenue is what we sold for, and an extra fifty taka at
   * the door is not a sale.
   */
  const held = add(input.advanceAppliedPoisha, input.collectedPoisha);
  const difference = sub(earned, held);

  if (difference !== 0n) {
    if (input.salesDiscounts === undefined) {
      throw new LedgerError(
        'POSTING_INPUT_INVALID',
        'The collection differs from the order value, which posts to Sales discounts (§7).',
      );
    }
    assertSubtype(input.salesDiscounts, 'sales_discounts', 'The collection difference');
  }
  if (input.advanceAppliedPoisha > 0n) {
    if (input.customerAdvance === undefined) {
      throw new LedgerError(
        'POSTING_INPUT_INVALID',
        'An advance applied on delivery relieves the customer advance account (§7).',
      );
    }
    assertSubtype(input.customerAdvance, 'customer_advance', 'The buyer’s advance');
  }

  const lines: JournalLineDraft[] = [];

  if (input.collectedPoisha > 0n) {
    lines.push({
      accountId: input.courierReceivable.accountId,
      debitPoisha: input.collectedPoisha,
      creditPoisha: ZERO,
      branchId: lineBranch(input.courierReceivable, input.branchId),
      // Without the party this balance is one number for every courier, and "how much
      // is Steadfast holding of ours" — the question COD reconciliation exists to
      // answer (§7's reports) — stops being answerable.
      partyType: 'courier',
      partyId: input.courierId,
      memo: null,
    });
  }
  if (input.advanceAppliedPoisha > 0n && input.customerAdvance !== undefined) {
    lines.push({
      accountId: input.customerAdvance.accountId,
      debitPoisha: input.advanceAppliedPoisha,
      creditPoisha: ZERO,
      branchId: lineBranch(input.customerAdvance, input.branchId),
      partyType: null,
      partyId: null,
      memo: null,
    });
  }
  if (difference !== 0n && input.salesDiscounts !== undefined) {
    // Widened to `bigint` before negating: `-difference` on a branded numeric trips
    // `no-unsafe-unary-minus`, which exists because a brand can mean something whose
    // negation is not simply the arithmetic one. This one is an ordinary integer.
    const raw: bigint = difference;
    const magnitude = (raw > 0n ? raw : -raw) as Poisha;
    lines.push({
      accountId: input.salesDiscounts.accountId,
      debitPoisha: difference > 0n ? magnitude : ZERO,
      creditPoisha: difference > 0n ? ZERO : magnitude,
      branchId: lineBranch(input.salesDiscounts, input.branchId),
      partyType: null,
      partyId: null,
      // §7 asks for a reason on the difference, and this is where it survives: the
      // account ledger shows the line, and the line says why.
      memo: input.differenceReason ?? 'Collection differed from the order value.',
    });
  }

  /*
   * Conditional, for the same reason the delivery-income and cost pairs below are.
   *
   * `netItems` can legitimately be zero while `earned` is positive: `computeOrderTotals`
   * permits `discount == items`, as does the `orders_discount_within_items` CHECK, so a
   * goodwill replacement where the buyer pays only the delivery charge is a valid order.
   * Pushing the revenue line unconditionally then emitted `Cr 0 / Dr 0`, which
   * `validateJournalDraft` refuses — "exactly one of debit and credit must be positive" —
   * and the whole delivery failed to post. The order stuck in `shipped`, its goods-in-transit
   * debit never cleared, the COGS on a real sale was never recognised, and the charge the
   * rider had already collected could not be booked at all. The `earned > 0` guard above is
   * what keeps the journal from becoming empty.
   */
  if (input.netItemsPoisha > 0n) {
    lines.push({
      accountId: input.salesRevenue.accountId,
      debitPoisha: ZERO,
      creditPoisha: input.netItemsPoisha,
      branchId: lineBranch(input.salesRevenue, input.branchId),
      partyType: null,
      partyId: null,
      memo: null,
    });
  }
  if (input.deliveryChargePoisha > 0n) {
    lines.push({
      accountId: input.deliveryIncome.accountId,
      debitPoisha: ZERO,
      creditPoisha: input.deliveryChargePoisha,
      branchId: lineBranch(input.deliveryIncome, input.branchId),
      partyType: null,
      partyId: null,
      memo: null,
    });
  }

  /*
   * The cost pair, in the same journal.
   *
   * §7 writes it as "and Dr COGS / Cr Goods in transit", and one journal is what makes
   * the gross profit of a delivery a single, self-contained fact. Two journals would
   * balance individually and let a retry post one of them — a delivery whose revenue
   * exists and whose cost does not, which reads as a hundred per cent margin until
   * somebody reconciles goods in transit at year end.
   *
   * Zero when the units are carried at no cost: migrated opening stock, samples. The
   * revenue pair still stands on its own, so the journal stays balanced.
   */
  if (input.costPoisha > 0n) {
    lines.push(
      {
        accountId: input.cogs.accountId,
        debitPoisha: input.costPoisha,
        creditPoisha: ZERO,
        branchId: lineBranch(input.cogs, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.goodsInTransit.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.costPoisha,
        branchId: lineBranch(input.goodsInTransit, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
    );
  }

  const event = input.partial ? 'partially_delivered' : 'delivered';

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'order',
    sourceId: input.orderId.toLowerCase(),
    event,
    idempotencyKey: idempotencyKey('order', input.orderId, event),
    memo: input.memo,
    reversesJournalId: null,
    lines,
  };
}

/** Σ qty × dispatch cost, for a caller holding dispatch movements. */
export function dispatchValue(
  lines: readonly { readonly qty: number; readonly unitCostPoisha: Poisha }[],
): Poisha {
  return sum(
    lines.map((line) => {
      if (!Number.isSafeInteger(line.qty) || line.qty < 0) {
        throw new LedgerError('POSTING_INPUT_INVALID', 'A delivered quantity cannot be negative.');
      }
      if (line.unitCostPoisha < 0n) {
        throw new LedgerError('POSTING_INPUT_INVALID', 'A dispatch cost cannot be negative.');
      }
      return mulQty(line.unitCostPoisha, line.qty);
    }),
  );
}
