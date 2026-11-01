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
  'release_hold',
  'hold',
  'cancel',
];

/** The triggers to offer: the server's list, in working order, for a caller who may act. */
/**
 * What a partial delivery delivered, from the lots that were (M53, D-948): each line's quantity is
 * what the chosen lots hold of it, never more than the order has. The person can still change them.
 */
export function deliveredFromLots(
  lots: readonly {
    readonly lot: number;
    readonly items?: readonly { readonly skuId: string; readonly qty: number }[];
  }[],
  chosen: ReadonlySet<number>,
  lines: readonly { readonly skuId: string; readonly qty: number }[],
): Record<string, string> {
  const inChosen = new Map<string, number>();
  for (const lot of lots) {
    if (!chosen.has(lot.lot)) continue;
    for (const item of lot.items ?? []) {
      inChosen.set(item.skuId, (inChosen.get(item.skuId) ?? 0) + item.qty);
    }
  }
  return Object.fromEntries(
    lines.map((line) => [line.skuId, String(Math.min(inChosen.get(line.skuId) ?? 0, line.qty))]),
  );
}

export function offeredActions(
  transitions: OrderDetail['transitions'],
  mayUpdate: boolean,
): readonly OrderTrigger[] {
  if (!mayUpdate) return [];
  const allowed = new Set(transitions.map((row) => row.trigger));
  return ORDER.filter((trigger) => allowed.has(trigger));
}
