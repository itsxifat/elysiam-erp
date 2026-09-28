/**
 * Orders as pure logic (architecture §9, invariants 7 and 11).
 *
 * Four things live here and nothing else: the state machine, the totals, phone
 * normalisation and order numbering. Each is a function of its inputs, each is tested
 * against random inputs, and none of them can reach a database — which is what makes
 * invariant 7's claim ("order status changes only through the domain state machine")
 * checkable rather than aspirational.
 *
 * The journals an order causes are in `../posting`, one file per §7 row, because that
 * is where every posting rule in this system lives and splitting orders' rules out
 * would hide them from the money-and-ledger review that reads that folder.
 */
export * from './state.js';
export * from './totals.js';
export * from './phone.js';
export * from './numbering.js';
