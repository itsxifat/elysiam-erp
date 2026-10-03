/**
 * Inventory and costing (architecture §8, invariant 3).
 *
 * Pure functions only: the movement enum and its sign rules, the weighted
 * average cost arithmetic, and the fold that rebuilds levels from movements.
 * Nothing here touches a database — reserving stock is one atomic conditional
 * UPDATE and lives in the inventory module's repository, because the atomicity
 * *is* the rule and a pure function cannot hold it.
 */
export * from './movements.js';
export * from './wac.js';
export * from './levels.js';
export * from './receipt-replay.js';
