/**
 * Fraud as pure logic (architecture §10, invariants 10 and 11).
 *
 * Two things live here: the trust score and the band rules that turn it into one
 * of §9's four decisions. Both are functions of their arguments, so the same
 * signals produce the same number in the order desk, in the confirm guard, in the
 * worker that refreshes a stale provider row, and in a test.
 *
 * What is deliberately **not** here:
 *
 * * **The phone HMAC.** It needs a secret and `node:crypto`, and this package has
 *   no runtime dependencies and ships to the browser inside the console bundle. A
 *   hashing function keyed from server configuration does not belong in code a
 *   browser downloads, so it lives in the server module beside the table it keys
 *   (`apps/server/src/modules/fraud/phone-hash.ts`).
 * * **Anything that talks to a provider.** A timeout, a TTL and a throttle are all
 *   about a clock and a network; the score does not know a provider exists beyond
 *   the counts it was handed.
 *
 * Neither the score nor the reasons ever carry a phone number, a customer name, an
 * order id or an amount (invariant 10, and §5's rule for the cross-org table). A
 * reason is a code plus integers, which is what lets the same row be shown to an
 * org that contributed none of the evidence behind it.
 */
export * from './bands.js';
export * from './score.js';
