import { businessDate } from '../dates/index.js';
import {
  ACCOUNT_SUBTYPES,
  idempotencyKey,
  isUuid,
  LedgerError,
  type AccountSubtype,
  type JournalDraft,
} from '../ledger/index.js';
import { mulQty, sum, ZERO, type Poisha } from '../money/index.js';

/**
 * Supply received: **Dr Inventory / Cr Supplier payable** (architecture §7).
 *
 * The one place purchase cost enters the system (invariant 5, §1). The amount is
 * Σ qty × unit cost over the received lines, computed here rather than taken from
 * the caller: a header total sent alongside lines is a number that can disagree
 * with them, and the disagreement would land in inventory while the supplier was
 * credited the other figure — a permanent imbalance between the stock ledger and
 * the payable, discovered at a reconciliation months later.
 *
 * The supplier is named on the payable line because `supplier_payable` is a party
 * subtype (§7): without a party the balance is one number for every supplier, and
 * "what do we owe this mill" stops being answerable.
 *
 * M07 owns this rule because it owns the movements the receipt creates and the
 * weighted average it blends. M09's supply entries call it through
 * `INVENTORY_API.receiveSupply`, so the journal and the movements are written by
 * one transaction rather than two modules hoping to agree.
 */

export interface PostingAccount {
  readonly accountId: string;
  readonly subtype: AccountSubtype;
  readonly branchId: string | null;
}

/** One received line, as the ledger sees it: a quantity and what it cost. */
export interface SupplyReceiptLine {
  readonly qty: number;
  readonly unitCostPoisha: Poisha;
}

export interface SupplyReceivedInput {
  /** The supply entry's id. The idempotency key is derived from it. */
  readonly supplyId: string;
  readonly occurredAt: Date;
  readonly inventory: PostingAccount;
  readonly payable: PostingAccount;
  readonly supplierId: string;
  readonly lines: readonly SupplyReceiptLine[];
  /** The branch the stock landed in, or null for an org-level warehouse. */
  readonly branchId: string | null;
  readonly memo: string | null;
}

export function assertSubtype(
  account: PostingAccount,
  expected: AccountSubtype,
  what: string,
): void {
  if (account.subtype !== expected) {
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      `${what} must be a ${expected} account, not ${account.subtype}.`,
    );
  }
  if (!Object.hasOwn(ACCOUNT_SUBTYPES, account.subtype)) {
    throw new LedgerError('POSTING_INPUT_INVALID', `Unknown account subtype ${account.subtype}.`);
  }
}

/**
 * The branch a line carries.
 *
 * An account tied to a branch fixes it — migration 0014's line trigger refuses
 * anything else — so the caller's branch is used only where the account is
 * org-level. Getting this backwards produces a `JOURNAL_LINE_INVALID` from the
 * database on a perfectly reasonable receipt into a showroom.
 */
export function lineBranch(account: PostingAccount, branchId: string | null): string | null {
  return account.branchId ?? branchId;
}

export function supplyReceivedDraft(input: SupplyReceivedInput): JournalDraft {
  assertSubtype(input.inventory, 'inventory', 'Received stock');
  assertSubtype(input.payable, 'supplier_payable', 'The supplier balance');
  if (!isUuid(input.supplierId)) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A supply receipt names its supplier.');
  }
  if (input.lines.length === 0) {
    throw new LedgerError('POSTING_INPUT_INVALID', 'A supply receipt needs at least one line.');
  }

  const total = sum(
    input.lines.map((line) => {
      if (!Number.isSafeInteger(line.qty) || line.qty <= 0) {
        throw new LedgerError('POSTING_INPUT_INVALID', 'A received quantity must be positive.');
      }
      if (line.unitCostPoisha < 0n) {
        throw new LedgerError('POSTING_INPUT_INVALID', 'A unit cost cannot be negative.');
      }
      return mulQty(line.unitCostPoisha, line.qty);
    }),
  );
  if (total <= 0n) {
    // Free stock is a real thing — samples, replacements — but it is an
    // `opening_balance` or an `adjustment_gain`, not a payable of nothing. A
    // journal of zero would fail the database's balance trigger anyway; saying
    // so here names the right fix.
    throw new LedgerError(
      'POSTING_INPUT_INVALID',
      'A supply receipt with no value posts nothing; record it as a stock gain instead.',
    );
  }

  return {
    businessDate: businessDate(input.occurredAt),
    sourceType: 'supply',
    sourceId: input.supplyId.toLowerCase(),
    event: 'received',
    idempotencyKey: idempotencyKey('supply', input.supplyId, 'received'),
    memo: input.memo,
    reversesJournalId: null,
    lines: [
      {
        accountId: input.inventory.accountId,
        debitPoisha: total,
        creditPoisha: ZERO,
        branchId: lineBranch(input.inventory, input.branchId),
        partyType: null,
        partyId: null,
        memo: null,
      },
      {
        accountId: input.payable.accountId,
        debitPoisha: ZERO,
        creditPoisha: total,
        branchId: lineBranch(input.payable, input.branchId),
        partyType: 'supplier',
        partyId: input.supplierId.toLowerCase(),
        memo: null,
      },
    ],
  };
}
