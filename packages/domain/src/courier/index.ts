/**
 * Courier logic, pure (architecture §9, §20, §21; invariant 11).
 *
 * Three files for M12, three jobs (M15's five are listed at the exports):
 *
 * - `status` turns a courier's vocabulary into §9's twelve normalized statuses, and
 *   decides which of §9's order triggers (if any) a status justifies.
 * - `settlement` matches a courier's statement against our own receivable, totals
 *   it, and resolves D-037's posting date when the settlement's month is closed.
 * - `booking` checks a parcel before an outbound call is ever enqueued, and converts
 *   between poisha and the taka every courier API speaks.
 *
 * Nothing here performs I/O, so the same rule answers identically in the API, in the
 * booking worker, in the settlement preview a person looks at before approving, and
 * in a test.
 */
export * from './status.js';
export * from './settlement.js';
export * from './booking.js';
// M15: which courier takes a parcel, the stuck-parcel queue, the performance report, the
// public tracking page, and what makes a fetched statement a duplicate.
export * from './selection.js';
export * from './stuck.js';
export * from './performance.js';
export * from './tracking.js';
export * from './settlement-fetch.js';

/**
 * §7's two settlement posting rules, re-exported.
 *
 * They live in `packages/domain/src/posting/` with every other posting rule — one
 * file per business event, which is where a reviewer looks for them — and are
 * surfaced here so a caller needs one import for everything courier.
 *
 * The root barrel (`@elysium/domain`) must **not** also re-export this folder:
 * `posting/index.ts` exports the same two names, and `export *` from two modules with
 * one name is an ambiguity TypeScript refuses. `@elysium/domain/courier` is a
 * separate entry point, so the two coexist.
 */
export * from '../posting/courier-settlement.js';
