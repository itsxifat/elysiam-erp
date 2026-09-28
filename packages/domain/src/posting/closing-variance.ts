import { isIsoDate, toIsoDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  LedgerError,
  type AccountSubtype,
  type JournalDraft,
} from '../ledger/index.js';
import { abs, ZERO, type Poisha } from '../money/index.js';

/**
 * A daily closing variance: **Dr or Cr Cash over/short against W**
 * (architecture §7, approval required).
 *
 * The count disagreed with the ledger. Which way it went decides the sides:
 *
 * - **short** (counted < expected): the wallet holds less than the books say,
 *   so the wallet is credited down and the loss is an expense.
 *   `Dr cash_over_short / Cr W`.
 * - **over** (counted > expected): there is more in the till than the books
 *   say, so the wallet is debited up and the gain reduces the same expense
 *   account. `Dr W / Cr cash_over_short`.
 *
 * Both directions use one account, `cash_over_short`, and it is debit-normal.
 * That is deliberate: over and short cancel over a month, and a single account
 * makes the net visible. Two accounts would report ৳900 of losses and ৳880 of
 * gains as two unrelated lines when what the manager needs to know is that the
 * till is ৳20 out.
 *
 * This rule does not decide whether a variance may post. That is maker-checker
 * (§6): the closing raises a `closing_variance` approval and this draft is built
 * by the executor, inside the approving transaction. The rule refuses a zero
 * variance, because a balanced close has nothing to post and a journal of two
 * zero lines would not balance anyway.
 */

export interface ClosingVarianceWallet {
  readonly accountId: string;
  readonly subtype: AccountSubtype;
  readonly branchId: string | null;
}

export interface ClosingVarianceInput {
  /** The closing's identity. The idempotency key is derived from it. */
  readonly closingId: string;
  /** The business date being closed. Not "today": a close can be posted later. */
  readonly businessDate: string;
  readonly wallet: ClosingVarianceWallet;
  readonly cashOverShort: { readonly accountId: string; readonly subtype: AccountSubtype };
  /** `counted − expected`. Positive is over, negative is short, zero is refused. */
  readonly variancePoisha: Poisha;
  readonly memo: string | null;
}

export function closingVarianceDraft(input: ClosingVarianceInput): JournalDraft {
  if (input.variancePoisha === 0n) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A closing that balanced has no variance to post.',
    );
  }
  if (!isIsoDate(input.businessDate)) {
    throw new LedgerError('JOURNAL_DATE_INVALID', `"${input.businessDate}" is not a date.`);
  }
  if (!ACCOUNT_SUBTYPES[input.wallet.subtype].wallet) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A closing counts a wallet.');
  }
  if (input.cashOverShort.subtype !== 'cash_over_short') {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A closing variance posts to the cash over/short account (§7).',
    );
  }

  const magnitude = abs(input.variancePoisha);
  const over = input.variancePoisha > 0n;
  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);

  return {
    // The date being closed, so a variance approved on Tuesday still belongs to
    // Monday's day book and Monday's P&L.
    businessDate: toIsoDate(input.businessDate),
    sourceType: 'wallet_closing',
    sourceId: input.closingId.toLowerCase(),
    event: 'variance_posted',
    idempotencyKey: idempotencyKey('wallet_closing', input.closingId, 'variance_posted'),
    memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: over ? input.wallet.accountId : input.cashOverShort.accountId,
        debitPoisha: magnitude,
        creditPoisha: ZERO,
        branchId: input.wallet.branchId,
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: over ? input.cashOverShort.accountId : input.wallet.accountId,
        debitPoisha: ZERO,
        creditPoisha: magnitude,
        branchId: input.wallet.branchId,
        partyType: null,
        partyId: null,
        memo: null,
      },
    ],
  };
}
