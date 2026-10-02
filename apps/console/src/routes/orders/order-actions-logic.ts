import type { OrderDetail, OrderTrigger } from './api.js';

/**
 * Which lifecycle buttons the order detail offers (D-392), as a pure function for the tests.
 *
 * The server's `transitions` (§9's rows from the order's status) in the order a person works
 * an order, for a caller holding `update Order`. Exchange is left out: it is raised from its
 * own form.
 */

/** The buttons, in the order a person works an order. */
const ORDER: readonly OrderTrigger[] = [
  'confirm',
  'pack',
  'ship',
  'deliver',
  'deliver_partially',
  'start_return',
  'receive_return',
  'release',
  'hold',
  'cancel',
];

/** The triggers to offer: the server's list, in working order, for a caller who may act. */
export function offeredActions(
  transitions: OrderDetail['transitions'],
  mayUpdate: boolean,
): readonly OrderTrigger[] {
  if (!mayUpdate) return [];
  const allowed = new Set(transitions.map((row) => row.trigger));
  return ORDER.filter((trigger) => allowed.has(trigger));
}
