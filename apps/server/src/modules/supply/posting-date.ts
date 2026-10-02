import { withinPostingWindow } from '@elysium/domain';

import { SupplyError } from './supply.errors.js';

/**
 * The instant a supply, a supplier payment or a supplier return is posted on, refused if
 * §7 would need an approval for it (M30's C6, D-414).
 *
 * §7 allows today and yesterday without a `back_dated_entry` approval, and every other
 * module that takes a date already holds to it (orders, staff loans, payroll). Supply did
 * not: a receipt dated last month landed stock and the supplier's due in figures already
 * reported, and one dated next year sat where no month-end close could reach it. No
 * `back_dated_entry` executor exists yet, so outside the window the answer is a refusal,
 * not a quiet post. A late paper bill is entered on the day it is entered, with its
 * invoice number on the entry (ASSUMED, D-414).
 *
 * `now` is the caller's clock, so a service-level test can fix it.
 */
export function postingInstant(named: string | undefined, now: Date): Date {
  const at = named === undefined ? now : new Date(named);
  if (Number.isNaN(at.getTime())) {
    throw new SupplyError('VALIDATION_FAILED', 'That is not a usable timestamp.');
  }
  if (!withinPostingWindow(at, now)) {
    throw new SupplyError(
      'APPROVAL_REQUIRED',
      'Supplies, supplier payments and returns are dated today or yesterday. Enter a late bill today with its invoice number; an earlier date needs a back-dated entry approval (§7).',
    );
  }
  return at;
}
