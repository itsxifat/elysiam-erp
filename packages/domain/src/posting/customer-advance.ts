import { businessDate } from '../dates/index.js';
import { idempotencyKey, LedgerError, type JournalDraft } from '../ledger/index.js';
import { ZERO, type Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * Money a buyer paid before delivery, and money given back (architecture §7):
 *
 *     received: Dr Wallet          / Cr Customer advance
 *     refunded: Dr Customer advance / Cr Wallet
 *
 * §10's `require_advance` band is why this exists at all: a buyer whose trust score is
 * low enough is asked to send the delivery charge on bKash before the parcel moves, and
 * that money is a **liability** until the goods arrive, not income. Crediting revenue
 * for it would recognise a sale that D-003 says happens on delivery, and would make the
 * P&L of a month with a lot of blocked-but-overridden orders depend on how many of them
 * eventually arrived.
 *
 * The wallet is named by the caller rather than resolved by subtype, because which
 * wallet received the money is a fact only the person who took it knows — the bKash
 * merchant number, the branch till, the bank account. Any `wallet_*` subtype is
 * accepted; anything else is refused, because an "advance" credited against a
 * receivable or an expense is money that has already been spent.
 */

export type CustomerAdvanceDirection = 'received' | 'refunded';

const WALLET_SUBTYPES = ['wallet_cash', 'wallet_bank', 'wallet_bkash', 'wallet_mfs_other'] as const;

export interface CustomerAdvanceInput {
  /** The order the advance belongs to. `order:<uuid>:advance_received | advance_refunded`. */
  readonly orderId: string;
  readonly occurredAt: Date;
  readonly direction: CustomerAdvanceDirection;
  readonly wallet: PostingAccount;
  readonly customerAdvance: PostingAccount;
  readonly amountPoisha: Poisha;
  readonly branchId: string | null;
  readonly memo: string | null;
}

export function customerAdvanceDraft(input: CustomerAdvanceInput): JournalDraft {
  assertSubtype(input.customerAdvance, 'customer_advance', 'The buyer’s advance');
  if (!(WALLET_SUBTYPES as readonly string[]).includes(input.wallet.subtype)) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      `An advance is received into a wallet, not into a ${input.wallet.subtype} account.`,
    );
  }
  if (input.amountPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'An advance must be a positive amount.');
  }

  const received = input.direction === 'received';
  const event = received ? 'advance_received' : 'advance_refunded';
  const walletBranch = lineBranch(input.wallet, input.branchId);
  const advanceBranch = lineBranch(input.customerAdvance, input.branchId);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'order',
    sourceId: input.orderId.toLowerCase(),
    event,
    idempotencyKey: idempotencyKey('order', input.orderId, event),
    memo: input.memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.wallet.accountId,
        debitPoisha: received ? input.amountPoisha : ZERO,
        creditPoisha: received ? ZERO : input.amountPoisha,
        branchId: walletBranch,
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.customerAdvance.accountId,
        debitPoisha: received ? ZERO : input.amountPoisha,
        creditPoisha: received ? input.amountPoisha : ZERO,
        branchId: advanceBranch,
        partyType: null,
        partyId: null,
        memo: null,
      },
    ],
  };
}
