import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { toIsoDate, type IsoDate } from '../dates/index.js';
import { validateJournalDraft } from '../ledger/index.js';
import { poisha, type Poisha } from '../money/index.js';
import {
  AGING_BUCKETS,
  assertParcelInput,
  codAmountAsTaka,
  codSettlementDraft,
  courierChargesDraft,
  FAKE_STATUS_MAP,
  FAKE_STATUS_VOCABULARY,
  MAPPED_COURIER_CODES,
  matchedReceivableRelieved,
  matchSettlement,
  normalizeStatus,
  orderTriggerFor,
  PARCEL_STATUSES,
  resolveSettlementPostingDate,
  settlementOwesCourier,
  settlementPostsAnything,
  settlementRelievesPoisha,
  STEADFAST_STATUS_MAP,
  STEADFAST_STATUS_VOCABULARY,
  statusDedupeKey,
  summariseAging,
  takaToPoisha,
  unmappedStatuses,
  type ParcelInput,
  type SettlementCandidate,
  type SettlementFileRow,
} from './index.js';

/**
 * M12's pure logic (architecture §7, §9; D-006, D-037).
 *
 * The four claims this file is here to make, in the order the milestone's acceptance
 * checks name them:
 *
 * 2. **Every provider status is covered by a mapping test.** Not "the ones we
 *    remembered": the test enumerates each provider's declared vocabulary and asserts
 *    the mapping's key set equals it exactly, in both directions. A status the courier
 *    can send and we have no entry for fails here, and so does an entry for a status
 *    the courier does not have — which is the one that would otherwise sit in the
 *    table for years pretending to be coverage.
 * 3. **Duplicates cannot double-transition.** The dedupe key is deterministic for the
 *    same fact however it arrived, and `orderTriggerFor` returns null for a status
 *    that has already been applied. The database half of check 3 is in the server
 *    suite; this is the half that can be proven exhaustively.
 * 4. **D-037.** A settlement dated inside a closed period resolves to the earliest
 *    open period, and the original date survives the call.
 * 5. **The receivable reaches zero.** A property test over random statements: charges
 *    plus net always equal the collection, so the two journals always relieve exactly
 *    what delivery debited.
 */

const COURIER = '11111111-1111-4111-8111-111111111111';
const SETTLEMENT = '22222222-2222-4222-8222-222222222222';

let nextAccount = 0;
function account(subtype: string, branchId: string | null = null) {
  nextAccount += 1;
  return {
    accountId: `33333333-3333-4333-8333-${String(nextAccount).padStart(12, '0')}`,
    subtype: subtype as never,
    branchId,
  };
}

const RECEIVABLE = account('courier_receivable');
const CHARGES = account('courier_charges');
const RETURNS = account('return_charges');
const BANK = account('wallet_bank');

function day(value: string): IsoDate {
  return toIsoDate(value);
}

// --- status mapping (check 2) --------------------------------------------------

describe('courier status mapping', () => {
  it('maps every status each provider declares, and declares none it cannot map', () => {
    /*
     * Against each provider's *transcribed* vocabulary, never `Object.keys(map.statuses)`.
     * The M12 version took the map's own keys as the vocabulary, so `unmappedStatuses` could
     * not return anything and the test could not fail. The lists are typed out in
     * `status.ts` from the source each one cites; the key sets must be equal both ways.
     */
    for (const [map, vocabulary] of [
      [STEADFAST_STATUS_MAP, STEADFAST_STATUS_VOCABULARY],
      [FAKE_STATUS_MAP, FAKE_STATUS_VOCABULARY],
    ] as const) {
      expect(unmappedStatuses(map, vocabulary)).toEqual([]);
      expect(Object.keys(map.statuses).sort()).toEqual([...vocabulary].sort());

      for (const word of vocabulary) {
        const normalized = normalizeStatus(map, word);
        // Every mapping target is one of §9's twelve, and the raw word survives.
        expect(PARCEL_STATUSES).toContain(normalized.status);
        expect(normalized.raw).toBe(word);
      }
    }
  });

  it('covers all twelve normalized statuses through the fake courier', () => {
    // The fake is the adapter every test and every local dev run uses, so it is the
    // one that has to exercise each branch. A normalized status no provider can
    // produce is a code path nothing ever runs.
    const reached = new Set(
      Object.keys(FAKE_STATUS_MAP.statuses).map(
        (word) => normalizeStatus(FAKE_STATUS_MAP, word).status,
      ),
    );
    expect([...reached].sort()).toEqual([...PARCEL_STATUSES].sort());
  });

  it('keeps the raw status and answers unknown for a word it has never seen', () => {
    const seen = normalizeStatus(STEADFAST_STATUS_MAP, 'teleported');
    expect(seen.status).toBe('unknown');
    expect(seen.raw).toBe('teleported');
  });

  it('ignores case and surrounding space, because one courier sends both', () => {
    expect(normalizeStatus(STEADFAST_STATUS_MAP, '  Delivered ').status).toBe('delivered');
  });

  it('names every provider it knows', () => {
    // M15 added Pathao and RedX; their completeness is asserted in `m15.test.ts`.
    expect([...MAPPED_COURIER_CODES].sort()).toEqual(['fake', 'pathao', 'redx', 'steadfast']);
  });

  it('knows every delivery status Steadfast’s API document lists (D-916)', () => {
    for (const word of [
      'pending',
      'in_review',
      'hold',
      'delivered_approval_pending',
      'partial_delivered_approval_pending',
      'cancelled_approval_pending',
      'unknown_approval_pending',
      'delivered',
      'partial_delivered',
      'cancelled',
      'exceptional',
      'unknown',
    ]) {
      expect(Object.keys(STEADFAST_STATUS_MAP.statuses), word).toContain(word);
    }
    // Lost or damaged is a parcel to chase, never one on its way or delivered.
    expect(normalizeStatus(STEADFAST_STATUS_MAP, 'exceptional').status).toBe('hold');
  });

  it('never recognises an unconfirmed delivery as delivered (D-003)', () => {
    // Revenue is recognised on delivery. A rider's word that Steadfast has not
    // confirmed would mean recognising it and reversing it next week, every week.
    for (const word of [
      'delivered_approval_pending',
      'partial_delivered_approval_pending',
      'cancelled_approval_pending',
      'unknown_approval_pending',
    ]) {
      const status = normalizeStatus(STEADFAST_STATUS_MAP, word).status;
      expect(status).not.toBe('delivered');
      expect(status).not.toBe('partial_delivered');
    }
  });
});

describe('courier status → order trigger', () => {
  it('moves a shipped order and nothing else', () => {
    expect(orderTriggerFor('delivered', 'shipped')).toBe('deliver');
    expect(orderTriggerFor('partial_delivered', 'shipped')).toBe('deliver_partially');
    expect(orderTriggerFor('return_in_transit', 'shipped')).toBe('start_return');
    // §9: once shipped, a cancellation is a return.
    expect(orderTriggerFor('cancelled', 'shipped')).toBe('start_return');
  });

  it('returns null for a status that has already been applied (check 3)', () => {
    // The second copy of a delivered webhook. Nothing to do, so nothing is attempted
    // and nothing is posted.
    expect(orderTriggerFor('delivered', 'delivered')).toBeNull();
    expect(orderTriggerFor('return_in_transit', 'return_in_transit')).toBeNull();
  });

  it('never receives a return on the courier’s word alone', () => {
    // §9 gives `returned` to the warehouse receiving and inspecting. A webhook that
    // performed it would put stock back on a shelf nobody has looked in.
    for (const from of ['shipped', 'return_in_transit', 'partially_delivered'] as const) {
      expect(orderTriggerFor('returned_to_merchant', from)).not.toBe('receive_return');
    }
    // From anywhere but `shipped` it does nothing at all.
    expect(orderTriggerFor('returned_to_merchant', 'return_in_transit')).toBeNull();
    expect(orderTriggerFor('returned_to_merchant', 'partially_delivered')).toBeNull();
  });

  it('starts the return path for a parcel reported back at the merchant (M15)', () => {
    // Pathao reports a return only once it is complete. Without this the order stays
    // `shipped`, and `receive_return` is refused from `shipped` — so the warehouse could
    // not receive a parcel that was already on its floor. `start_return` has no effects.
    expect(orderTriggerFor('returned_to_merchant', 'shipped')).toBe('start_return');
  });

  it('never cancels an order that has not shipped', () => {
    for (const from of ['pending', 'confirmed', 'packed'] as const) {
      expect(orderTriggerFor('cancelled', from)).toBeNull();
    }
  });

  it('produces a trigger for no tracking-only status, from anywhere', () => {
    const tracking = [
      'booked',
      'pickup_pending',
      'picked_up',
      'in_transit',
      'out_for_delivery',
      'hold',
      'unknown',
    ] as const;
    for (const status of tracking) {
      expect(orderTriggerFor(status, 'shipped')).toBeNull();
    }
  });
});

describe('the status dedupe key (§9)', () => {
  const at = new Date('2026-03-04T10:11:12.000Z');

  const PARCEL = '66666666-6666-4666-8666-666666666666';

  it('is the same for one fact however it arrived', () => {
    // A poll and a webhook describing the same event must collide, or the order is
    // transitioned twice — refused the second time, but only after the attempt. The
    // sub-second difference between the two representations is exactly what it ignores.
    const fromWebhook = statusDedupeKey({
      consignmentId: PARCEL,
      status: 'delivered',
      occurredAt: at,
    });
    const fromPoll = statusDedupeKey({
      consignmentId: PARCEL.toUpperCase(),
      status: 'delivered',
      occurredAt: new Date('2026-03-04T10:11:12.874Z'),
    });
    expect(fromPoll).toBe(fromWebhook);
  });

  it('separates two different statuses at the same instant', () => {
    const a = statusDedupeKey({ consignmentId: PARCEL, status: 'hold', occurredAt: at });
    const b = statusDedupeKey({ consignmentId: PARCEL, status: 'delivered', occurredAt: at });
    expect(a).not.toBe(b);
  });

  it('separates two parcels, so a rebooked order’s events never collide', () => {
    const a = statusDedupeKey({ consignmentId: PARCEL, status: 'hold', occurredAt: at });
    const b = statusDedupeKey({
      consignmentId: '77777777-7777-4777-8777-777777777777',
      status: 'hold',
      occurredAt: at,
    });
    expect(a).not.toBe(b);
  });
});

// --- booking input -------------------------------------------------------------

function parcel(overrides: Partial<ParcelInput> = {}): ParcelInput {
  return {
    reference: 'OUR-2609-00042',
    address: {
      recipientName: 'Rahim Uddin',
      recipientPhoneE164: '+8801712345678',
      district: 'Dhaka',
      thana: 'Gulshan',
      area: 'Niketan',
      addressLine: 'House 12, Road 3',
    },
    codAmountPoisha: poisha(250_000),
    itemDescription: 'Kurti',
    note: null,
    weightGrams: 500,
    ...overrides,
  };
}

describe('parcel input', () => {
  it('accepts a well-formed parcel', () => {
    expect(() => assertParcelInput(parcel())).not.toThrow();
  });

  it('refuses a parcel the courier would accept and fail to deliver', () => {
    const cases: readonly Partial<ParcelInput>[] = [
      { reference: '   ' },
      { address: { ...parcel().address, recipientName: '' } },
      { address: { ...parcel().address, addressLine: '' } },
      { address: { ...parcel().address, recipientPhoneE164: '+8809912345678' } },
      { address: { ...parcel().address, recipientPhoneE164: '01712345678' } },
      { codAmountPoisha: poisha(-1) },
      { codAmountPoisha: poisha(2_000_000_000) },
      { weightGrams: 0 },
    ];
    for (const override of cases) {
      expect(() => assertParcelInput(parcel(override))).toThrow();
    }
  });

  it('never puts the phone number in the refusal (invariant 10)', () => {
    try {
      assertParcelInput(
        parcel({ address: { ...parcel().address, recipientPhoneE164: '+8809912345678' } }),
      );
      expect.unreachable('should have refused');
    } catch (error) {
      expect(String(error)).not.toContain('9912345678');
    }
  });

  it('allows a prepaid parcel with no COD', () => {
    expect(() => assertParcelInput(parcel({ codAmountPoisha: poisha(0) }))).not.toThrow();
  });
});

describe('taka on the wire', () => {
  it('renders poisha as taka with two decimals, always', () => {
    expect(codAmountAsTaka(poisha(0))).toBe('0.00');
    expect(codAmountAsTaka(poisha(5))).toBe('0.05');
    expect(codAmountAsTaka(poisha(250_000))).toBe('2500.00');
    expect(codAmountAsTaka(poisha(1_234_567))).toBe('12345.67');
  });

  it('round-trips every amount a courier could carry', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 1_000_000_000n }), (value) => {
        expect(takaToPoisha(codAmountAsTaka(value as Poisha))).toBe(value);
      }),
      { numRuns: 400 },
    );
  });

  it('parses the four shapes settlement files actually contain', () => {
    expect(takaToPoisha('1234')).toBe(123_400n);
    expect(takaToPoisha('1234.5')).toBe(123_450n);
    expect(takaToPoisha('1,234.50')).toBe(123_450n);
    expect(takaToPoisha('৳1,234.50')).toBe(123_450n);
  });

  it('refuses a column that is not taka rather than rounding it', () => {
    // A third decimal means the column is something else. Rounding would turn one
    // mapping mistake into a hundred small posting errors.
    expect(() => takaToPoisha('12.345')).toThrow();
    expect(() => takaToPoisha('twelve')).toThrow();
  });
});

// --- settlement matching (check 4) ---------------------------------------------

function row(overrides: Partial<SettlementFileRow> = {}): SettlementFileRow {
  return {
    rowNo: 1,
    consignmentNo: 'CN-1',
    reference: 'OUR-2609-00001',
    codCollectedPoisha: poisha(250_000),
    deliveryChargePoisha: poisha(8_000),
    returnChargePoisha: poisha(0),
    otherChargePoisha: poisha(1_000),
    netPoisha: poisha(241_000),
    ...overrides,
  };
}

function candidate(overrides: Partial<SettlementCandidate> = {}): SettlementCandidate {
  return {
    consignmentId: '44444444-4444-4444-8444-444444444441',
    orderId: '55555555-5555-4555-8555-555555555551',
    orderNo: 'OUR-2609-00001',
    consignmentNo: 'CN-1',
    receivablePoisha: poisha(250_000),
    settled: false,
    ...overrides,
  };
}

describe('settlement matching', () => {
  it('matched totals equal the file totals when everything matches (check 4)', () => {
    const rows = [row(), row({ rowNo: 2, consignmentNo: 'CN-2', reference: 'OUR-2609-00002' })];
    const candidates = [
      candidate(),
      candidate({
        consignmentId: '44444444-4444-4444-8444-444444444442',
        orderId: '55555555-5555-4555-8555-555555555552',
        orderNo: 'OUR-2609-00002',
        consignmentNo: 'CN-2',
      }),
    ];

    const { totals, exceptions } = matchSettlement(rows, candidates);

    expect(exceptions).toEqual([]);
    expect(totals.matchedRowCount).toBe(2);
    expect(totals.matchedGrossPoisha).toBe(totals.fileGrossPoisha);
    expect(totals.matchedChargesPoisha).toBe(totals.fileChargesPoisha);
    expect(totals.matchedNetPoisha).toBe(totals.fileNetPoisha);
    expect(totals.fileGrossPoisha).toBe(500_000n);
    expect(totals.fileChargesPoisha).toBe(18_000n);
    expect(totals.fileNetPoisha).toBe(482_000n);
  });

  it('lists every kind of mismatch and excludes it from the totals (check 4)', () => {
    const rows = [
      row(),
      // Not ours at all.
      row({ rowNo: 2, consignmentNo: 'CN-NOPE', reference: 'SOMEONE-ELSE' }),
      // The file's own columns disagree.
      row({ rowNo: 3, consignmentNo: 'CN-3', reference: 'OUR-2609-00003', netPoisha: poisha(1) }),
      // The courier collected something other than what we billed.
      row({
        rowNo: 4,
        consignmentNo: 'CN-4',
        reference: 'OUR-2609-00004',
        codCollectedPoisha: poisha(200_000),
        netPoisha: poisha(191_000),
      }),
      // Already settled last month.
      row({ rowNo: 5, consignmentNo: 'CN-5', reference: 'OUR-2609-00005' }),
      // The same parcel twice in one file.
      row({ rowNo: 6, consignmentNo: 'CN-1', reference: 'OUR-2609-00001' }),
    ];
    const candidates = [
      candidate(),
      ...[3, 4, 5].map((n) =>
        candidate({
          consignmentId: `44444444-4444-4444-8444-44444444444${String(n)}`,
          orderId: `55555555-5555-4555-8555-55555555555${String(n)}`,
          orderNo: `OUR-2609-0000${String(n)}`,
          consignmentNo: `CN-${String(n)}`,
          settled: n === 5,
        }),
      ),
    ];

    const { totals, exceptions, lines } = matchSettlement(rows, candidates);

    expect(totals.matchedRowCount).toBe(1);
    expect(totals.exceptionCount).toBe(5);
    expect(exceptions.map((line) => line.match)).toEqual([
      'unmatched',
      'amount_mismatch',
      'amount_mismatch',
      'already_settled',
      'duplicate',
    ]);
    // Every exception says something an accountant can act on.
    for (const exception of exceptions) expect(exception.note).not.toBeNull();
    // And only the matched row's money is in the matched totals.
    expect(totals.matchedGrossPoisha).toBe(250_000n);
    expect(totals.fileGrossPoisha).toBeGreaterThan(totals.matchedGrossPoisha);
    expect(lines[0]?.match).toBe('matched');
  });

  it('matches on our reference when the courier’s number is not one we know', () => {
    const { totals } = matchSettlement([row({ consignmentNo: 'CN-RENUMBERED' })], [candidate()]);
    expect(totals.matchedRowCount).toBe(1);
  });

  it('accepts a file that states no net of its own', () => {
    const { totals, exceptions } = matchSettlement([row({ netPoisha: null })], [candidate()]);
    expect(exceptions).toEqual([]);
    expect(totals.matchedNetPoisha).toBe(241_000n);
  });

  it('accepts a returned parcel: no collection, a return fee, a negative net', () => {
    // Ordinary, and it must not need a person. §7's charges journal credits the
    // receivable with the fee, which says the courier no longer owes us that money.
    const { exceptions, totals } = matchSettlement(
      [
        row({
          codCollectedPoisha: poisha(0),
          deliveryChargePoisha: poisha(0),
          returnChargePoisha: poisha(6_000),
          otherChargePoisha: poisha(0),
          netPoisha: null,
        }),
      ],
      [candidate({ receivablePoisha: poisha(0) })],
    );
    expect(exceptions).toEqual([]);
    expect(totals.matchedNetPoisha).toBe(-6_000n);
    expect(settlementOwesCourier(totals)).toBe(true);
  });

  it('refuses a whole statement that would pay the courier rather than us', () => {
    const returnsOnly = matchSettlement(
      [
        row({
          codCollectedPoisha: poisha(0),
          deliveryChargePoisha: poisha(0),
          returnChargePoisha: poisha(6_000),
          otherChargePoisha: poisha(0),
          netPoisha: null,
        }),
      ],
      [candidate({ receivablePoisha: poisha(0) })],
    );
    expect(settlementOwesCourier(returnsOnly.totals)).toBe(true);

    // One return inside an otherwise normal week is not refused.
    const normalWeek = matchSettlement(
      [
        row(),
        row({
          rowNo: 2,
          consignmentNo: 'CN-2',
          reference: 'OUR-2609-00002',
          codCollectedPoisha: poisha(0),
          deliveryChargePoisha: poisha(0),
          returnChargePoisha: poisha(6_000),
          otherChargePoisha: poisha(0),
          netPoisha: null,
        }),
      ],
      [
        candidate(),
        candidate({
          consignmentId: '44444444-4444-4444-8444-444444444442',
          orderId: '55555555-5555-4555-8555-555555555552',
          orderNo: 'OUR-2609-00002',
          consignmentNo: 'CN-2',
          receivablePoisha: poisha(0),
        }),
      ],
    );
    expect(settlementOwesCourier(normalWeek.totals)).toBe(false);
    expect(normalWeek.totals.matchedNetPoisha).toBe(235_000n);
  });

  it('says whether there is anything to post at all', () => {
    const nothing = matchSettlement([], []);
    expect(settlementPostsAnything(nothing.totals)).toBe(false);
    const something = matchSettlement([row()], [candidate()]);
    expect(settlementPostsAnything(something.totals)).toBe(true);
  });

  it('relieves exactly what the matched consignments owe (check 5, property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            cod: fc.bigInt({ min: 0n, max: 10_000_000n }),
            delivery: fc.bigInt({ min: 0n, max: 20_000n }),
            ret: fc.bigInt({ min: 0n, max: 20_000n }),
            other: fc.bigInt({ min: 0n, max: 20_000n }),
          }),
          { minLength: 1, maxLength: 20 },
        ),
        (entries) => {
          const rows = entries.map((entry, index) => {
            const charges = entry.delivery + entry.ret + entry.other;
            // Keep the row postable: the matcher refuses charges above the collection,
            // and that refusal is itself tested above.
            const cod = entry.cod + charges;
            return row({
              rowNo: index + 1,
              consignmentNo: `CN-${String(index)}`,
              reference: `REF-${String(index)}`,
              codCollectedPoisha: poisha(cod),
              deliveryChargePoisha: poisha(entry.delivery),
              returnChargePoisha: poisha(entry.ret),
              otherChargePoisha: poisha(entry.other),
              netPoisha: null,
            });
          });
          const candidates = rows.map((entry, index) =>
            candidate({
              consignmentId: `44444444-4444-4444-8444-4444444444${String(index).padStart(2, '0')}`,
              orderId: `55555555-5555-4555-8555-5555555555${String(index).padStart(2, '0')}`,
              orderNo: `REF-${String(index)}`,
              consignmentNo: `CN-${String(index)}`,
              receivablePoisha: poisha(entry.codCollectedPoisha),
            }),
          );

          const { totals, exceptions } = matchSettlement(rows, candidates);
          expect(exceptions).toEqual([]);
          // The identity acceptance check 5 rests on: charges + net = what delivery
          // debited, so the consignments' receivable returns to exactly zero.
          expect(matchedReceivableRelieved(totals)).toBe(totals.matchedGrossPoisha);
        },
      ),
      { numRuns: 200 },
    );
  });
});

// --- D-037 (check 4) -----------------------------------------------------------

describe('D-037: a settlement dated in a closed period', () => {
  it('posts on its own date when nothing is closed', () => {
    const resolved = resolveSettlementPostingDate(day('2026-03-31'), []);
    expect(resolved.postingDate).toBe('2026-03-31');
    expect(resolved.deferred).toBe(false);
    expect(resolved.settlementDate).toBe('2026-03-31');
  });

  it('posts on its own date when its month is still open', () => {
    const resolved = resolveSettlementPostingDate(day('2026-03-31'), [day('2026-02-01')]);
    expect(resolved.postingDate).toBe('2026-03-31');
    expect(resolved.deferred).toBe(false);
  });

  it('moves to the earliest open period and keeps its own date', () => {
    const resolved = resolveSettlementPostingDate(day('2026-03-31'), [
      day('2026-02-01'),
      day('2026-03-01'),
    ]);
    expect(resolved.postingDate).toBe('2026-04-01');
    expect(resolved.deferred).toBe(true);
    // The half of D-037 that is easy to lose.
    expect(resolved.settlementDate).toBe('2026-03-31');
  });

  it('uses the latest closed month, not the first gap (D-093)', () => {
    // January and March closed, February not. A February settlement must not post
    // into a month sandwiched between two closed ones: no trial balance could be
    // re-run over it.
    const resolved = resolveSettlementPostingDate(day('2026-02-15'), [
      day('2026-01-01'),
      day('2026-03-01'),
    ]);
    expect(resolved.postingDate).toBe('2026-04-01');
    expect(resolved.deferred).toBe(true);
  });

  it('never moves a settlement backwards', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 12 }),
        (settlementMonth, closedMonth) => {
          const settlementDate = day(`2026-${String(settlementMonth).padStart(2, '0')}-15`);
          const resolved = resolveSettlementPostingDate(settlementDate, [
            day(`2026-${String(closedMonth).padStart(2, '0')}-01`),
          ]);
          expect(resolved.postingDate >= settlementDate).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });
});

// --- the journals (check 5) ----------------------------------------------------

describe('§7 settlement journals', () => {
  const base = {
    settlementId: SETTLEMENT,
    postingDate: day('2026-04-01'),
    settlementDate: day('2026-03-31'),
    courierReceivable: RECEIVABLE,
    courierId: COURIER,
    branchId: null,
    memo: null,
  };

  it('charges: Dr courier charges + Dr return charges / Cr courier receivable', () => {
    const draft = courierChargesDraft({
      ...base,
      courierCharges: CHARGES,
      returnCharges: RETURNS,
      deliveryChargesPoisha: poisha(8_000),
      returnChargesPoisha: poisha(3_000),
      otherChargesPoisha: poisha(1_000),
    });

    expect(() => validateJournalDraft(draft)).not.toThrow();
    expect(draft.idempotencyKey).toBe(`courier_settlement:${SETTLEMENT}:charges`);
    expect(draft.businessDate).toBe('2026-04-01');
    // Surcharges join the delivery fee on Courier charges; returns keep their own
    // account, because §7 gives them one.
    const debits = draft.lines.filter((line) => line.debitPoisha > 0n);
    expect(debits.find((line) => line.accountId === CHARGES.accountId)?.debitPoisha).toBe(9_000n);
    expect(debits.find((line) => line.accountId === RETURNS.accountId)?.debitPoisha).toBe(3_000n);
    const credit = draft.lines.find((line) => line.creditPoisha > 0n);
    expect(credit?.creditPoisha).toBe(12_000n);
    expect(credit?.partyType).toBe('courier');
    expect(credit?.partyId).toBe(COURIER);
  });

  it('records the statement’s own date in the memo when it posted later (D-037)', () => {
    const draft = courierChargesDraft({
      ...base,
      courierCharges: CHARGES,
      returnCharges: RETURNS,
      deliveryChargesPoisha: poisha(8_000),
      returnChargesPoisha: poisha(0),
      otherChargesPoisha: poisha(0),
    });
    expect(draft.memo).toContain('2026-03-31');
  });

  it('says nothing about dates when the settlement posted on its own', () => {
    const draft = courierChargesDraft({
      ...base,
      postingDate: day('2026-03-31'),
      courierCharges: CHARGES,
      returnCharges: RETURNS,
      deliveryChargesPoisha: poisha(8_000),
      returnChargesPoisha: poisha(0),
      otherChargesPoisha: poisha(0),
    });
    expect(draft.memo).toBeNull();
  });

  it('cash: Dr wallet / Cr courier receivable (net)', () => {
    const draft = codSettlementDraft({ ...base, wallet: BANK, netPoisha: poisha(238_000) });
    expect(() => validateJournalDraft(draft)).not.toThrow();
    expect(draft.idempotencyKey).toBe(`courier_settlement:${SETTLEMENT}:received`);
    expect(draft.lines).toHaveLength(2);
    expect(draft.lines[0]?.debitPoisha).toBe(238_000n);
    expect(draft.lines[1]?.partyType).toBe('courier');
  });

  it('refuses a posting date before the statement’s own (D-037)', () => {
    expect(() =>
      codSettlementDraft({
        ...base,
        postingDate: day('2026-03-01'),
        wallet: BANK,
        netPoisha: poisha(1_000),
      }),
    ).toThrow(/never posts before/);
  });

  it('refuses a settlement into something that is not a wallet', () => {
    expect(() =>
      codSettlementDraft({ ...base, wallet: CHARGES, netPoisha: poisha(1_000) }),
    ).toThrow(/wallet/);
  });

  it('refuses a journal of nothing rather than letting the database refuse it', () => {
    expect(() =>
      courierChargesDraft({
        ...base,
        courierCharges: CHARGES,
        returnCharges: RETURNS,
        deliveryChargesPoisha: poisha(0),
        returnChargesPoisha: poisha(0),
        otherChargesPoisha: poisha(0),
      }),
    ).toThrow(/no charges/);
    expect(() => codSettlementDraft({ ...base, wallet: BANK, netPoisha: poisha(0) })).toThrow(
      /pays nothing/,
    );
  });

  it('balances for any statement, and relieves the collection exactly', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 50_000n }),
        fc.bigInt({ min: 0n, max: 50_000n }),
        fc.bigInt({ min: 0n, max: 50_000n }),
        fc.bigInt({ min: 1n, max: 900_000_000n }),
        (delivery, ret, other, net) => {
          const charges = courierChargesDraft({
            ...base,
            courierCharges: CHARGES,
            returnCharges: RETURNS,
            deliveryChargesPoisha: poisha(delivery),
            returnChargesPoisha: poisha(ret),
            otherChargesPoisha: poisha(other),
          });
          const cash = codSettlementDraft({ ...base, wallet: BANK, netPoisha: poisha(net) });

          expect(() => validateJournalDraft(charges)).not.toThrow();
          expect(() => validateJournalDraft(cash)).not.toThrow();

          const relieved = [...charges.lines, ...cash.lines]
            .filter((line) => line.accountId === RECEIVABLE.accountId)
            .reduce((total, line) => total + line.creditPoisha, 0n);
          expect(relieved).toBe(
            settlementRelievesPoisha({
              deliveryChargesPoisha: poisha(delivery),
              returnChargesPoisha: poisha(ret),
              otherChargesPoisha: poisha(other),
              netPoisha: poisha(net),
            }),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

// --- aging --------------------------------------------------------------------

describe('courier receivable aging (§7)', () => {
  it('uses §7’s four buckets and nothing else', () => {
    expect(AGING_BUCKETS).toEqual(['0_7', '8_30', '31_60', '60_plus']);
  });

  it('puts each item in the bucket its age names', () => {
    const summary = summariseAging(day('2026-04-01'), [
      { since: day('2026-03-30'), amountPoisha: poisha(100) },
      { since: day('2026-03-20'), amountPoisha: poisha(200) },
      { since: day('2026-02-20'), amountPoisha: poisha(400) },
      { since: day('2025-12-01'), amountPoisha: poisha(800) },
    ]);
    expect(summary['0_7']).toBe(100n);
    expect(summary['8_30']).toBe(200n);
    expect(summary['31_60']).toBe(400n);
    expect(summary['60_plus']).toBe(800n);
    expect(summary.totalPoisha).toBe(1_500n);
  });

  it('sums to the total whatever the dates are', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            days: fc.integer({ min: 0, max: 400 }),
            amount: fc.bigInt({ min: 0n, max: 1_000_000n }),
          }),
          { maxLength: 40 },
        ),
        (items) => {
          const asOf = day('2026-06-30');
          const summary = summariseAging(
            asOf,
            items.map((item) => ({
              since: day(
                new Date(Date.parse(`${asOf}T00:00:00Z`) - item.days * 86_400_000)
                  .toISOString()
                  .slice(0, 10),
              ),
              amountPoisha: poisha(item.amount),
            })),
          );
          const buckets = AGING_BUCKETS.reduce((total, bucket) => total + summary[bucket], 0n);
          expect(buckets).toBe(summary.totalPoisha);
        },
      ),
      { numRuns: 150 },
    );
  });
});
