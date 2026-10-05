import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseCsv } from '../catalog/csv.js';
import { toIsoDate } from '../dates/index.js';
import { validateJournalDraft } from '../ledger/index.js';
import { mulQty, poisha, sum, ZERO } from '../money/index.js';
import type { PostingAccount } from '../posting/supply-received.js';
import {
  anonymizeTable,
  canCommit,
  demoPhone,
  importSlug,
  normalSide,
  openingJournal,
  openingPosition,
  reconcileOpening,
  reviewCourierCod,
  reviewCustomers,
  reviewOpeningStock,
  reviewSkus,
  reviewSupplierBalances,
  reviewWalletBalances,
  scaleTaka,
  stagedStockConflicts,
  toCsv,
  type CourierCodRow,
  type OpeningPosition,
  type OpeningStockRefs,
  type OpeningStockRow,
  type SkusRefs,
  type SupplierBalanceRow,
  type WalletBalanceRow,
} from './index.js';

/**
 * M14a's importers, with no database (checks 1 and 2's domain half).
 *
 * The properties are the ones the acceptance checks state: the opening trial balance of
 * any set of staged rows balances, its inventory line is Σ(qty × cost) and nothing else,
 * and a file with one bad row anywhere commits nothing. The worked examples are what an
 * accountant would check by hand.
 */

const SKU_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const SKU_B = 'aaaaaaaa-0000-4000-8000-000000000002';
const WH = 'bbbbbbbb-0000-4000-8000-000000000001';
const SHOW = 'bbbbbbbb-0000-4000-8000-000000000002';

function stockRefs(overrides: Partial<OpeningStockRefs> = {}): OpeningStockRefs {
  return {
    skus: new Map([
      ['ELY-0001-M', { id: SKU_A, held: false }],
      ['ELY-0001-L', { id: SKU_B, held: false }],
      ['ELY-HELD', { id: 'aaaaaaaa-0000-4000-8000-000000000009', held: true }],
    ]),
    locations: new Map([
      ['WH-01', { id: WH }],
      ['SR-01', { id: SHOW }],
    ]),
    staged: [],
    ...overrides,
  };
}

describe('opening stock', () => {
  it('values a worked example at Σ(qty × cost)', () => {
    // 10 @ ৳500 + 4 @ ৳500 in the showroom + 6 @ ৳720.50 = ৳11,323.00.
    const review = reviewOpeningStock(
      parseCsv(
        'sku,location,qty,unit_cost_taka\nELY-0001-M,WH-01,10,500\nELY-0001-M,SR-01,4,500.00\nely-0001-l,WH-01,6,720.50\n',
      ),
      stockRefs(),
    );
    expect(review.problems).toEqual([]);
    expect(review.rows).toHaveLength(3);
    expect(review.totals.units).toBe(20);
    expect(review.totals.stockValuePoisha).toBe(1_132_300n);
    expect(review.rows[2]?.skuCode).toBe('ELY-0001-L');
  });

  it('refuses a second cost for one SKU, in the file or against a staged file (D-216)', () => {
    const inFile = reviewOpeningStock(
      parseCsv('sku,location,qty,unit_cost_taka\nELY-0001-M,WH-01,1,500\nELY-0001-M,SR-01,1,520\n'),
      stockRefs(),
    );
    expect(inFile.problems.map((p) => p.column)).toEqual(['unit_cost_taka']);
    expect(inFile.problems[0]?.message).toContain('line 2');

    const staged: OpeningStockRow = {
      line: 2,
      skuId: SKU_A,
      skuCode: 'ELY-0001-M',
      locationId: WH,
      locationCode: 'WH-01',
      qty: 3,
      unitCostPoisha: poisha(50_000),
    };
    const against = reviewOpeningStock(
      parseCsv('sku,location,qty,unit_cost_taka\nELY-0001-M,SR-01,1,520\n'),
      stockRefs({ staged: [staged] }),
    );
    expect(against.problems[0]?.message).toContain('staged at another cost');

    const overlap = reviewOpeningStock(
      parseCsv('sku,location,qty,unit_cost_taka\nELY-0001-M,WH-01,1,500\n'),
      stockRefs({ staged: [staged] }),
    );
    expect(overlap.problems[0]?.message).toContain('already in a staged stock file');
  });

  it('refuses a SKU that already holds stock, a zero cost and a fractional quantity', () => {
    const review = reviewOpeningStock(
      parseCsv(
        'sku,location,qty,unit_cost_taka\nELY-HELD,WH-01,1,500\nELY-0001-M,WH-01,1,0\nELY-0001-L,WH-01,1.5,500\nELY-0001-L,XX,1,500\nNOPE,WH-01,1,500\n',
      ),
      stockRefs(),
    );
    expect(review.problems.map((p) => [p.line, p.column])).toEqual([
      [2, 'sku'],
      [3, 'unit_cost_taka'],
      [4, 'qty'],
      [5, 'location'],
      [6, 'sku'],
    ]);
  });

  it('refuses a purchase-cost file with an unknown column rather than ignoring it', () => {
    const review = reviewOpeningStock(
      parseCsv('sku,location,qty,unit_cost_taka,landed_cost\nELY-0001-M,WH-01,1,500,520\n'),
      stockRefs(),
    );
    expect(review.problems[0]?.column).toBe('landed_cost');
  });

  it('commits nothing when any one row is bad (check 2)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.nat(), (count, badSeed) => {
        const bad = badSeed % count;
        const lines = Array.from({ length: count }, (_, index) =>
          index === bad ? 'ELY-0001-M,WH-01,-1,500' : `ELY-0001-M,SR-0${String(index)},1,500`,
        );
        const locations = new Map(
          Array.from({ length: count }, (_, index) => [
            `SR-0${String(index)}`,
            { id: `loc-${String(index)}` },
          ]),
        );
        const review = reviewOpeningStock(
          parseCsv(`sku,location,qty,unit_cost_taka\n${lines.join('\n')}\n`),
          stockRefs({ locations: new Map([...locations, ['WH-01', { id: WH }]]) }),
        );
        expect(canCommit(review, review.rows.length).ok).toBe(false);
      }),
    );
  });

  it('never disagrees with the sum of its own rows', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            qty: fc.integer({ min: 1, max: 5000 }),
            cost: fc.integer({ min: 1, max: 100_000_000 }),
          }),
          { minLength: 1, maxLength: 30 },
        ),
        (specs) => {
          const skus = new Map(
            specs.map((_, index) => [
              `SKU-${String(index)}`,
              { id: `s${String(index)}`, held: false },
            ]),
          );
          const csv = specs
            .map((spec, index) => {
              const taka = `${String(Math.floor(spec.cost / 100))}.${String(spec.cost % 100).padStart(2, '0')}`;
              return `SKU-${String(index)},WH-01,${String(spec.qty)},${taka}`;
            })
            .join('\n');
          const review = reviewOpeningStock(
            parseCsv(`sku,location,qty,unit_cost_taka\n${csv}\n`),
            stockRefs({ skus }),
          );
          expect(review.problems).toEqual([]);
          const expected = specs.reduce((total, s) => total + BigInt(s.qty) * BigInt(s.cost), 0n);
          expect(review.totals.stockValuePoisha).toBe(expected);
        },
      ),
    );
  });

  it('finds two costs or a repeated location across staged rows (D-216)', () => {
    const row = (skuId: string, locationId: string, cost: number): OpeningStockRow => ({
      line: 2,
      skuId,
      skuCode: skuId === SKU_A ? 'ELY-0001-M' : 'ELY-0001-L',
      locationId,
      locationCode: locationId === WH ? 'WH-01' : 'SR-01',
      qty: 1,
      unitCostPoisha: poisha(cost),
    });
    expect(stagedStockConflicts([row(SKU_A, WH, 100), row(SKU_A, SHOW, 100)])).toEqual([]);
    expect(stagedStockConflicts([row(SKU_A, WH, 100), row(SKU_A, SHOW, 101)])).toEqual([
      'ELY-0001-M',
    ]);
    expect(
      stagedStockConflicts([row(SKU_B, WH, 100), row(SKU_A, WH, 5), row(SKU_B, WH, 100)]),
    ).toEqual(['ELY-0001-L']);
  });
});

describe('supplier, wallet and courier balances', () => {
  const suppliers = new Map([
    ['SUP-1', { id: 'cccccccc-0000-4000-8000-000000000001' }],
    ['SUP-2', { id: 'cccccccc-0000-4000-8000-000000000002' }],
  ]);

  it('reads dues and advances, and refuses a sign it would have to interpret', () => {
    const review = reviewSupplierBalances(
      parseCsv(
        'supplier,kind,amount_taka\nsup-1,payable,"1,20,000"\nSUP-2,advance,15000.50\nSUP-2,due,10\nSUP-1,advance,-50\n',
      ),
      { suppliers, staged: [] },
    );
    expect(review.problems.map((p) => [p.line, p.column])).toEqual([
      [4, 'kind'],
      [5, 'amount_taka'],
    ]);
    expect(review.totals.payablePoisha).toBe(12_000_000n);
    expect(review.totals.advancePoisha).toBe(1_500_050n);
  });

  it('refuses one supplier and kind twice, and against a staged file', () => {
    const staged: SupplierBalanceRow = {
      line: 2,
      supplierId: 'cccccccc-0000-4000-8000-000000000002',
      supplierCode: 'SUP-2',
      kind: 'payable',
      amountPoisha: poisha(100),
    };
    const review = reviewSupplierBalances(
      parseCsv('supplier,kind,amount_taka\nSUP-1,payable,1\nSUP-1,payable,2\nSUP-2,payable,3\n'),
      { suppliers, staged: [staged] },
    );
    expect(review.problems.map((p) => p.line)).toEqual([3, 4]);
  });

  it('reads wallet balances by account code and refuses an overdraft', () => {
    const wallets = new Map([
      ['1010-HQ', { id: 'w1' }],
      ['1100', { id: 'w2' }],
    ]);
    const review = reviewWalletBalances(
      parseCsv('wallet,amount_taka\n1010-hq,25000\n1100,-10\n9999,5\n'),
      { wallets, staged: [] },
    );
    expect(review.rows.map((row) => row.accountCode)).toEqual(['1010-HQ']);
    expect(review.problems.map((p) => [p.line, p.column])).toEqual([
      [3, 'amount_taka'],
      [4, 'wallet'],
    ]);
  });

  it('reads COD in transit per parcel and refuses a reference twice', () => {
    const couriers = new Map([['steadfast', { id: 'k1' }]]);
    const review = reviewCourierCod(
      parseCsv(
        'courier,reference,amount_taka\nSteadfast,SF-1001,1450\nsteadfast,SF-1002,990\nsteadfast,SF-1001,10\nsteadfast,has space,10\n',
      ),
      { couriers, staged: [] },
    );
    expect(review.totals.amountPoisha).toBe(244_000n);
    expect(review.problems.map((p) => [p.line, p.column])).toEqual([
      [4, 'reference'],
      [5, 'reference'],
    ]);
  });
});

// --- the opening trial balance ---------------------------------------------------

const ASOF = toIsoDate('2026-10-31');
const ORG = 'dddddddd-0000-4000-8000-00000000000a';

function account(subtype: PostingAccount['subtype'], id: string): PostingAccount {
  return { accountId: id, subtype, branchId: null };
}

const ACC = {
  inventory: 'eeeeeeee-0000-4000-8000-000000000001',
  wallet: 'eeeeeeee-0000-4000-8000-000000000002',
  advance: 'eeeeeeee-0000-4000-8000-000000000003',
  courier: 'eeeeeeee-0000-4000-8000-000000000004',
  payable: 'eeeeeeee-0000-4000-8000-000000000005',
  equity: 'eeeeeeee-0000-4000-8000-000000000006',
} as const;

/** The opening journal the posting step builds from a position, with fake accounts. */
function draftFrom(position: OpeningPosition) {
  const walletIds = position.lines
    .filter((line) => line.section === 'wallet' && line.refId !== null)
    .map((line) => line.refId ?? '');
  return openingJournal(position, {
    orgId: ORG,
    asOf: ASOF,
    accounts: {
      inventory: account('inventory', ACC.inventory),
      supplierAdvance: account('supplier_advance', ACC.advance),
      supplierPayable: account('supplier_payable', ACC.payable),
      courierReceivable: account('courier_receivable', ACC.courier),
      equity: account('opening_equity', ACC.equity),
      wallets: new Map(walletIds.map((id) => [id, account('wallet_bank', ACC.wallet)])),
    },
  });
}

const amount = fc.integer({ min: 1, max: 50_000_000 }).map((n) => poisha(n));
const uuidish = fc
  .integer({ min: 1, max: 6 })
  .map((n) => `00000000-0000-4000-8000-00000000000${String(n)}`);

const stockRow = fc.record({
  qty: fc.integer({ min: 1, max: 10_000 }),
  unitCostPoisha: fc.integer({ min: 1, max: 10_000_000 }).map((n) => poisha(n)),
});

describe('the opening position (check 1)', () => {
  it('balances, with the plug as the only derived figure, for any staged rows', () => {
    fc.assert(
      fc.property(
        fc.array(stockRow, { maxLength: 12 }),
        fc.array(
          fc.record({
            id: uuidish,
            kind: fc.constantFrom<'payable' | 'advance'>('payable', 'advance'),
            amountPoisha: amount,
          }),
          { maxLength: 6 },
        ),
        fc.array(fc.record({ id: uuidish, amountPoisha: amount }), { maxLength: 4 }),
        fc.array(fc.record({ id: uuidish, amountPoisha: amount }), { maxLength: 8 }),
        (stockSpecs, supplierSpecs, walletSpecs, courierSpecs) => {
          const stock: OpeningStockRow[] = stockSpecs.map((spec, index) => ({
            line: index + 2,
            skuId: `sku-${String(index)}`,
            skuCode: `SKU-${String(index)}`,
            locationId: WH,
            locationCode: 'WH-01',
            qty: spec.qty,
            unitCostPoisha: spec.unitCostPoisha,
          }));
          const suppliersRows: SupplierBalanceRow[] = supplierSpecs.map((spec, index) => ({
            line: index + 2,
            supplierId: spec.id,
            supplierCode: spec.id.slice(-4),
            kind: spec.kind,
            amountPoisha: spec.amountPoisha,
          }));
          const wallets: WalletBalanceRow[] = walletSpecs.map((spec, index) => ({
            line: index + 2,
            walletId: spec.id,
            accountCode: spec.id.slice(-4),
            amountPoisha: spec.amountPoisha,
          }));
          const couriers: CourierCodRow[] = courierSpecs.map((spec, index) => ({
            line: index + 2,
            courierId: spec.id,
            courierCode: 'steadfast',
            reference: `R-${String(index)}`,
            amountPoisha: spec.amountPoisha,
          }));

          const position = openingPosition({ stock, suppliers: suppliersRows, wallets, couriers });
          expect(position.balanced).toBe(true);
          expect(position.totalDebitPoisha).toBe(position.totalCreditPoisha);

          const stockValue = stock.reduce(
            (total, row) => total + mulQty(row.unitCostPoisha, row.qty),
            0n,
          );
          expect(position.stockValuePoisha).toBe(stockValue);

          const owned = [
            stockValue,
            ...suppliersRows.filter((r) => r.kind === 'advance').map((r) => r.amountPoisha),
            ...wallets.map((r) => r.amountPoisha),
            ...couriers.map((r) => r.amountPoisha),
          ].reduce((a, b) => a + b, 0n);
          const owed = suppliersRows
            .filter((r) => r.kind === 'payable')
            .reduce((a, r) => a + r.amountPoisha, 0n);
          expect(position.equityPoisha).toBe(owned - owed);

          if (position.lines.length === 0) return;
          // The posting rule's own journal agrees line for line, and the ledger accepts it.
          const draft = draftFrom(position);
          expect(() => validateJournalDraft(draft)).not.toThrow();
          const debits = sum(draft.lines.map((l) => l.debitPoisha));
          expect(debits).toBe(position.totalDebitPoisha);
          const inventory = draft.lines
            .filter((l) => l.accountId === ACC.inventory)
            .reduce((a, l) => a + l.debitPoisha, 0n);
          expect(inventory).toBe(stockValue);
        },
      ),
    );
  });

  it('shows a worked example an accountant can check by hand', () => {
    const position = openingPosition({
      stock: [
        {
          line: 2,
          skuId: SKU_A,
          skuCode: 'ELY-0001-M',
          locationId: WH,
          locationCode: 'WH-01',
          qty: 10,
          unitCostPoisha: poisha(50_000),
        },
      ],
      suppliers: [
        {
          line: 2,
          supplierId: 'sup',
          supplierCode: 'SUP-1',
          kind: 'payable',
          amountPoisha: poisha(800_000),
        },
      ],
      wallets: [{ line: 2, walletId: 'w', accountCode: '1100', amountPoisha: poisha(200_000) }],
      couriers: [
        {
          line: 2,
          courierId: 'k',
          courierCode: 'steadfast',
          reference: 'A',
          amountPoisha: poisha(30_000),
        },
        {
          line: 3,
          courierId: 'k',
          courierCode: 'steadfast',
          reference: 'B',
          amountPoisha: poisha(20_000),
        },
      ],
    });
    // Dr inventory ৳5,000 + bank ৳2,000 + courier ৳500 = ৳7,500; Cr supplier ৳8,000.
    // The brand owes more than it holds, so equity is debited ৳500.
    expect(position.lines.map((l) => [l.section, l.debitPoisha, l.creditPoisha])).toEqual([
      ['inventory', 500_000n, 0n],
      ['wallet', 200_000n, 0n],
      ['courier_receivable', 50_000n, 0n],
      ['supplier_payable', 0n, 800_000n],
      ['opening_equity', 50_000n, 0n],
    ]);
    expect(position.equityPoisha).toBe(-50_000n);
    expect(position.totalDebitPoisha).toBe(800_000n);
  });

  it('is empty, and balanced, with nothing staged', () => {
    const position = openingPosition({ stock: [], suppliers: [], wallets: [], couriers: [] });
    expect(position.lines).toEqual([]);
    expect(position.totalDebitPoisha).toBe(ZERO);
    expect(position.balanced).toBe(true);
  });
});

// --- customers -------------------------------------------------------------------

describe('customers', () => {
  it('normalises phones, skips existing buyers, and never echoes a number', () => {
    const review = reviewCustomers(
      parseCsv(
        [
          'phone,name,delivered,returned,cancelled,spent_taka',
          '01711000001,Rahima,5,1,,7450.50',
          '+8801711000002,Existing,2,0,0,',
          '01711000001,Twice,1,0,0,',
          '12345,Bad,0,0,0,',
          '01811000003,PaidNothingDelivered,0,1,0,500',
          '01911000004,Negative,3,0,0,-1',
          '01611000005,Blank counts,,,,',
          '',
        ].join('\n'),
      ),
      { existingPhones: new Set(['+8801711000002']) },
    );
    expect(
      review.rows.map((r) => [r.phoneE164, r.delivered, r.returned, r.cancelled, r.spentPoisha]),
    ).toEqual([
      ['+8801711000001', 5, 1, 0, 745_050n],
      ['+8801611000005', 0, 0, 0, 0n],
    ]);
    expect(review.skipped).toEqual([{ line: 3 }]);
    expect(review.problems.map((p) => [p.line, p.column])).toEqual([
      [4, 'phone'],
      [5, 'phone'],
      [6, 'spent_taka'],
      [7, 'spent_taka'],
    ]);
    for (const problem of review.problems) expect(problem.message).not.toMatch(/\d{5,}/);
  });

  it('refuses a column it does not read, such as a fraud flag or a date', () => {
    const review = reviewCustomers(parseCsv('phone,name,last_incident_date\n01711000001,A,\n'), {
      existingPhones: new Set(),
    });
    expect(review.problems.map((p) => p.column)).toEqual(['last_incident_date']);
    expect(canCommit(review, review.rows.length).ok).toBe(false);
  });
});

// --- SKUs ------------------------------------------------------------------------

function skuRefs(overrides: Partial<SkusRefs> = {}): SkusRefs {
  return {
    existingCodes: new Set(['OLD-1']),
    existingBarcodes: new Set(['BC-TAKEN']),
    existingProductNames: new Set(['Old Panjabi']),
    categories: new Map([['shirts', 'cat-shirts']]),
    size: {
      attributeId: 'attr-size',
      values: new Map([
        ['m', 'size-m'],
        ['medium', 'size-m'],
        ['l', 'size-l'],
      ]),
    },
    colour: { attributeId: 'attr-colour', values: new Map([['red', 'col-red']]) },
    ...overrides,
  };
}

describe('SKUs', () => {
  it('groups rows into products with their axes and keeps the brand’s codes', () => {
    const review = reviewSkus(
      parseCsv(
        'product,sku,price_taka,category,size,colour\nOxford Shirt,OX-M,1490,shirts,M,red\nOxford Shirt,ox-l,1490,shirts,l,Red\nTote,TOTE-1,650,,,\nOld Panjabi,OLD-1,2000,,,\n',
      ),
      skuRefs(),
    );
    expect(review.problems).toEqual([]);
    expect(review.skipped).toEqual([{ line: 5, code: 'OLD-1' }]);
    expect(review.products.map((p) => [p.name, p.categoryId, p.axisAttributeIds])).toEqual([
      ['Oxford Shirt', 'cat-shirts', ['attr-size', 'attr-colour']],
      ['Tote', null, []],
    ]);
    expect(review.products[0]?.skus.map((s) => [s.code, s.valueIds])).toEqual([
      ['OX-M', ['size-m', 'col-red']],
      ['OX-L', ['size-l', 'col-red']],
    ]);
    expect(review.skuCount).toBe(3);
  });

  it('never creates a size, and refuses a half-imported product', () => {
    const review = reviewSkus(
      parseCsv(
        'product,sku,price_taka,size\nShirt,S-XXL,100,XXL\nOld Panjabi,NEW-2,100,M\nPart,OLD-1,100,M\nPart,NEW-3,100,L\n',
      ),
      skuRefs(),
    );
    expect(review.problems.map((p) => [p.line, p.column])).toEqual([
      [2, 'size'],
      [3, 'product'],
      [5, 'product'],
    ]);
    expect(review.products).toEqual([]);
  });

  it('refuses a cost column (invariant 5)', () => {
    const review = reviewSkus(parseCsv('product,sku,price_taka,cost\nA,A-1,10,5\n'), skuRefs());
    expect(review.problems[0]?.column).toBe('cost');
  });

  it('leaves the ERP’s own barcode range to the ERP (D-603)', () => {
    const review = reviewSkus(
      parseCsv('product,sku,price_taka,barcode\nA,A-1,10,2000000000015\nB,B-1,10,5901234123457\n'),
      skuRefs(),
    );
    expect(review.problems.map((problem) => [problem.line, problem.column])).toEqual([
      [2, 'barcode'],
    ]);
  });
});

// --- the training org ------------------------------------------------------------

describe('anonymising for the training org (D-223)', () => {
  it('keeps no phone or name from the source, and stays a valid import', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            digits: fc.integer({ min: 10_000_000, max: 99_999_999 }),
            name: fc
              .string({ minLength: 1, maxLength: 20 })
              .filter((s) => !/[",\r\n]/.test(s) && s.trim() !== ''),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (people) => {
          const source = `phone,name,delivered\n${people
            .map((p, i) => `017${String(p.digits)},${p.name},${String(i)}`)
            .join('\n')}\n`;
          const out = toCsv(anonymizeTable('customers', parseCsv(source)));
          for (const person of people) expect(out).not.toContain(String(person.digits));
          const review = reviewCustomers(parseCsv(out), { existingPhones: new Set() });
          expect(review.problems).toEqual([]);
          expect(review.rows).toHaveLength(people.length);
          expect(new Set(review.rows.map((r) => r.phoneE164)).size).toBe(people.length);
        },
      ),
    );
  });

  it('never hands a row a fake that is a real number in the same file', () => {
    const source = [
      'phone,name',
      `${demoPhone(1)},Real Buyer`,
      `${demoPhone(0)},Another`,
      '01711000009,Third',
      '',
    ].join('\n');
    const out = anonymizeTable('customers', parseCsv(source));
    const phones = out.rows.map((row) => row.values.phone);
    expect(phones).toEqual([demoPhone(2), demoPhone(3), demoPhone(4)]);
  });

  it('scales money to whole poisha, deterministically, never to zero', () => {
    expect(scaleTaka('1000')).toBe('700.00');
    expect(scaleTaka('0.01')).toBe('0.01');
    expect(scaleTaka('1490.50')).toBe('1043.35');
    expect(scaleTaka('1490.50')).toBe(scaleTaka('1490.5'));
    expect(scaleTaka('0')).toBe('0.00');
    expect(demoPhone(0)).toMatch(/^\+8801[3-9]\d{8}$/);
    const courier = anonymizeTable(
      'courier_cod',
      parseCsv('courier,reference,amount_taka\nsteadfast,SF-REAL-1,100\n'),
    );
    expect(courier.rows[0]?.values.reference).toBe('DEMO-00001');
    expect(courier.rows[0]?.values.amount_taka).toBe('70.00');
  });
});

describe('canCommit', () => {
  it('refuses an empty file and any file with a problem', () => {
    expect(canCommit({ problems: [] }, 0).ok).toBe(false);
    expect(canCommit({ problems: [{ line: 2, column: null, message: 'x' }] }, 5).ok).toBe(false);
    expect(canCommit({ problems: [] }, 1).ok).toBe(true);
  });
});

// --- the reconciliation (check 5) -------------------------------------------------

describe('the reconciliation', () => {
  const position = openingPosition({
    stock: [
      {
        line: 2,
        skuId: SKU_A,
        skuCode: 'ELY-0001-M',
        locationId: WH,
        locationCode: 'WH-01',
        qty: 3,
        unitCostPoisha: poisha(10_000),
      },
    ],
    suppliers: [
      {
        line: 2,
        supplierId: 'sup',
        supplierCode: 'S1',
        kind: 'payable',
        amountPoisha: poisha(5_000),
      },
    ],
    wallets: [{ line: 2, walletId: 'w', accountCode: '1100', amountPoisha: poisha(2_000) }],
    couriers: [],
  });
  // Dr inventory 30,000 + wallet 2,000; Cr supplier 5,000 + equity 27,000.
  const journal = [
    { section: 'inventory' as const, refId: null, amountPoisha: poisha(30_000) },
    { section: 'wallet' as const, refId: 'w', amountPoisha: poisha(2_000) },
    { section: 'supplier_payable' as const, refId: 'sup', amountPoisha: poisha(5_000) },
    { section: 'opening_equity' as const, refId: null, amountPoisha: poisha(27_000) },
  ];

  it('agrees when the files, the journal and the modules say the same', () => {
    const report = reconcileOpening({
      position,
      journal,
      journalDebitPoisha: poisha(32_000),
      journalCreditPoisha: poisha(32_000),
      modules: journal,
    });
    expect(report.rows.map((row) => [row.section, row.agrees])).toEqual([
      ['inventory', true],
      ['wallet', true],
      ['supplier_payable', true],
      ['opening_equity', true],
    ]);
    expect(report.agrees).toBe(true);
  });

  it('shows the line a module disagrees on, and refuses an unbalanced journal', () => {
    const drifted = reconcileOpening({
      position,
      journal,
      journalDebitPoisha: poisha(32_000),
      journalCreditPoisha: poisha(32_000),
      // A wallet that was used before it was opened.
      modules: journal.map((f) =>
        f.section === 'wallet' ? { ...f, amountPoisha: poisha(2_500) } : f,
      ),
    });
    expect(drifted.rows.filter((row) => !row.agrees).map((row) => row.section)).toEqual(['wallet']);
    expect(drifted.agrees).toBe(false);

    const unbalanced = reconcileOpening({
      position,
      journal,
      journalDebitPoisha: poisha(32_000),
      journalCreditPoisha: poisha(31_999),
      modules: journal,
    });
    expect(unbalanced.journalBalanced).toBe(false);
    expect(unbalanced.agrees).toBe(false);
  });

  it('reports a journal line no file accounted for', () => {
    const report = reconcileOpening({
      position,
      journal: [...journal, { section: 'courier_receivable', refId: 'k', amountPoisha: poisha(1) }],
      journalDebitPoisha: poisha(32_001),
      journalCreditPoisha: poisha(32_001),
      modules: journal,
    });
    const extra = report.rows.find((row) => row.section === 'courier_receivable');
    expect(extra).toMatchObject({ importedPoisha: 0n, journalPoisha: 1n, agrees: false });
  });

  it('reports a balance a module holds that no file or journal line explains', () => {
    const report = reconcileOpening({
      position,
      journal,
      journalDebitPoisha: poisha(32_000),
      journalCreditPoisha: poisha(32_000),
      modules: [...journal, { section: 'supplier_payable', refId: 'old', amountPoisha: poisha(7) }],
    });
    const extra = report.rows.find((row) => row.refId === 'old');
    expect(extra).toMatchObject({ importedPoisha: 0n, journalPoisha: 0n, modulePoisha: 7n });
    expect(report.agrees).toBe(false);
  });

  it('reads a ledger balance on its normal side', () => {
    expect(normalSide('supplier_payable', 100n, 600n)).toBe(500n);
    expect(normalSide('wallet', 600n, 100n)).toBe(500n);
    expect(normalSide('opening_equity', 0n, 27_000n)).toBe(27_000n);
  });
});

describe('importSlug', () => {
  it('is deterministic, unique, and falls back for a Bangla-only name', () => {
    expect(importSlug('Blue Panjabi', 7, new Set())).toBe('blue-panjabi');
    expect(importSlug('Blue Panjabi', 7, new Set(['blue-panjabi']))).toBe('blue-panjabi-7');
    expect(importSlug('Blue Panjabi', 7, new Set(['blue-panjabi', 'blue-panjabi-7']))).toBe(
      'blue-panjabi-7-2',
    );
    expect(importSlug('লাল পাঞ্জাবি', 12, new Set())).toBe('product-12');
    expect(importSlug('Café Kurti', 1, new Set())).toBe('cafe-kurti');
    expect(importSlug('x'.repeat(300), 1, new Set())).toMatch(/^x{100}$/);
  });
});
