import { businessDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  LedgerError,
  type AccountSubtype,
  type JournalDraft,
  type JournalLineDraft,
} from '../ledger/index.js';
import { add, ZERO, type Poisha } from '../money/index.js';

/**
 * A transfer between two of the org's own wallets: **Dr W2 (+ Dr Bank charges)
 * / Cr W1** (architecture §7).
 *
 * The charge is a **third line**, and this rule exists mostly to make sure it
 * stays one. The tempting shape is two lines — debit the receiving wallet with
 * what actually arrived, credit the sending wallet with what actually left —
 * and it balances, which is why it is dangerous: ৳5,000 banked with a ৳20
 * charge becomes a ৳4,980 transfer, both wallets reconcile against their
 * statements, and the ৳20 never appears in the P&L. Repeated daily it is a
 * five-figure annual expense the books do not contain.
 *
 * So the sending wallet is credited `amount + charge` — everything that left it
 * — the receiving wallet is debited `amount`, and the charge lands on
 * `bank_charges` where §7 puts it.
 *
 * Each wallet line carries its **own** wallet's branch, not one branch for the
 * journal: banking a showroom's till moves money out of that branch and into an
 * org-level bank account, and a branch P&L that saw both sides would show the
 * branch as having spent its own cash. The charge follows the paying wallet,
 * which is the one that bore it.
 */

export interface TransferWallet {
  readonly walletId: string;
  readonly accountId: string;
  readonly subtype: AccountSubtype;
  readonly branchId: string | null;
}

export interface TransferChargeAccount {
  readonly accountId: string;
  readonly subtype: AccountSubtype;
  readonly branchId: string | null;
}

export interface WalletTransferInput {
  /** The transfer's identity. The idempotency key is derived from it. */
  readonly transferId: string;
  readonly occurredAt: Date;
  readonly from: TransferWallet;
  readonly to: TransferWallet;
  /** What the receiving wallet gains. The sending wallet loses this plus the charge. */
  readonly amountPoisha: Poisha;
  /** Zero when the provider took nothing. */
  readonly chargePoisha: Poisha;
  /** Required whenever the charge is non-zero; a `bank_charges` account. */
  readonly charge: TransferChargeAccount | null;
  readonly memo: string | null;
}

export function walletTransferDraft(input: WalletTransferInput): JournalDraft {
  if (input.amountPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A transfer amount must be positive.');
  }
  if (input.chargePoisha < 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A transfer charge cannot be negative.');
  }
  // A provider's fee is a fraction of what it moved. A "charge" larger than the transfer is
  // an expense wearing a transfer's clothes, which is how till cash was booked to bank
  // charges with no receipt and no checker (M30, the ledger audit's C-1).
  if (input.chargePoisha > input.amountPoisha) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A transfer charge cannot be larger than the amount transferred.',
    );
  }
  if (!ACCOUNT_SUBTYPES[input.from.subtype].wallet || !ACCOUNT_SUBTYPES[input.to.subtype].wallet) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'Both sides of a transfer must be wallets.');
  }
  if (input.from.walletId.toLowerCase() === input.to.walletId.toLowerCase()) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A wallet cannot be transferred to itself.');
  }
  if (input.from.accountId.toLowerCase() === input.to.accountId.toLowerCase()) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'Those two wallets share one ledger account, so a transfer between them would post nothing.',
    );
  }
  if (input.chargePoisha > 0n !== (input.charge !== null)) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A transfer charge needs a bank-charges account, and an account needs a charge.',
    );
  }
  if (input.charge !== null && input.charge.subtype !== 'bank_charges') {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A transfer charge posts to a bank-charges account (§7).',
    );
  }
  // A charge account tied to another branch would put this cost on a branch
  // that did not pay it.
  if (
    input.charge?.branchId != null &&
    input.charge.branchId !== (input.from.branchId ?? input.charge.branchId)
  ) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'That bank-charges account belongs to a different branch than the paying wallet.',
    );
  }

  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);
  const lines: JournalLineDraft[] = [
    {
      accountId: input.to.accountId,
      debitPoisha: input.amountPoisha,
      creditPoisha: ZERO,
      branchId: input.to.branchId,
      partyType: null,
      partyId: null,
      memo: null,
    },
  ];

  if (input.charge !== null) {
    lines.push({
      accountId: input.charge.accountId,
      debitPoisha: input.chargePoisha,
      creditPoisha: ZERO,
      branchId: input.charge.branchId ?? input.from.branchId,
      partyType: null,
      partyId: null,
      memo: 'Transfer charge',
    });
  }

  lines.push({
    accountId: input.from.accountId,
    debitPoisha: ZERO,
    // Everything that left the paying wallet, charge included.
    creditPoisha: add(input.amountPoisha, input.chargePoisha),
    branchId: input.from.branchId,
    partyType: null,
    partyId: null,
    memo: null,
  });

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'wallet_transfer',
    sourceId: input.transferId.toLowerCase(),
    event: 'transferred',
    idempotencyKey: idempotencyKey('wallet_transfer', input.transferId, 'transferred'),
    memo,
    reversesJournalId: null,
    lines,
  };
}
