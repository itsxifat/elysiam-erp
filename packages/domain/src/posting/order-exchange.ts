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
 * An exchange on a delivered order (architecture §9's last transition row):
 *
 *     Dr Inventory      / Cr COGS           (the returned units, at dispatch cost)
 *     Dr Sales revenue  / Cr Customer advance (what the buyer paid for them)
 *
 * §9 says an exchange "returns the original units to stock at their dispatch cost and
 * dispatches the replacement, posting any price difference". This journal is the first
 * half. The second half is not a journal at all: the replacement is a **new order**
 * with `exchange_of_order_id` set, and it dispatches and delivers through the ordinary
 * path, so the replacement's revenue, COGS and collection are posted by the rules that
 * already exist. That is the whole reason an exchange is modelled as a linked order
 * rather than as an edit to the delivered one — an order whose lines changed after
 * delivery would make its own invoice, its own journal and its own courier receipt
 * disagree, with nothing to say which was right.
 *
 * ## Why the two pairs are what they are
 *
 * The original order was delivered, so D-003 already recognised its revenue and moved
 * its cost from goods in transit to COGS. Both of those facts are now partly wrong, and
 * each is undone against the account that received it:
 *
 * * **Dr Inventory / Cr COGS.** The units are back on a shelf, so their cost is no
 *   longer an expense. Crediting goods in transit instead — the return rule's
 *   counterparty — would be wrong here and wrong in a way that balances: goods in
 *   transit was already emptied at delivery, so it would go negative and stay there.
 * * **Dr Sales revenue / Cr Customer advance.** The sale of those units is undone, and
 *   the money the buyer paid becomes a credit the brand owes them. A liability, not a
 *   refund: the replacement order consumes it as its advance, and whatever the
 *   replacement does not use stays on the balance sheet as a store credit the customer
 *   can spend. That is what makes the price difference fall out on its own — the new
 *   order's COD is `items − discount + delivery − advance`, which *is* the difference.
 *
 * Sales revenue is debited rather than Sales discounts. A discount is a price we chose
 * to give; an exchange is a sale that did not happen, and netting it into the discount
 * account would inflate both revenue and discounts by the same amount, making gross
 * revenue and the discount rate — two numbers marketing reads weekly — wrong in
 * opposite directions.
 */

export interface OrderExchangeInput {
  /** The **original** order's id. `order:<uuid>:exchanged`. */
  readonly orderId: string;
  readonly occurredAt: Date;

  readonly inventory: PostingAccount;
  readonly cogs: PostingAccount;
  readonly salesRevenue: PostingAccount;
  readonly customerAdvance: PostingAccount;

  /** Σ returned qty × the cost recorded on the original dispatch movements. */
  readonly returnedCostPoisha: Poisha;
  /** Net item value of the returned units: what revenue was recognised on them. */
  readonly returnedNetItemsPoisha: Poisha;

  readonly branchId: string | null;
  readonly memo: string | null;
}

export function orderExchangeDraft(input: OrderExchangeInput): JournalDraft {
  assertSubtype(input.inventory, 'inventory', 'Returned stock');
  assertSubtype(input.cogs, 'cogs', 'Cost of goods sold');
  assertSubtype(input.salesRevenue, 'sales_revenue', 'The reversed sale');
  assertSubtype(input.customerAdvance, 'customer_advance', 'The buyer’s credit');

  if (input.returnedCostPoisha < 0n || input.returnedNetItemsPoisha < 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'An exchange cannot carry negative amounts.');
  }
  if (input.returnedNetItemsPoisha <= 0n) {
    /*
     * An exchange of units that were sold for nothing.
     *
     * There is no revenue to reverse and no credit to give, so there is nothing for the
     * customer to spend against the replacement — which makes the replacement a
     * free-of-charge order, not an exchange. Refusing here rather than posting a
     * one-sided journal names the right fix.
     */
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'Those units were sold for nothing, so an exchange creates no credit; raise the replacement as its own order.',
    );
  }

  const lines: JournalLineDraft[] = [
    {
      accountId: input.salesRevenue.accountId,
      debitPoisha: input.returnedNetItemsPoisha,
      creditPoisha: ZERO,
      branchId: lineBranch(input.salesRevenue, input.branchId),
      partyType: null,
      partyId: null,
      memo: null,
    },
    {
      accountId: input.customerAdvance.accountId,
      debitPoisha: ZERO,
      creditPoisha: input.returnedNetItemsPoisha,
      branchId: lineBranch(input.customerAdvance, input.branchId),
      partyType: null,
      partyId: null,
      memo: null,
    },
  ];

  // Zero when the units are carried at no cost. The revenue pair stands alone and the
  // journal still balances; the movements remain the record that the units came back.
  if (input.returnedCostPoisha > 0n) {
    lines.push(
      {
        accountId: input.inventory.accountId,
        debitPoisha: input.returnedCostPoisha,
        creditPoisha: ZERO,
        branchId: lineBranch(input.inventory, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.cogs.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.returnedCostPoisha,
        branchId: lineBranch(input.cogs, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
    );
  }

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'order',
    sourceId: input.orderId.toLowerCase(),
    event: 'exchanged',
    idempotencyKey: idempotencyKey('order', input.orderId, 'exchanged'),
    memo: input.memo,
    reversesJournalId: null,
    lines,
  };
}
