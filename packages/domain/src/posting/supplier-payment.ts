import { businessDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  isUuid,
  LedgerError,
  type JournalDraft,
} from '../ledger/index.js';
import { ZERO } from '../money/index.js';
import type { Poisha } from '../money/index.js';
import { assertSubtype, lineBranch, type PostingAccount } from './supply-received.js';

/**
 * The three money movements between an org and a supplier (architecture §7):
 *
 *     Supplier advance paid        Dr Supplier advance / Cr W
 *     Advance applied to a supply  Dr Supplier payable  / Cr Supplier advance
 *     Supplier paid                Dr Supplier payable  / Cr W
 *
 * Three functions rather than one parameterised rule, because they are three
 * different claims about the world and only the middle one touches no cash.
 * Collapsing them behind a `kind` flag is how an advance ends up debited to the
 * payable: both are "money to a supplier", and the difference — whether the goods
 * have arrived — is exactly what the two accounts exist to record.
 *
 * `supplier_advance` is an **asset** and `supplier_payable` a **liability**, both
 * party subtypes (§7). Every line touching either names the supplier, because
 * without a party each account is one number for every mill the brand buys from,
 * and "how much is sitting with this supplier as an advance" stops being
 * answerable — which is the question M09's supplier list exists to answer.
 *
 * The wallet's branch is carried onto both lines of the two cash rules, the way
 * `cashOutDraft` does: a showroom paying a supplier out of its till has to show
 * in that showroom's day book, or the branch manager counting the till at close
 * finds money gone with nothing in their branch's books to explain it.
 */

/** A supplier advance, or a payment against what is owed. Never both at once. */
export interface SupplierPaymentInput {
  /** The payment row's id. The idempotency key is derived from it. */
  readonly paymentId: string;
  readonly occurredAt: Date;
  /** The wallet the money left. Its branch lands on both lines. */
  readonly wallet: PostingAccount;
  /** `supplier_advance` for an advance, `supplier_payable` for a payment. */
  readonly supplierAccount: PostingAccount;
  readonly supplierId: string;
  readonly amountPoisha: Poisha;
  readonly memo: string | null;
}

function assertPaymentShape(input: SupplierPaymentInput): void {
  if (input.amountPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A supplier payment must be positive.');
  }
  if (!ACCOUNT_SUBTYPES[input.wallet.subtype].wallet) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A supplier is paid from a wallet.');
  }
  if (!isUuid(input.supplierId)) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A supplier payment names its supplier.');
  }
}

function paymentDraft(input: SupplierPaymentInput, event: 'advance_paid' | 'paid'): JournalDraft {
  assertPaymentShape(input);
  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'supplier_payment',
    sourceId: input.paymentId.toLowerCase(),
    event,
    idempotencyKey: idempotencyKey('supplier_payment', input.paymentId, event),
    memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.supplierAccount.accountId,
        debitPoisha: input.amountPoisha,
        creditPoisha: ZERO,
        branchId: lineBranch(input.supplierAccount, input.wallet.branchId),
        partyType: 'supplier',
        partyId: input.supplierId.toLowerCase(),
        memo: null,
      },
      {
        accountId: input.wallet.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.amountPoisha,
        branchId: input.wallet.branchId,
        partyType: null,
        partyId: null,
        memo: null,
      },
    ],
  };
}

/**
 * Money paid to a supplier before the goods arrive: **Dr Supplier advance / Cr W**.
 *
 * An asset, not a settlement. Debiting the payable instead would leave the
 * supplier showing a negative balance that reads as "they owe us", and the
 * balance sheet would lose a prepayment it is still exposed to.
 */
export function supplierAdvancePaidDraft(input: SupplierPaymentInput): JournalDraft {
  assertSubtype(input.supplierAccount, 'supplier_advance', 'A supplier advance');
  return paymentDraft(input, 'advance_paid');
}

/** Money paid against an invoice already received: **Dr Supplier payable / Cr W**. */
export function supplierPaidDraft(input: SupplierPaymentInput): JournalDraft {
  assertSubtype(input.supplierAccount, 'supplier_payable', 'The supplier balance');
  return paymentDraft(input, 'paid');
}

export interface AdvanceAppliedInput {
  /** The application row's id. One application, one journal. */
  readonly applicationId: string;
  readonly occurredAt: Date;
  readonly payable: PostingAccount;
  readonly advance: PostingAccount;
  readonly supplierId: string;
  readonly amountPoisha: Poisha;
  /** The branch the supply landed in, or null for an org-level warehouse. */
  readonly branchId: string | null;
  readonly memo: string | null;
}

/**
 * An advance set against a received supply: **Dr Supplier payable / Cr Supplier
 * advance**.
 *
 * No cash moves here, and that is the whole reason this is its own journal rather
 * than something the supply receipt nets off. The receipt credits the payable for
 * what the invoice says, whatever was paid in advance; this entry then cancels the
 * two balances against each other. Netting inside the receipt would post a payable
 * that does not match the supplier's invoice, and the first reconciliation against
 * their statement would be unexplainable.
 *
 * The amount is the caller's, and the service is what keeps it inside the
 * advance actually held — a posting rule cannot know that, and an over-application
 * would leave `supplier_advance` credit-balanced: an asset account holding a
 * negative asset.
 */
export function advanceAppliedDraft(input: AdvanceAppliedInput): JournalDraft {
  assertSubtype(input.payable, 'supplier_payable', 'The supplier balance');
  assertSubtype(input.advance, 'supplier_advance', 'A supplier advance');
  if (input.amountPoisha <= 0n) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'An applied advance must be positive.');
  }
  if (!isUuid(input.supplierId)) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'An advance application names its supplier.');
  }

  const supplierId = input.supplierId.toLowerCase();
  const memo = input.memo?.trim() === '' ? null : (input.memo?.trim() ?? null);

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'advance_application',
    sourceId: input.applicationId.toLowerCase(),
    event: 'applied',
    idempotencyKey: idempotencyKey('advance_application', input.applicationId, 'applied'),
    memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.payable.accountId,
        debitPoisha: input.amountPoisha,
        creditPoisha: ZERO,
        branchId: lineBranch(input.payable, input.branchId),
        partyType: 'supplier',
        partyId: supplierId,
        memo: null,
      },
      {
        accountId: input.advance.accountId,
        debitPoisha: ZERO,
        creditPoisha: input.amountPoisha,
        branchId: lineBranch(input.advance, input.branchId),
        partyType: 'supplier',
        partyId: supplierId,
        memo: null,
      },
    ],
  };
}
