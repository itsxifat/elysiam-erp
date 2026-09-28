import { businessDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  LedgerError,
  type AccountSubtype,
  type JournalDraft,
} from '../ledger/index.js';
import { ZERO, type Poisha } from '../money/index.js';

/**
 * Investor capital received: **Dr W / Cr Investor capital (investor)**
 * (architecture §7, posting rules table).
 *
 * Money an investor puts into the brand. It is equity, not income — the one
 * mistake this rule exists to make impossible. Crediting `other_income` instead
 * would balance perfectly, pass every constraint, and show a ৳50,00,000
 * injection as a profitable month: the P&L would be wrong, the tax position
 * would be wrong, and the investor's capital account would be empty when they
 * asked for their money back.
 *
 * **The party is mandatory and it is what makes the account usable.** Every
 * investor shares one `investor_capital` account (§7 marks the subtype as a party
 * subtype), so the party on the line is the only thing that says whose capital
 * this is. The database enforces it independently: a line on a party-subtype
 * account without a party of that type is refused.
 *
 * The two lines carry **different branches**, deliberately. Cash into a showroom
 * till belongs to that showroom's day book and cash position; the equity it
 * created belongs to the org, not to the branch — a branch P&L and balance sheet
 * that saw investor equity would read as if the showroom had been capitalised
 * separately.
 */

export interface CapitalWalletAccount {
  readonly accountId: string;
  readonly subtype: AccountSubtype;
  readonly branchId: string | null;
}

export interface CapitalEquityAccount {
  readonly accountId: string;
  readonly subtype: AccountSubtype;
  /** Null for the org-level equity account, which is the normal case. */
  readonly branchId: string | null;
}

export interface InvestorCapitalInput {
  /** The investment row's identity. The idempotency key is derived from it. */
  readonly investmentId: string;
  /** The investor the capital belongs to: the party on the equity line. */
  readonly investorId: string;
  /** When the money arrived. The business date is its Asia/Dhaka date. */
  readonly occurredAt: Date;
  readonly wallet: CapitalWalletAccount;
  readonly capital: CapitalEquityAccount;
  readonly amountPoisha: Poisha;
  readonly memo: string | null;
}

export function investorCapitalDraft(input: InvestorCapitalInput): JournalDraft {
  if (input.amountPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A capital contribution must be positive.');
  }
  if (!ACCOUNT_SUBTYPES[input.wallet.subtype].wallet) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'Capital must be received into a wallet.');
  }
  if (input.capital.subtype !== 'investor_capital') {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'Capital is credited to the investor capital account (§7), never to income.',
    );
  }
  // An equity account tied to one branch cannot take another branch's cash: the
  // two lines would claim the money arrived in one branch and created equity in
  // another.
  if (input.capital.branchId !== null && input.capital.branchId !== input.wallet.branchId) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'That capital account belongs to a different branch than the wallet.',
    );
  }

  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'investment',
    sourceId: input.investmentId.toLowerCase(),
    event: 'received',
    idempotencyKey: idempotencyKey('investment', input.investmentId, 'received'),
    memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.wallet.accountId,
        debitPoisha: input.amountPoisha,
        creditPoisha: ZERO,
        branchId: input.wallet.branchId,
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.capital.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.amountPoisha,
        branchId: input.capital.branchId,
        partyType: 'investor',
        partyId: input.investorId.toLowerCase(),
        memo: null,
      },
    ],
  };
}
