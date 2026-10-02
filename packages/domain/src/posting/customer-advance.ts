import { businessDate } from '../dates/index.js';
import { idempotencyKey, LedgerError, type JournalDraft } from '../ledger/index.js';
import { ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * Money a buyer paid before delivery, and what becomes of what is left of it
 * (architecture §7, M17):
 *
 *     received:  Dr Wallet           / Cr Customer advance
 *     refunded:  Dr Customer advance / Cr Wallet
 *     forfeited: Dr Customer advance / Cr Other income
 *
 * The fourth ending, applied on delivery, is not here. It is a line of the delivery
 * journal (`orderDeliveredDraft`), because the advance pays part of the same sale that
 * journal recognises.
 *
 * §10's `require_advance` is why this exists. A buyer whose trust score is low enough,
 * or whom one of the brand's rules catches, is asked to send the delivery charge on
 * bKash before the parcel moves. That money is a **liability** until the goods arrive,
 * not income. Crediting revenue for it would recognise a sale that D-003 says happens on
 * delivery.
 *
 * ## One journal per advance, not per order (M17, D-234)
 *
 * The key is `order_advance:<advance id>:<event>`. M10 keyed it on the order, so a second
 * payment for the same order collided with the first and was refused (D-101), and a
 * buyer who paid ৳60 and then another ৳60 could not be recorded. Each advance is now its
 * own row in `sales.order_advances` and its own journal. A retry of the same
 * verification still lands on the same key and writes nothing.
 *
 * ## The wallet is named by whoever verified the money
 *
 * Which wallet received the money (the bKash merchant number, the branch till, the bank
 * account) is a fact only the person who checked it knows, so the caller names it. Any
 * `wallet_*` subtype is accepted. Anything else is refused, because an "advance"
 * credited against a receivable or an expense is money that has already been spent. A
 * refund goes back out of the same wallet the advance came into, and the service passes
 * the one it stored.
 *
 * A forfeit credits Other income (D-235, D-236). The buyer's money stops being owed and
 * becomes the brand's, which is income, not a reduction of any sale: the order it was
 * paid for never delivered.
 */

export type CustomerAdvanceDirection = 'received' | 'refunded' | 'forfeited';

const WALLET_SUBTYPES = ['wallet_cash', 'wallet_bank', 'wallet_bkash', 'wallet_mfs_other'] as const;

interface CustomerAdvanceCommon {
  /** The advance: `order_advance:<uuid>:received | refunded | forfeited`. */
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
    assertSubtype(input.otherIncome, 'other_income', 'A forfeited advance');
    counter = input.otherIncome;
  } else {
    if (!(WALLET_SUBTYPES as readonly string[]).includes(input.wallet.subtype)) {
      throw new LedgerError(
        'POSTING_INPUT_INVALID',
        `An advance is received into a wallet, not into a ${input.wallet.subtype} account.`,
      );
    }
    counter = input.wallet;
  }

  // The customer-advance side is credited only when money arrives.
  const credited = input.direction === 'received';
  const counterBranch = lineBranch(counter, input.branchId);
  const advanceBranch = lineBranch(input.customerAdvance, input.branchId);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'order_advance',
    sourceId: input.advanceId.toLowerCase(),
    event: input.direction,
    idempotencyKey: idempotencyKey('order_advance', input.advanceId, input.direction),
    memo: input.memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: counter.accountId,
        debitPoisha: credited ? input.amountPoisha : ZERO,
        creditPoisha: credited ? ZERO : input.amountPoisha,
        branchId: counterBranch,
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.customerAdvance.accountId,
        debitPoisha: credited ? ZERO : input.amountPoisha,
        creditPoisha: credited ? input.amountPoisha : ZERO,
        branchId: advanceBranch,
        partyType: null,
        partyId: null,
        memo: null,
      },
    ],
  };
}
