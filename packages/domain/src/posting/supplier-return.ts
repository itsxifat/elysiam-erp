import { businessDate } from '../dates/index.js';
import {
  idempotencyKey,
  isUuid,
  LedgerError,
  type JournalDraft,
  type JournalLineDraft,
} from '../ledger/index.js';
import { supplierReturnVariance } from '../inventory/index.js';
import { add, poisha, ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * Supplier return (architecture §7, §8):
 *
 *     Dr Supplier payable   qty × original unit cost
 *     Cr Inventory          qty × current WAC
 *     Dr or Cr Purchase price variance   the difference
 *
 * Two different unit costs in one journal, and that is the whole point of the
 * rule. The supplier is credited what they charged, because that is what the
 * invoice said; inventory is relieved at what the units are carried at, because
 * that is what leaving stock is worth. The gap is not an error to be rounded
 * away — it is the price movement between the purchase and the return, and §7
 * gives it its own account so it shows up in the P&L rather than silently
 * distorting the average.
 *
 * §8's worked example is the test: a return of 3 units credited at ৳540.00 each
 * while carried at ৳530.00 leaves 3,000 poisha on the **credit** side of purchase
 * price variance.
 */

/** One returned line: how many, what they cost, what they are carried at. */
export interface SupplierReturnLine {
  readonly qty: number;
  /** What the supplier originally charged for one unit. */
  readonly originalUnitCostPoisha: Poisha;
  /** What one unit is carried at right now. */
  readonly currentWacPoisha: Poisha;
}

export interface SupplierReturnInput {
  /** The supply return's id. The idempotency key is derived from it. */
  readonly returnId: string;
  readonly occurredAt: Date;
  readonly payable: PostingAccount;
  readonly inventory: PostingAccount;
  readonly variance: PostingAccount;
  readonly supplierId: string;
  /**
   * The returned lines.
   *
   * A list rather than one quantity and cost, because a return of three SKUs is
   * one credit note and therefore one journal — and the idempotency key is derived
   * from the return, so a journal per line would have three rules fighting over one
   * key. The variance is summed across lines rather than posted per line: a return
   * where one SKU rose and another fell nets out, which is what the supplier's
   * credit note says too.
   */
  readonly lines: readonly SupplierReturnLine[];
  readonly branchId: string | null;
  readonly memo: string | null;
}

export function supplierReturnDraft(input: SupplierReturnInput): JournalDraft {
  assertSubtype(input.payable, 'supplier_payable', 'The supplier balance');
  assertSubtype(input.inventory, 'inventory', 'Returned stock');
  assertSubtype(input.variance, 'purchase_price_variance', 'The price difference');
  if (!isUuid(input.supplierId)) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A supplier return names its supplier.');
  }

  if (input.lines.length === 0) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A supplier return needs at least one line.');
  }

  let supplierCreditPoisha = ZERO;
  let inventoryReliefPoisha = ZERO;
  for (const line of input.lines) {
    const part = supplierReturnVariance(line);
    supplierCreditPoisha = add(supplierCreditPoisha, part.supplierCreditPoisha);
    inventoryReliefPoisha = add(inventoryReliefPoisha, part.inventoryReliefPoisha);
  }
  const variancePoisha = supplierCreditPoisha - inventoryReliefPoisha;
  if (supplierCreditPoisha <= 0n && inventoryReliefPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A supplier return of no value posts nothing.');
  }

  /*
   * A line only for an amount that is actually there.
   *
   * Both zero cases are real. Stock received free — a sample, a replacement — is
   * carried at an average of nothing, so returning it credits the supplier
   * nothing and the whole relief is a price variance; and a line the supplier
   * charged for that the average has since written down to zero is the mirror
   * image. §7's CHECK requires exactly one positive side per line, so a zero line
   * cannot be written, and a rule that wrote one anyway would refuse both of
   * those returns with `JOURNAL_LINE_INVALID` — a database error for an ordinary
   * business event. Two lines always survive, because the variance is non-zero
   * whenever either side is.
   */
  const lines: JournalLineDraft[] = [];
  if (supplierCreditPoisha > 0n) {
    lines.push({
      accountId: input.payable.accountId,
      debitPoisha: supplierCreditPoisha,
      creditPoisha: ZERO,
      branchId: lineBranch(input.payable, input.branchId),
      partyType: 'supplier',
      partyId: input.supplierId.toLowerCase(),
      memo: null,
    });
  }
  if (inventoryReliefPoisha > 0n) {
    lines.push({
      accountId: input.inventory.accountId,
      debitPoisha: ZERO,
      creditPoisha: inventoryReliefPoisha,
      branchId: lineBranch(input.inventory, input.branchId),
      partyType: null,
      partyId: null,
      memo: null,
    });
  }

  /*
   * No variance line when the two costs agree.
   *
   * Every line must have exactly one positive side (§7's CHECK), so a zero
   * variance cannot be written as a line of zero — and it should not be: a
   * journal with a nil line invites a reader to look for the missing amount.
   */
  if (variancePoisha !== 0n) {
    const magnitude = poisha(variancePoisha < 0n ? -variancePoisha : variancePoisha);
    lines.push({
      accountId: input.variance.accountId,
      // Credited when the supplier owes us more than the stock was carried at:
      // the return recovers more than it gives up, which is a gain.
      debitPoisha: variancePoisha < 0n ? magnitude : ZERO,
      creditPoisha: variancePoisha > 0n ? magnitude : ZERO,
      branchId: lineBranch(input.variance, input.branchId),
      partyType: null,
      partyId: null,
      memo: 'Purchase price variance on return',
    });
  }

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'supply_return',
    sourceId: input.returnId.toLowerCase(),
    event: 'returned',
    idempotencyKey: idempotencyKey('supply_return', input.returnId, 'returned'),
    memo: input.memo,
    reversesJournalId: null,
    lines,
  };
}
