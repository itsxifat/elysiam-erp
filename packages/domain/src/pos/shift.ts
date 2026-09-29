import { add, sub, type Poisha } from '../money/index.js';

/**
 * A till's drawer over one shift (architecture §14: "open a register or shift
 * with opening cash; close with a cash count").
 *
 * This is the cashier's accountability, not the books. The float is cash that
 * was already in the branch's hand-cash wallet, so opening a shift posts nothing;
 * what the ledger says about that wallet is settled once a day by M08's closing,
 * which has its own derived expectation and its own `closing_variance` approval.
 * The shift count answers a narrower question — did *this* drawer, over *this*
 * shift, hold what went through it — and it answers it from the documents rather
 * than the ledger on purpose: a sale held for review took real cash even though
 * its journal has not posted, so the drawer must be expected to hold it.
 */
export interface DrawerMovements {
  readonly openingFloatPoisha: Poisha;
  /** Cash kept on sales that were not voided (tendered minus change). */
  readonly cashSalesPoisha: Poisha;
  /** Cash paid out on returns that were not voided. */
  readonly cashRefundsPoisha: Poisha;
}

export function expectedDrawerCash(movements: DrawerMovements): Poisha {
  return sub(add(movements.openingFloatPoisha, movements.cashSalesPoisha), movements.cashRefundsPoisha);
}

/** `counted − expected`: positive is over, negative is short (as M08's closings). */
export function drawerVariance(countedPoisha: Poisha, expectedPoisha: Poisha): Poisha {
  return sub(countedPoisha, expectedPoisha);
}
