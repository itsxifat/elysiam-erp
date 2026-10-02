import { businessDate } from '../dates/index.js';
import { idempotencyKey, LedgerError, type JournalDraft } from '../ledger/index.js';
import { ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * Money a buyer paid before delivery, and what becomes of what is left of it
 * (architecture §7, M17, D-230 to D-233):
 *
 *     received:  Dr Wallet           / Cr Customer advance   (accounts verified it)
 *     refunded:  Dr Customer advance / Cr Wallet             (the money went back)
 *     forfeited: Dr Customer advance / Cr Other income       (kept, per the brand's policy)
 *
 * The fourth ending, applied on delivery, is not here. It is a line of the delivery journal
 * (`orderDeliveredDraft`), because the advance pays part of the same sale that journal
 * recognises.
 *
 * The money is a **liability** until the goods arrive, not income. Crediting revenue for it
 * would recognise a sale that D-003 says happens on delivery.
 *
 * ## One journal per advance, not per order (D-230)
 *
 * The key is `customer_advance:<advance id>:<event>`. M10 keyed it on the order, so a second
 * payment for the same order collided with the first and was refused (D-101). Each advance is
 * now its own row in `sales.order_advances` and its own journal; a retry of the same
 * verification lands on the same key and writes nothing.
 *
 * ## The wallet is named by whoever handled the money
 *
 * Which wallet received it (the bKash merchant number, the branch till, the bank account) is
 * a fact only the person who checked it knows, so the caller names it. Any `wallet_*` subtype
 * is accepted; anything else is refused, because an "advance" credited against a receivable or
 * an expense is money that has already been spent.
 *
 * A forfeit credits Other income: the buyer's money stops being owed and becomes the brand's,
 * which is income, not a reduction of any sale. The order it was paid for never delivered.
 */

export type CustomerAdvanceDirection = 'received' | 'refunded' | 'forfeited';

const WALLET_SUBTYPES = ['wallet_cash', 'wallet_bank', 'wallet_bkash', 'wallet_mfs_other'] as const;

interface CustomerAdvanceCommon {
  /** The advance row: `customer_advance:<uuid>:received | refunded | forfeited`. */
  readonly advanceId: string;
  readonly occurredAt: Date;
  readonly customerAdvance: PostingAccount;
  readonly amountPoisha: Poisha;
  readonly branchId: string | null;
  readonly memo: string | null;
}

export type CustomerAdvanceInput =
  | (CustomerAdvanceCommon & {
      readonly direction: 'received' | 'refunded';
      readonly wallet: PostingAccount;
    })
  | (CustomerAdvanceCommon & {
      readonly direction: 'forfeited';
      readonly otherIncome: PostingAccount;
    });

export function customerAdvanceDraft(input: CustomerAdvanceInput): JournalDraft {
  assertSubtype(input.customerAdvance, 'customer_advance', 'The buyer’s advance');
  if (input.amountPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'An advance must be a positive amount.');
  }

  let counter: PostingAccount;
  if (input.direction === 'forfeited') {
    assertSubtype(input.otherIncome, 'other_income', 'A kept advance');
    counter = input.otherIncome;
  } else {
    if (!(WALLET_SUBTYPES as readonly string[]).includes(input.wallet.subtype)) {
      throw new LedgerError(
        'POSTING_INPUT_INVALID',
        `An advance moves through a wallet, not through a ${input.wallet.subtype} account.`,
      );
    }
    counter = input.wallet;
  }

  // Customer advance is credited only when money arrives; both endings debit it.
  const arriving = input.direction === 'received';

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'customer_advance',
    sourceId: input.advanceId.toLowerCase(),
    event: input.direction,
    idempotencyKey: idempotencyKey('customer_advance', input.advanceId, input.direction),
    memo: input.memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: counter.accountId,
        debitPoisha: arriving ? input.amountPoisha : ZERO,
        creditPoisha: arriving ? ZERO : input.amountPoisha,
        branchId: lineBranch(counter, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.customerAdvance.accountId,
        debitPoisha: arriving ? ZERO : input.amountPoisha,
        creditPoisha: arriving ? input.amountPoisha : ZERO,
        branchId: lineBranch(input.customerAdvance, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
    ],
  };
}
