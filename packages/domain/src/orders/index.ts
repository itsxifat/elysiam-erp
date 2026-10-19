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
// M17: advances that accounts verified, and why parcels come back (D-230 to D-234).
export * from './advances.js';
export * from './returns.js';
// M30: how far below the catalogue an agent may price an order (D-364).
export * from './discount-ceiling.js';
// M41: who handles an order, its verification calls and its stage at the hub (D-710 to D-719).
export * from './ownership.js';
// M48: a buyer's numbers, the people one number names, and orders for someone else (D-870 to D-889).
export * from './buyers.js';
