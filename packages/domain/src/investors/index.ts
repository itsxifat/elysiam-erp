/**
 * Investor arithmetic (architecture §15, M25).
 *
 * Pure functions only: how a declared profit divides across investors without
 * losing a poisha, and what an investor's position allows them to withdraw.
 * The posting rules that turn those numbers into journals live in
 * `../posting/`; the tables and the approval flow live in the server module.
 */
export * from './errors.js';
export * from './split.js';
export * from './position.js';
