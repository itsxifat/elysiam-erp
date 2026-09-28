/**
 * What the investor arithmetic refuses (architecture §15).
 *
 * Its own error class rather than `LedgerError`, because these are refusals
 * about an investor's position and terms — a split with no participants, a
 * withdrawal larger than the capital behind it — and none of them is a
 * malformed journal. Mapping them onto `POSTING_INPUT_INVALID` would have made
 * "you are asking for more than you hold" indistinguishable from "this draft is
 * broken", and the first is something to tell an investor while the second is a
 * bug.
 *
 * The codes are the ones in `packages/contracts/src/errors.ts`; the server's
 * `investors.errors.ts` turns each into a status.
 */
export type InvestorsErrorCode =
  'INVESTOR_SPLIT_INVALID' | 'INVESTOR_POSITION_INSUFFICIENT' | 'INVESTOR_CAPITAL_LOCKED';

export class InvestorsError extends Error {
  constructor(
    readonly code: InvestorsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'InvestorsError';
  }
}
