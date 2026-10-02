import type { IsoDate } from '../dates/index.js';
import {
  idempotencyKey,
  LedgerError,
  type JournalDraft,
  type JournalLineDraft,
  type PartyType,
} from '../ledger/index.js';
import { sum, ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * The opening-balance journal (M14a; §7, §8).
 *
 * One journal, posted once per brand, dated the evening before go-live. It is how a
 * business that has been trading for years starts keeping its books here: what it owns
 * on that date is debited, what it owes is credited, and the difference is its opening
 * equity.
 *
 * ## Why the equity line is a plug, and why that is said out loud
 *
 * Every other posting rule in this folder derives both sides from one event. This one
 * cannot: the assets and liabilities come from six separate imports of a brand's real
 * position, and nothing guarantees they net to a figure anybody knows in advance. The
 * difference *is* the opening equity, so it is computed here and posted to
 * `opening_equity` — its own account, not `retained_earnings` (D-213), because an
 * accountant has to see the plug to agree it and clear it.
 *
 * What is not allowed is a *silent* plug. If the caller passes lines that do not
 * balance, the equity figure absorbs it and the journal posts — which would hide an
 * import error as equity. So the rule is that the plug is the only unknown: every other
 * line is given, and the equity line is derived from them and nothing else. The
 * importers' own dry runs are what check the lines before they get here.
 */

/** One side of the opening position: an account, an amount, and whose it is. */
export interface OpeningLine {
  readonly account: PostingAccount;
  /** Always positive. Which side it lands on is the account's normal balance. */
  readonly amountPoisha: Poisha;
  /**
   * Whose balance this is, on a party subtype (§7): a supplier's payable, a courier's
   * receivable. Both or neither — a party id with no type is a balance nobody owns, and
   * `PostingAccount` does not carry the subtype's party, so the caller states it.
   */
  readonly partyType?: PartyType | null;
  readonly partyId?: string | null;
  readonly branchId?: string | null;
  readonly memo?: string | null;
}

export interface OpeningBalanceInput {
  readonly orgId: string;
  /** The evening before go-live, as a Dhaka calendar date (invariant 8). */
  readonly asOf: IsoDate;
  /** What the brand owns: stock, wallet money, advances paid, COD in transit. */
  readonly assets: readonly OpeningLine[];
  /** What it owes: supplier payables, and anything else outstanding. */
  readonly liabilities: readonly OpeningLine[];
  /** `opening_equity`, the plug. */
  readonly equity: PostingAccount;
  readonly memo?: string | null;
}

function lineOf(entry: OpeningLine, debit: boolean): JournalLineDraft {
  if (entry.amountPoisha <= 0n) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'An opening line of zero is not a balance; leave it out.',
    );
  }
  const party = entry.partyId ?? null;
  const partyType = entry.partyType ?? null;
  if ((party === null) !== (partyType === null)) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'An opening line names a party and its type together, or neither.',
    );
  }
  return {
    accountId: entry.account.accountId,
    debitPoisha: debit ? entry.amountPoisha : ZERO,
    creditPoisha: debit ? ZERO : entry.amountPoisha,
    branchId: lineBranch(entry.account, entry.branchId ?? null),
    partyType,
    partyId: party === null ? null : party.toLowerCase(),
    memo: entry.memo ?? null,
  };
}

export function openingBalanceDraft(input: OpeningBalanceInput): JournalDraft {
  assertSubtype(input.equity, 'opening_equity', 'The opening balance plug');

  if (input.assets.length === 0 && input.liabilities.length === 0) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'An opening journal with no assets and no liabilities has nothing to open.',
    );
  }

  const assetTotal = sum(input.assets.map((entry) => entry.amountPoisha));
  const liabilityTotal = sum(input.liabilities.map((entry) => entry.amountPoisha));

  const lines: JournalLineDraft[] = [
    ...input.assets.map((entry) => lineOf(entry, true)),
    ...input.liabilities.map((entry) => lineOf(entry, false)),
  ];

  /*
   * The plug, on whichever side makes the journal balance.
   *
   * Assets above liabilities is the ordinary case and credits equity: the brand owns
   * more than it owes. The other way round is a real position too — a brand carrying
   * more payables than stock and cash — and it debits equity. Refusing it would mean
   * refusing to open the books of a business that happens to be underwater, so the only
   * case left out is the exact tie, where there is nothing to plug.
   */
  const difference = assetTotal - liabilityTotal;
  if (difference !== 0n) {
    lines.push({
      accountId: input.equity.accountId,
      debitPoisha: difference < 0n ? (-difference as Poisha) : ZERO,
      creditPoisha: difference > 0n ? (difference as Poisha) : ZERO,
      branchId: null,
      partyType: null,
      partyId: null,
      memo: 'Opening balance',
    });
  }

  return {
    businessDate: input.asOf,
    sourceType: 'opening_balance',
    sourceId: input.orgId.toLowerCase(),
    event: 'posted',
    /*
     * The org and nothing else. Not a client id, so a retry cannot make a second
     * journal; and deliberately not the as-of date either, which would allow a brand
     * two opening journals by opening it twice for different days. A business starts
     * keeping its books once. There is no re-opening: a mistake found afterwards is
     * corrected through the owning module (a stock count, a wallet closing), like every
     * other posted journal (invariant 2).
     */
    idempotencyKey: idempotencyKey('opening_balance', input.orgId, 'posted'),
    memo: input.memo ?? `Opening balances as of ${input.asOf}`,
    reversesJournalId: null,
    lines,
  };
}

/** What the equity plug will be, for a dry run that wants to show it before posting. */
export function openingEquityPoisha(
  assets: readonly OpeningLine[],
  liabilities: readonly OpeningLine[],
): Poisha {
  const assetTotal = sum(assets.map((entry) => entry.amountPoisha));
  const liabilityTotal = sum(liabilities.map((entry) => entry.amountPoisha));
  return (assetTotal - liabilityTotal) as Poisha;
}
