import { businessDate, type IsoDate } from '../dates/index.js';
import {
  idempotencyKey,
  LedgerError,
  type AccountSubtype,
  type JournalDraft,
  type JournalLineDraft,
} from '../ledger/index.js';
import { sum, ZERO, type Poisha } from '../money/index.js';

/**
 * Profit distribution declared: **Dr Profit distribution / Cr Investor payable
 * (investor)** (architecture §7, posting rules table; D-019).
 *
 * Declaring is not paying. This journal moves nothing out of a wallet: it turns
 * an amount of profit into a debt the company owes each investor, and the payment
 * is a separate event with its own rule (`investor-payment.ts`). Collapsing the
 * two — posting Dr Profit distribution / Cr W when the declaration is approved —
 * would show money as gone on the day the decision was taken, and the wallet
 * would disagree with the bank until somebody actually paid.
 *
 * **One debit, one credit per investor, and that is what proves the split.** The
 * debit is the declared total; the credits are the parts. If the parts do not sum
 * to the total, the journal does not balance and nothing posts — so the poisha
 * that largest-remainder allocation saves is not a nicety, it is the difference
 * between a distribution that can be declared and one that cannot
 * (`splitDistribution` in `../investors`).
 *
 * Every investor shares one `investor_payable` account, so the **party** on each
 * credit line is the only thing that says whose money it is. §7 marks the subtype
 * as a party subtype and the database refuses a line on it without an investor.
 *
 * A **zero** part is dropped rather than posted. A journal line must have exactly
 * one positive side, and a total smaller than the number of participants
 * legitimately leaves somebody with nothing — one poisha across two investors is
 * 1 and 0. The distribution's own rows still record that they participated; the
 * journal only records money.
 */

export interface DistributionDebitAccount {
  readonly accountId: string;
  readonly subtype: AccountSubtype;
  /** Null for the org-level account, which is the normal case. */
  readonly branchId: string | null;
}

export interface DistributionShareLine {
  readonly investorId: string;
  /** The `investor_payable` account credited. Usually the same for everyone. */
  readonly payableAccountId: string;
  readonly payableSubtype: AccountSubtype;
  readonly amountPoisha: Poisha;
}

export interface ProfitDistributionInput {
  /** The distribution row's identity. The idempotency key is derived from it. */
  readonly distributionId: string;
  /**
   * The Asia/Dhaka date the distribution is declared on, or the instant to take
   * it from.
   *
   * A declaration is dated when it is *declared*, never on the last day of the
   * period it distributes. A September declaration of August profit is a
   * September equity movement — which is also why this rule can never be asked
   * to post into a closed period: the month it is dated in is the month that is
   * still running.
   */
  readonly declaredAt: Date;
  readonly distributionAccount: DistributionDebitAccount;
  readonly totalPoisha: Poisha;
  readonly lines: readonly DistributionShareLine[];
  readonly memo: string | null;
}

export function profitDistributionDraft(input: ProfitDistributionInput): JournalDraft {
  if (input.totalPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A distribution total must be positive.');
  }
  if (input.distributionAccount.subtype !== 'profit_distribution') {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A distribution is debited to the profit distribution account (§7).',
    );
  }
  if (input.lines.length === 0) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A distribution needs at least one investor.');
  }

  const seen = new Set<string>();
  for (const line of input.lines) {
    if (line.payableSubtype !== 'investor_payable') {
      throw new LedgerError(
        'POSTING_INPUT_INVALID',
        'An investor’s share is credited to the investor payable account (§7).',
      );
    }
    if (line.amountPoisha < 0n) {
      throw new LedgerError('POSTING_INPUT_INVALID', 'An investor’s share cannot be negative.');
    }
    const key = line.investorId.toLowerCase();
    if (seen.has(key)) {
      throw new LedgerError(
        'POSTING_INPUT_INVALID',
        'An investor appears twice in this distribution.',
      );
    }
    seen.add(key);
  }

  // The balance check, before the draft exists rather than after it is rejected:
  // this is the failure the split function is built to prevent, and naming it
  // here means a caller that computed the parts some other way is told what is
  // wrong instead of being handed `JOURNAL_UNBALANCED`.
  const allocated = sum(input.lines.map((line) => line.amountPoisha));
  if (allocated !== input.totalPoisha) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      `The investors’ shares come to ${allocated.toString()} poisha, not the declared ${input.totalPoisha.toString()}.`,
    );
  }

  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);
  const lines: JournalLineDraft[] = [
    {
      accountId: input.distributionAccount.accountId,
      debitPoisha: input.totalPoisha,
      creditPoisha: ZERO,
      branchId: input.distributionAccount.branchId,
      partyType: null,
      partyId: null,
      memo: null,
    },
  ];

  for (const line of input.lines) {
    if (line.amountPoisha === 0n) continue;
    lines.push({
      accountId: line.payableAccountId,
      debitPoisha: ZERO,
      creditPoisha: line.amountPoisha,
      // Org-level: profit belongs to the company, not to a branch. A branch P&L
      // that saw a distribution would read as if the branch had paid it.
      branchId: null,
      partyType: 'investor',
      partyId: line.investorId.toLowerCase(),
      memo: null,
    });
  }

  return {
    businessDate: businessDate(input.declaredAt),
    sourceType: 'investor_distribution',
    sourceId: input.distributionId.toLowerCase(),
    event: 'declared',
    idempotencyKey: idempotencyKey('investor_distribution', input.distributionId, 'declared'),
    memo,
    reversesJournalId: null,
    lines,
  };
}

/** The period a distribution is *for*, which is metadata rather than its date. */
export interface DistributionPeriod {
  readonly startsOn: IsoDate;
  readonly endsOn: IsoDate;
}
