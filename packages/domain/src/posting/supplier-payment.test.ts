import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LedgerError, validateJournalDraft, type JournalDraft } from '../ledger/index.js';
import { poisha, sum, type Poisha } from '../money/index.js';
import {
  advanceAppliedDraft,
  supplierAdvancePaidDraft,
  supplierPaidDraft,
  type AdvanceAppliedInput,
  type SupplierPaymentInput,
} from './supplier-payment.js';

/**
 * M09's three cash-side posting rules (architecture §7), each with the two tests a
 * rule owes (`.claude/rules/money-and-ledger.md`): a fast-check property that it
 * balances for random input, and a worked example whose numbers a person can check.
 *
 * What these tests are really guarding is **which account each side lands on**,
 * because all three rules balance no matter how that is wired: swapping the
 * advance for the payable still gives one debit and one credit of the same amount.
 * So every case asserts the subtype the amount landed on and whether a supplier is
 * named on it. That is the failure these rules exist to prevent — an advance
 * debited to the payable reads as a settlement, and the prepayment disappears from
 * the balance sheet while the supplier's balance goes negative.
 */

const WALLET = '11111111-1111-4111-8111-111111111111';
const PAYABLE = '22222222-2222-4222-8222-222222222222';
const ADVANCE = '33333333-3333-4333-8333-333333333333';
const SUPPLIER = '77777777-7777-4777-8777-777777777777';
const SOURCE = '88888888-8888-4888-8888-888888888888';
const BRANCH = '99999999-9999-4999-8999-999999999999';

function debits(draft: JournalDraft): Poisha {
  return sum(draft.lines.map((line) => poisha(line.debitPoisha)));
}

function credits(draft: JournalDraft): Poisha {
  return sum(draft.lines.map((line) => poisha(line.creditPoisha)));
}

function payment(overrides: Partial<SupplierPaymentInput> = {}): SupplierPaymentInput {
  return {
    paymentId: SOURCE,
    occurredAt: new Date('2026-04-10T04:00:00Z'),
    wallet: { accountId: WALLET, subtype: 'wallet_bkash', branchId: null },
    supplierAccount: { accountId: PAYABLE, subtype: 'supplier_payable', branchId: null },
    supplierId: SUPPLIER,
    amountPoisha: poisha(150_000),
    memo: 'Invoice 4412',
    ...overrides,
  };
}

function application(overrides: Partial<AdvanceAppliedInput> = {}): AdvanceAppliedInput {
  return {
    applicationId: SOURCE,
    occurredAt: new Date('2026-04-12T04:00:00Z'),
    payable: { accountId: PAYABLE, subtype: 'supplier_payable', branchId: null },
    advance: { accountId: ADVANCE, subtype: 'supplier_advance', branchId: null },
    supplierId: SUPPLIER,
    amountPoisha: poisha(100_000),
    branchId: null,
    memo: null,
    ...overrides,
  };
}

const amounts = fc.bigInt({ min: 1n, max: 9_000_000_000_000_000n });

describe('supplier advance paid', () => {
  it('debits the advance, credits the wallet and names the supplier', () => {
    const draft = supplierAdvancePaidDraft(
      payment({
        supplierAccount: { accountId: ADVANCE, subtype: 'supplier_advance', branchId: null },
        amountPoisha: poisha(100_000),
      }),
    );

    expect(() => validateJournalDraft(draft)).not.toThrow();
    expect(draft.idempotencyKey).toBe(`supplier_payment:${SOURCE}:advance_paid`);
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines[0]).toMatchObject({
      accountId: ADVANCE,
      debitPoisha: 100_000n,
      creditPoisha: 0n,
      partyType: 'supplier',
      partyId: SUPPLIER,
    });
    // No party on the wallet line: a till is the org's, not the supplier's, and a
    // party there would make the wallet's balance a per-supplier figure.
    expect(draft.lines[1]).toMatchObject({
      accountId: WALLET,
      creditPoisha: 100_000n,
      partyType: null,
    });
  });

  it('refuses a payable account, which would read as a settlement', () => {
    expect(() => supplierAdvancePaidDraft(payment())).toThrow(LedgerError);
  });

  it('carries the wallet branch onto both lines', () => {
    const draft = supplierAdvancePaidDraft(
      payment({
        wallet: { accountId: WALLET, subtype: 'wallet_cash', branchId: BRANCH },
        supplierAccount: { accountId: ADVANCE, subtype: 'supplier_advance', branchId: null },
      }),
    );
    expect(draft.lines.map((line) => line.branchId)).toEqual([BRANCH, BRANCH]);
  });

  it('balances for any positive amount', () => {
    fc.assert(
      fc.property(amounts, (amount) => {
        const draft = supplierAdvancePaidDraft(
          payment({
            amountPoisha: poisha(amount),
            supplierAccount: { accountId: ADVANCE, subtype: 'supplier_advance', branchId: null },
          }),
        );
        validateJournalDraft(draft);
        expect(debits(draft)).toBe(credits(draft));
        expect(debits(draft)).toBe(amount);
      }),
      { numRuns: 60 },
    );
  });
});

describe('supplier paid', () => {
  it('debits the payable and credits the wallet', () => {
    const draft = supplierPaidDraft(payment());

    expect(() => validateJournalDraft(draft)).not.toThrow();
    expect(draft.idempotencyKey).toBe(`supplier_payment:${SOURCE}:paid`);
    expect(draft.lines[0]).toMatchObject({ accountId: PAYABLE, debitPoisha: 150_000n });
    expect(draft.lines[1]).toMatchObject({ accountId: WALLET, creditPoisha: 150_000n });
  });

  it('refuses an advance account, and refuses paying from a non-wallet', () => {
    expect(() =>
      supplierPaidDraft(
        payment({
          supplierAccount: { accountId: ADVANCE, subtype: 'supplier_advance', branchId: null },
        }),
      ),
    ).toThrow(LedgerError);
    expect(() =>
      supplierPaidDraft(
        payment({ wallet: { accountId: WALLET, subtype: 'cogs', branchId: null } }),
      ),
    ).toThrow(LedgerError);
  });

  it('refuses a zero or negative amount', () => {
    expect(() => supplierPaidDraft(payment({ amountPoisha: poisha(0) }))).toThrow(LedgerError);
    expect(() => supplierPaidDraft(payment({ amountPoisha: poisha(-150_000) }))).toThrow(
      LedgerError,
    );
  });

  it('balances for any positive amount', () => {
    fc.assert(
      fc.property(amounts, (amount) => {
        const draft = supplierPaidDraft(payment({ amountPoisha: poisha(amount) }));
        validateJournalDraft(draft);
        expect(debits(draft)).toBe(credits(draft));
      }),
      { numRuns: 60 },
    );
  });
});

describe('advance applied to a supply', () => {
  it('moves the balance from the advance to the payable, supplier named on both', () => {
    const draft = advanceAppliedDraft(application());

    expect(() => validateJournalDraft(draft)).not.toThrow();
    expect(draft.idempotencyKey).toBe(`advance_application:${SOURCE}:applied`);
    expect(draft.lines[0]).toMatchObject({
      accountId: PAYABLE,
      debitPoisha: 100_000n,
      partyType: 'supplier',
      partyId: SUPPLIER,
    });
    expect(draft.lines[1]).toMatchObject({
      accountId: ADVANCE,
      creditPoisha: 100_000n,
      partyType: 'supplier',
      partyId: SUPPLIER,
    });
    // No wallet line anywhere: applying an advance moves nothing out of the bank,
    // and a cash line here would double-count the payment made days earlier.
    expect(draft.lines).toHaveLength(2);
  });

  it('refuses the two accounts the wrong way round', () => {
    expect(() =>
      advanceAppliedDraft(
        application({
          payable: { accountId: ADVANCE, subtype: 'supplier_advance', branchId: null },
        }),
      ),
    ).toThrow(LedgerError);
    expect(() =>
      advanceAppliedDraft(
        application({
          advance: { accountId: PAYABLE, subtype: 'supplier_payable', branchId: null },
        }),
      ),
    ).toThrow(LedgerError);
  });

  it('refuses a zero or negative amount, and a missing supplier', () => {
    expect(() => advanceAppliedDraft(application({ amountPoisha: poisha(0) }))).toThrow(
      LedgerError,
    );
    expect(() => advanceAppliedDraft(application({ amountPoisha: poisha(-100_000) }))).toThrow(
      LedgerError,
    );
    expect(() => advanceAppliedDraft(application({ supplierId: 'not-a-uuid' }))).toThrow(
      LedgerError,
    );
  });

  it('balances for any positive amount', () => {
    fc.assert(
      fc.property(amounts, (amount) => {
        const draft = advanceAppliedDraft(application({ amountPoisha: poisha(amount) }));
        validateJournalDraft(draft);
        expect(debits(draft)).toBe(credits(draft));
      }),
      { numRuns: 60 },
    );
  });
});

/**
 * The §7 scenario M09 check 5 measures: advance → supply → apply → payment.
 *
 * Checked here as arithmetic over the drafts, so the expected closing balances are
 * written down independently of the database. The integration test then asserts the
 * ledger agrees; if the two ever disagree, this is the one that says what the right
 * answer was.
 */
describe('advance, supply, apply, payment', () => {
  it('leaves nothing owed and no advance held', () => {
    const advancePaid = supplierAdvancePaidDraft(
      payment({
        paymentId: '11111111-2222-4333-8444-555555555551',
        amountPoisha: poisha(100_000),
        supplierAccount: { accountId: ADVANCE, subtype: 'supplier_advance', branchId: null },
      }),
    );
    const applied = advanceAppliedDraft(application({ amountPoisha: poisha(100_000) }));
    const settled = supplierPaidDraft(
      payment({
        paymentId: '11111111-2222-4333-8444-555555555552',
        amountPoisha: poisha(50_000),
      }),
    );

    // The receipt's own journal is M07's rule; its effect on the payable is a
    // credit of the invoice total, stated here as the scenario's premise.
    const invoiceTotal = 150_000n;
    const balanceOn = (accountId: string): bigint =>
      [advancePaid, applied, settled]
        .flatMap((draft) => draft.lines)
        .filter((line) => line.accountId === accountId)
        .reduce((total, line) => total + line.debitPoisha - line.creditPoisha, 0n);

    // Payable is a liability: credits are what is owed, so its debit-side total
    // must equal the invoice for the supplier to be square.
    expect(balanceOn(PAYABLE)).toBe(invoiceTotal);
    // Advance is an asset: paid 100,000 and applied 100,000 leaves nothing held.
    expect(balanceOn(ADVANCE)).toBe(0n);
    // Cash out of the wallet is the advance plus the settlement, and nothing more.
    expect(balanceOn(WALLET)).toBe(-150_000n);
  });
});
