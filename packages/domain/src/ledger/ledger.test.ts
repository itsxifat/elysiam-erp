import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate } from '../dates/index.js';
import { allocate, poisha, sum, ZERO } from '../money/index.js';
import {
  ACCOUNT_SUBTYPE_NAMES,
  ACCOUNT_SUBTYPES,
  canonicalDraft,
  COST_SUBTYPES,
  idempotencyKey,
  LedgerError,
  normalBalanceOf,
  reverseDraft,
  trialBalance,
  validateJournalDraft,
  WALLET_SUBTYPES,
  type JournalDraft,
  type JournalLineDraft,
} from './index.js';

/** The journal model's pure half (architecture §7, M03 check 1). */

const ACCOUNTS = [
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
];
const SOURCE = '11111111-1111-4111-8111-111111111111';

function line(accountId: string, debit: bigint, credit: bigint): JournalLineDraft {
  return {
    accountId,
    debitPoisha: poisha(debit),
    creditPoisha: poisha(credit),
    branchId: null,
    partyType: null,
    partyId: null,
    memo: null,
  };
}

function draft(lines: JournalLineDraft[], overrides: Partial<JournalDraft> = {}): JournalDraft {
  return {
    businessDate: toIsoDate('2026-09-02'),
    sourceType: 'test',
    sourceId: SOURCE,
    event: 'posted',
    idempotencyKey: `test:${SOURCE}:posted`,
    memo: null,
    reversesJournalId: null,
    lines,
    ...overrides,
  };
}

function code(work: () => unknown): string | undefined {
  try {
    work();
  } catch (error) {
    if (error instanceof LedgerError) return error.code;
    throw error;
  }
  return undefined;
}

/**
 * A random balanced journal: a positive total split across 1–4 debit lines and,
 * independently, across 1–4 credit lines, each on a random account.
 */
const balancedDraft = fc
  .record({
    total: fc.bigInt({ min: 1n, max: 10n ** 12n }),
    debitWeights: fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 4 }),
    creditWeights: fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 1, maxLength: 4 }),
    debitAccounts: fc.array(fc.constantFrom(...ACCOUNTS), { minLength: 4, maxLength: 4 }),
    creditAccounts: fc.array(fc.constantFrom(...ACCOUNTS), { minLength: 4, maxLength: 4 }),
  })
  .map(({ total, debitWeights, creditWeights, debitAccounts, creditAccounts }) => {
    const debits = allocate(poisha(total), debitWeights).filter((part) => part > 0n);
    const credits = allocate(poisha(total), creditWeights).filter((part) => part > 0n);
    return draft([
      ...debits.map((amount, i) => line(debitAccounts[i] ?? ACCOUNTS[0] ?? '', amount, 0n)),
      ...credits.map((amount, i) => line(creditAccounts[i] ?? ACCOUNTS[1] ?? '', 0n, amount)),
    ]);
  });

describe('check 1 (domain): random sequences of valid drafts leave the trial balance at zero', () => {
  it('every generated draft validates, and the trial balance over all of them nets to zero', () => {
    fc.assert(
      fc.property(fc.array(balancedDraft, { minLength: 1, maxLength: 30 }), (drafts) => {
        for (const entry of drafts) {
          expect(() => validateJournalDraft(entry)).not.toThrow();
          const debits = sum(entry.lines.map((l) => l.debitPoisha));
          const credits = sum(entry.lines.map((l) => l.creditPoisha));
          expect(debits).toBe(credits);
        }
        const tb = trialBalance(drafts.flatMap((entry) => entry.lines));
        expect(tb.differencePoisha).toBe(0n);
        expect(tb.totalDebitPoisha).toBe(tb.totalCreditPoisha);
        expect(sum(tb.rows.map((row) => row.netPoisha))).toBe(0n);
      }),
      { numRuns: 500 },
    );
  });

  it('a journal and its reversal net every account to zero', () => {
    fc.assert(
      fc.property(balancedDraft, (entry) => {
        const reversal = reverseDraft(
          { id: SOURCE, reversesJournalId: null, lines: entry.lines },
          { businessDate: toIsoDate('2026-09-03'), reason: 'entered twice' },
        );
        expect(() => validateJournalDraft(reversal)).not.toThrow();
        const tb = trialBalance([...entry.lines, ...reversal.lines]);
        for (const row of tb.rows) expect(row.netPoisha).toBe(0n);
      }),
    );
  });
});

describe('validateJournalDraft refuses every malformed journal', () => {
  const good = draft([line(ACCOUNTS[0] ?? '', 500n, 0n), line(ACCOUNTS[1] ?? '', 0n, 500n)]);

  it('accepts a simple balanced journal', () => {
    expect(() => validateJournalDraft(good)).not.toThrow();
  });

  it('refuses an unbalanced journal', () => {
    expect(
      code(() =>
        validateJournalDraft(
          draft([line(ACCOUNTS[0] ?? '', 500n, 0n), line(ACCOUNTS[1] ?? '', 0n, 499n)]),
        ),
      ),
    ).toBe('JOURNAL_UNBALANCED');
  });

  it('refuses fewer than two lines', () => {
    expect(code(() => validateJournalDraft(draft([line(ACCOUNTS[0] ?? '', 0n, 0n)])))).toBe(
      'JOURNAL_TOO_FEW_LINES',
    );
    expect(code(() => validateJournalDraft(draft([])))).toBe('JOURNAL_TOO_FEW_LINES');
  });

  it('refuses a line with both sides, neither side, or a negative side', () => {
    const bad: [bigint, bigint][] = [
      [5n, 5n],
      [0n, 0n],
      [-5n, 0n],
    ];
    for (const [debit, credit] of bad) {
      expect(
        code(() =>
          validateJournalDraft(
            draft([
              line(ACCOUNTS[0] ?? '', debit, credit),
              line(ACCOUNTS[1] ?? '', 0n, 5n),
              line(ACCOUNTS[2] ?? '', 5n, 0n),
            ]),
          ),
        ),
        `${String(debit)}/${String(credit)}`,
      ).toBe('JOURNAL_LINE_INVALID');
    }
  });

  it('refuses a key that is not <source_type>:<source_id>:<event>', () => {
    expect(code(() => validateJournalDraft({ ...good, idempotencyKey: 'whatever' }))).toBe(
      'JOURNAL_KEY_INVALID',
    );
    expect(code(() => validateJournalDraft({ ...good, sourceId: 'not-a-uuid' }))).toBe(
      'JOURNAL_KEY_INVALID',
    );
    expect(code(() => idempotencyKey('Order', SOURCE, 'delivered'))).toBe('JOURNAL_KEY_INVALID');
    expect(idempotencyKey('order', SOURCE.toUpperCase(), 'delivered')).toBe(
      `order:${SOURCE}:delivered`,
    );
  });

  it('refuses a reversal that is not keyed on the journal it reverses', () => {
    expect(
      code(() => validateJournalDraft({ ...good, reversesJournalId: ACCOUNTS[0] ?? '' })),
    ).toBe('JOURNAL_KEY_INVALID');
  });

  it('refuses an impossible business date', () => {
    expect(
      code(() =>
        validateJournalDraft({
          ...good,
          businessDate: '2026-02-30' as JournalDraft['businessDate'],
        }),
      ),
    ).toBe('JOURNAL_DATE_INVALID');
  });

  it('refuses half a party', () => {
    expect(
      code(() =>
        validateJournalDraft(
          draft([
            { ...line(ACCOUNTS[0] ?? '', 500n, 0n), partyType: 'supplier' },
            line(ACCOUNTS[1] ?? '', 0n, 500n),
          ]),
        ),
      ),
    ).toBe('JOURNAL_LINE_INVALID');
  });
});

describe('canonicalDraft', () => {
  it('is the same for equal drafts and different when any amount differs', () => {
    fc.assert(
      fc.property(balancedDraft, fc.bigInt({ min: 1n, max: 100n }), (entry, bump) => {
        expect(canonicalDraft(entry)).toBe(canonicalDraft({ ...entry, lines: [...entry.lines] }));
        const [first, ...rest] = entry.lines;
        if (first === undefined) return;
        const changed = {
          ...entry,
          lines: [{ ...first, debitPoisha: poisha(first.debitPoisha + bump) }, ...rest],
        };
        expect(canonicalDraft(changed)).not.toBe(canonicalDraft(entry));
      }),
    );
  });
});

describe('reverseDraft', () => {
  it('swaps every side, points back, and keys on the original', () => {
    const original = draft([line(ACCOUNTS[0] ?? '', 700n, 0n), line(ACCOUNTS[1] ?? '', 0n, 700n)]);
    const reversal = reverseDraft(
      { id: SOURCE, reversesJournalId: null, lines: original.lines },
      { businessDate: toIsoDate('2026-09-05'), reason: '  typed the wrong wallet ' },
    );
    expect(reversal.idempotencyKey).toBe(`journal:${SOURCE}:reversed`);
    expect(reversal.reversesJournalId).toBe(SOURCE);
    expect(reversal.memo).toBe('typed the wrong wallet');
    expect(reversal.lines.map((l) => [l.debitPoisha, l.creditPoisha])).toEqual([
      [0n, 700n],
      [700n, 0n],
    ]);
  });

  it('will not reverse a reversal, and needs a reason', () => {
    expect(
      code(() =>
        reverseDraft(
          { id: SOURCE, reversesJournalId: ACCOUNTS[0] ?? '', lines: [] },
          { businessDate: toIsoDate('2026-09-05'), reason: 'x' },
        ),
      ),
    ).toBe('POSTING_INPUT_INVALID');
    expect(
      code(() =>
        reverseDraft(
          { id: SOURCE, reversesJournalId: null, lines: [] },
          { businessDate: toIsoDate('2026-09-05'), reason: '   ' },
        ),
      ),
    ).toBe('POSTING_INPUT_INVALID');
  });
});

describe('the subtype table', () => {
  it('matches §7: wallets, party subtypes and cost-bearing subtypes', () => {
    expect(WALLET_SUBTYPES).toEqual([
      'wallet_cash',
      'wallet_bank',
      'wallet_bkash',
      'wallet_mfs_other',
    ]);
    expect(ACCOUNT_SUBTYPES.supplier_payable.party).toBe('supplier');
    expect(ACCOUNT_SUBTYPES.courier_receivable.party).toBe('courier');
    expect(ACCOUNT_SUBTYPES.loan_payable.party).toBe('lender');
    expect(ACCOUNT_SUBTYPES.sales_discounts.normalBalance).toBe('debit');
    expect(COST_SUBTYPES).toEqual(
      expect.arrayContaining(['inventory', 'cogs', 'supplier_payable', 'goods_in_transit']),
    );
    expect(COST_SUBTYPES).not.toContain('wallet_cash');
    // 37 from §7, plus operating_expense (D-084) and opening_equity (M14a, D-213).
    expect(ACCOUNT_SUBTYPE_NAMES).toHaveLength(39);
  });

  it('expresses a balance on the normal side', () => {
    expect(normalBalanceOf('debit', poisha(900), poisha(200))).toBe(700n);
    expect(normalBalanceOf('credit', poisha(900), poisha(200))).toBe(-700n);
    expect(normalBalanceOf('credit', ZERO, poisha(50))).toBe(50n);
  });
});
