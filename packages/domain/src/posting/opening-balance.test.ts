import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../dates/index.js';
import { validateJournalDraft } from '../ledger/index.js';
import { poisha, sum, type Poisha } from '../money/index.js';
import { openingBalanceDraft, openingEquityPoisha, type OpeningLine } from './opening-balance.js';
import type { PostingAccount } from './supply-received.js';

/**
 * The opening-balance rule (M14a; `.claude/rules/money-and-ledger.md` asks every posting
 * rule for a balance property and a worked example).
 *
 * The property that matters here is not the usual one. Other rules derive both sides from
 * one event, so "debits equal credits" is a statement about arithmetic. This rule *makes*
 * them equal by computing the plug, so proving it balances would prove only that
 * subtraction works. What has to be proved instead is that the plug is the **only** thing
 * that absorbs a difference: every given line reaches the journal at its own amount, on
 * the side its account's nature puts it, and the equity line is exactly the remainder.
 * An import error must show up as equity nobody recognises, not as a quietly adjusted
 * stock figure.
 */

const ASOF = toIsoDate('2026-06-30');
const ORG = '7f3c2b10-0000-4000-8000-00000000000a';

function account(subtype: PostingAccount['subtype'], id: string): PostingAccount {
  return { accountId: id, subtype, branchId: null };
}

const INVENTORY = account('inventory', '11111111-0000-4000-8000-000000000001');
const WALLET = account('wallet_cash', '11111111-0000-4000-8000-000000000002');
const PAYABLE = account('supplier_payable', '22222222-0000-4000-8000-000000000001');
const EQUITY = account('opening_equity', '33333333-0000-4000-8000-000000000001');

const SUPPLIER = '44444444-0000-4000-8000-000000000001';

function asset(acc: PostingAccount, amount: number): OpeningLine {
  return { account: acc, amountPoisha: poisha(amount) };
}

describe('the opening-balance journal', () => {
  it('posts a worked example: stock and cash against a supplier due, with the rest as equity', () => {
    // ৳4,00,000 of stock, ৳50,000 in the till, ৳1,20,000 owed to a supplier.
    // Equity is the remainder: 4,00,000 + 50,000 − 1,20,000 = ৳3,30,000.
    const draft = openingBalanceDraft({
      orgId: ORG,
      asOf: ASOF,
      assets: [asset(INVENTORY, 40_000_000), asset(WALLET, 5_000_000)],
      liabilities: [
        {
          account: PAYABLE,
          amountPoisha: poisha(12_000_000),
          partyType: 'supplier',
          partyId: SUPPLIER,
        },
      ],
      equity: EQUITY,
    });

    expect(draft.businessDate).toBe(ASOF);
    expect(draft.sourceType).toBe('opening_balance');
    expect(draft.idempotencyKey).toBe(`opening_balance:${ORG}:posted`);

    const equityLine = draft.lines.find((line) => line.accountId === EQUITY.accountId);
    expect(equityLine?.creditPoisha).toBe(33_000_000n);
    expect(equityLine?.debitPoisha).toBe(0n);

    // Every given line reached the journal at its own amount, untouched.
    expect(draft.lines.find((l) => l.accountId === INVENTORY.accountId)?.debitPoisha).toBe(
      40_000_000n,
    );
    expect(draft.lines.find((l) => l.accountId === WALLET.accountId)?.debitPoisha).toBe(5_000_000n);
    const payableLine = draft.lines.find((l) => l.accountId === PAYABLE.accountId);
    expect(payableLine?.creditPoisha).toBe(12_000_000n);
    expect(payableLine?.partyType).toBe('supplier');
    expect(payableLine?.partyId).toBe(SUPPLIER);

    // And the ledger's own validator accepts it.
    expect(() => validateJournalDraft(draft)).not.toThrow();
  });

  it('debits equity for a brand that owes more than it holds', () => {
    // A real position, not an error: more payables than stock and cash. Refusing it
    // would mean refusing to open the books of a business that is underwater.
    const draft = openingBalanceDraft({
      orgId: ORG,
      asOf: ASOF,
      assets: [asset(INVENTORY, 1_000_000)],
      liabilities: [
        {
          account: PAYABLE,
          amountPoisha: poisha(2_500_000),
          partyType: 'supplier',
          partyId: SUPPLIER,
        },
      ],
      equity: EQUITY,
    });

    const equityLine = draft.lines.find((line) => line.accountId === EQUITY.accountId);
    expect(equityLine?.debitPoisha).toBe(1_500_000n);
    expect(equityLine?.creditPoisha).toBe(0n);
    expect(() => validateJournalDraft(draft)).not.toThrow();
  });

  it('posts no equity line when the position happens to tie', () => {
    const draft = openingBalanceDraft({
      orgId: ORG,
      asOf: ASOF,
      assets: [asset(INVENTORY, 7_777_777)],
      liabilities: [
        {
          account: PAYABLE,
          amountPoisha: poisha(7_777_777),
          partyType: 'supplier',
          partyId: SUPPLIER,
        },
      ],
      equity: EQUITY,
    });

    expect(draft.lines.some((line) => line.accountId === EQUITY.accountId)).toBe(false);
    expect(draft.lines).toHaveLength(2);
    expect(() => validateJournalDraft(draft)).not.toThrow();
  });

  it('is one journal per brand, not one per as-of date', () => {
    // A brand starts keeping its books once. If the key carried the date, somebody
    // re-running the import against a different evening would post a *second* opening
    // journal and double the brand's opening stock and equity — balanced, and wrong.
    const common = { orgId: ORG, assets: [asset(INVENTORY, 500)], liabilities: [], equity: EQUITY };
    const june = openingBalanceDraft({ ...common, asOf: ASOF });
    const july = openingBalanceDraft({ ...common, asOf: toIsoDate('2026-07-31') });

    expect(july.idempotencyKey).toBe(june.idempotencyKey);
    // The dates still differ, so whichever posts first is the one the books carry.
    expect(july.businessDate).not.toBe(june.businessDate);
  });

  it('refuses a plug that is not the opening-equity account', () => {
    expect(() =>
      openingBalanceDraft({
        orgId: ORG,
        asOf: ASOF,
        assets: [asset(INVENTORY, 100)],
        liabilities: [],
        // `retained_earnings` is what the business earned; this is not that (D-213).
        equity: account('retained_earnings', '33333333-0000-4000-8000-000000000009'),
      }),
    ).toThrow(/opening_equity/);
  });

  it('refuses a line of zero, and a party named without its type', () => {
    expect(() =>
      openingBalanceDraft({
        orgId: ORG,
        asOf: ASOF,
        assets: [asset(INVENTORY, 0)],
        liabilities: [],
        equity: EQUITY,
      }),
    ).toThrow(/not a balance/);

    expect(() =>
      openingBalanceDraft({
        orgId: ORG,
        asOf: ASOF,
        assets: [],
        liabilities: [{ account: PAYABLE, amountPoisha: poisha(100), partyId: SUPPLIER }],
        equity: EQUITY,
      }),
    ).toThrow(/party and its type together/);
  });

  it('refuses an opening journal with nothing to open', () => {
    expect(() =>
      openingBalanceDraft({ orgId: ORG, asOf: ASOF, assets: [], liabilities: [], equity: EQUITY }),
    ).toThrow(/nothing to open/);
  });
});

const amount = fc.bigInt({ min: 1n, max: 9_000_000_000n }).map((value) => poisha(value));

describe('opening-balance properties', () => {
  it('balances, and the plug is the only line that absorbs the difference', () => {
    fc.assert(
      fc.property(
        fc.array(amount, { minLength: 1, maxLength: 12 }),
        fc.array(amount, { maxLength: 12 }),
        (assetAmounts, liabilityAmounts) => {
          const assets = assetAmounts.map((value, index) => ({
            account: index % 2 === 0 ? INVENTORY : WALLET,
            amountPoisha: value,
          }));
          const liabilities = liabilityAmounts.map((value) => ({
            account: PAYABLE,
            amountPoisha: value,
            partyType: 'supplier' as const,
            partyId: SUPPLIER,
          }));

          const draft = openingBalanceDraft({
            orgId: ORG,
            asOf: ASOF,
            assets,
            liabilities,
            equity: EQUITY,
          });

          // The ledger's own rule: debits equal credits, so this can be posted.
          const debits = sum(draft.lines.map((line) => line.debitPoisha));
          const credits = sum(draft.lines.map((line) => line.creditPoisha));
          expect(debits).toBe(credits);
          expect(() => validateJournalDraft(draft)).not.toThrow();

          // The given lines are untouched: every asset is debited at its own amount and
          // every liability credited at its own, so nothing was adjusted to make it fit.
          const given = draft.lines.filter((line) => line.accountId !== EQUITY.accountId);
          const givenDebits = sum(given.map((line) => line.debitPoisha));
          const givenCredits = sum(given.map((line) => line.creditPoisha));
          expect(givenDebits).toBe(sum(assetAmounts));
          expect(givenCredits).toBe(sum(liabilityAmounts));

          // And the plug is exactly the remainder the dry run would have shown.
          const expected = openingEquityPoisha(assets, liabilities);
          const equityLine = draft.lines.find((line) => line.accountId === EQUITY.accountId);
          const posted =
            equityLine === undefined
              ? (0n as Poisha)
              : ((equityLine.creditPoisha - equityLine.debitPoisha) as Poisha);
          expect(posted).toBe(expected);
        },
      ),
    );
  });

  it('is the same journal however often it is drafted for the same day', () => {
    fc.assert(
      fc.property(fc.array(amount, { minLength: 1, maxLength: 6 }), (amounts) => {
        const assets = amounts.map((value) => ({ account: INVENTORY, amountPoisha: value }));
        const once = openingBalanceDraft({
          orgId: ORG,
          asOf: ASOF,
          assets,
          liabilities: [],
          equity: EQUITY,
        });
        const twice = openingBalanceDraft({
          orgId: ORG,
          asOf: ASOF,
          assets,
          liabilities: [],
          equity: EQUITY,
        });
        // The key carries the org and nothing else, so neither a retry nor a second
        // attempt at a different as-of date can create a second opening journal.
        expect(twice.idempotencyKey).toBe(once.idempotencyKey);
        expect(twice).toEqual(once);
      }),
    );
  });
});
