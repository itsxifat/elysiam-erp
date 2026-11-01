import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  LOT_COUNT_MAX,
  handoverComplete,
  handoverMissing,
  judgeConfirmLots,
  judgeHandoverScan,
  judgeLotClose,
  judgeLotCount,
  judgeLotFinish,
  lotCode,
  lotCountLimit,
  openLot,
  parseLotCode,
  piecesByLot,
} from './index.js';
import { ordersPerHour, pickTerminal, printJobAfter, printSummary } from './index.js';

/**
 * M46's lot rules (D-805 to D-808) and the print queue's (D-813 to D-819), as properties: a lot
 * code reads back to its order and lot; whatever a packer does, Finish is allowed only when every
 * lot is closed with a piece in it; the handover lets an order go only when every lot was
 * scanned, in any order and with repeats; the queue's terminal is online when one is and has the
 * shortest queue.
 */

const orderNo = fc
  .tuple(
    fc.stringMatching(/^[A-Z][A-Z0-9]{1,5}$/),
    fc.stringMatching(/^\d{4}$/),
    fc.integer({ min: 1, max: 9_999_999 }),
  )
  .map(([prefix, period, seq]) => `${prefix}-${period}-${String(seq).padStart(5, '0')}`);

describe('lot codes (D-806)', () => {
  it('read back to exactly the order and lot they were made from', () => {
    fc.assert(
      fc.property(orderNo, fc.integer({ min: 1, max: LOT_COUNT_MAX }), (order, lot) => {
        expect(parseLotCode(lotCode(order, lot))).toEqual({ orderCode: order, lot });
      }),
    );
  });

  it('never read an order number, a consignment or a stranger as a lot', () => {
    fc.assert(
      fc.property(orderNo, (order) => {
        expect(parseLotCode(order)).toBeNull();
      }),
    );
    expect(parseLotCode('SFC123456')).toBeNull();
    expect(parseLotCode('ELY-2610-00042-L0')).toBeNull();
    expect(parseLotCode('ELY-2610-00042-L21')).toBeNull();
    expect(parseLotCode('-L2')).toBeNull();
    expect(parseLotCode(' ELY-2610-00042-l3 ')).toEqual({ orderCode: 'ELY-2610-00042', lot: 3 });
  });

  it('refuses a lot outside 1 to 20', () => {
    expect(() => lotCode('ELY-2610-00001', 0)).toThrow(RangeError);
    expect(() => lotCode('ELY-2610-00001', 21)).toThrow(RangeError);
  });
});

describe('the lot count (D-805)', () => {
  it('changes only while confirmed, never below the closed lots nor past what the pieces fill', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2, max: 25 }),
        fc.constantFrom('pending', 'confirmed', 'packed', 'shipped', 'delivered', 'cancelled'),
        fc.integer({ min: 0, max: 20 }),
        fc.integer({ min: 1, max: 40 }),
        fc.integer({ min: 0, max: 40 }),
        (count, orderStatus, closedLots, pieces, sealed) => {
          const piecesInClosedLots = Math.min(sealed, pieces);
          const verdict = judgeLotCount({
            count,
            orderStatus,
            closedLots,
            pieces,
            piecesInClosedLots,
          });
          if (verdict !== 'ok') return;
          expect(count).toBeGreaterThanOrEqual(1);
          expect(count).toBeLessThanOrEqual(LOT_COUNT_MAX);
          // Fixed once packed (D-944).
          expect(orderStatus).toBe('confirmed');
          // Packing leaves a lot open.
          if (closedLots > 0) expect(count).toBeGreaterThan(closedLots);
          // Every lot still to fill gets a piece of its own (D-943).
          expect(count - closedLots).toBeLessThanOrEqual(Math.max(pieces - piecesInClosedLots, 1));
        },
      ),
    );
    const judged = { closedLots: 0, pieces: 9, piecesInClosedLots: 0 };
    expect(judgeLotCount({ ...judged, count: 3, orderStatus: 'shipped' })).toBe('not_open');
    expect(judgeLotCount({ ...judged, count: 3, orderStatus: 'packed' })).toBe('not_open');
    expect(judgeLotCount({ ...judged, count: 1, orderStatus: 'packed' })).toBe('not_open');
    expect(judgeLotCount({ ...judged, count: 3, orderStatus: 'confirmed' })).toBe('ok');
    const packing = { ...judged, orderStatus: 'confirmed', closedLots: 2, piecesInClosedLots: 2 };
    expect(judgeLotCount({ ...packing, count: 1 })).toBe('below_closed');
    expect(judgeLotCount({ ...packing, count: 2 })).toBe('below_closed');
    expect(judgeLotCount({ ...packing, count: 3 })).toBe('ok');
  });
});

describe('who says how many lots (M52, D-941, D-943)', () => {
  it('asks only above the limit, and never with no limit', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 600 }),
        fc.option(fc.integer({ min: 1, max: 500 }), { nil: null }),
        (pieces, askAbovePieces) => {
          const verdict = judgeConfirmLots({ pieces, askAbovePieces, lots: undefined });
          const above = askAbovePieces !== null && pieces > askAbovePieces;
          expect(verdict).toBe(above ? 'ask' : 'one_lot');
        },
      ),
    );
    expect(judgeConfirmLots({ pieces: 5, askAbovePieces: 5, lots: undefined })).toBe('one_lot');
    expect(judgeConfirmLots({ pieces: 6, askAbovePieces: 5, lots: undefined })).toBe('ask');
  });

  it('takes an answer only if it could be packed, at any size', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60 }),
        fc.integer({ min: -2, max: 30 }),
        fc.option(fc.integer({ min: 1, max: 500 }), { nil: null }),
        (pieces, lots, askAbovePieces) => {
          const verdict = judgeConfirmLots({ pieces, askAbovePieces, lots });
          const fits = lots >= 1 && lots <= Math.min(pieces, LOT_COUNT_MAX);
          expect(verdict).toBe(fits ? 'answered' : 'out_of_range');
        },
      ),
    );
  });

  it('never lets a count outgrow the pieces, whoever sets it', () => {
    expect(lotCountLimit(3)).toBe(3);
    expect(lotCountLimit(0)).toBe(1);
    expect(lotCountLimit(90)).toBe(LOT_COUNT_MAX);
    const count = { orderStatus: 'confirmed', closedLots: 0, piecesInClosedLots: 0 };
    expect(judgeLotCount({ ...count, count: 3, pieces: 3 })).toBe('ok');
    expect(judgeLotCount({ ...count, count: 4, pieces: 3 })).toBe('more_than_pieces');
  });

  it('counts only the pieces left once a bag is sealed', () => {
    // Four pieces with three sealed in lot 1: one piece is left, so one lot more at most.
    expect(lotCountLimit(4, { lots: 1, pieces: 3 })).toBe(2);
    const sealed = { orderStatus: 'confirmed', closedLots: 1, pieces: 4, piecesInClosedLots: 3 };
    expect(judgeLotCount({ ...sealed, count: 2 })).toBe('ok');
    expect(judgeLotCount({ ...sealed, count: 3 })).toBe('more_than_pieces');
  });
});

/** One thing a packer does at the station. */
type Act = { kind: 'scan' } | { kind: 'remove' } | { kind: 'close' } | { kind: 'finish' };

describe('packing by lot (D-807)', () => {
  it('finishes only with every lot closed, each holding a piece, and every piece in', () => {
    const act: fc.Arbitrary<Act> = fc.oneof(
      fc.constant<Act>({ kind: 'scan' }),
      fc.constant<Act>({ kind: 'remove' }),
      fc.constant<Act>({ kind: 'close' }),
      fc.constant<Act>({ kind: 'finish' }),
    );
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 6 }),
        fc.integer({ min: 1, max: 12 }),
        fc.array(act, { maxLength: 60 }),
        (lotCount, unitsRequired, acts) => {
          const scans: { lot: number; outcome: string }[] = [];
          let closed = 0;
          let finished = false;
          for (const step of acts) {
            if (finished) break;
            const lot = openLot(lotCount, closed);
            if (lot === null) break;
            const pieces = piecesByLot(scans);
            const packed = [...pieces.values()].reduce((sum, value) => sum + value, 0);
            const inLot = pieces.get(lot) ?? 0;
            if (step.kind === 'scan' && packed < unitsRequired) {
              scans.push({ lot, outcome: 'accepted' });
            } else if (step.kind === 'remove' && inLot > 0) {
              scans.push({ lot, outcome: 'removed' });
            } else if (step.kind === 'close') {
              const verdict = judgeLotClose({
                lotCount,
                closedLots: closed,
                piecesInLot: inLot,
                unitsRequired,
                unitsPacked: packed,
              });
              if (verdict === 'ok') closed += 1;
            } else if (step.kind === 'finish') {
              const lotRule = judgeLotFinish({ lotCount, closedLots: closed, piecesInLot: inLot });
              // M38b's own rule: every piece of the order in the box.
              if (lotRule === 'ok' && packed === unitsRequired) {
                closed += 1;
                finished = true;
              }
            }
          }
          if (!finished) return;
          const pieces = piecesByLot(scans);
          expect(closed).toBe(lotCount);
          for (let lot = 1; lot <= lotCount; lot += 1) {
            expect(pieces.get(lot) ?? 0).toBeGreaterThanOrEqual(1);
          }
          expect([...pieces.values()].reduce((sum, value) => sum + value, 0)).toBe(unitsRequired);
        },
      ),
    );
  });

  it('never closes a lot that would leave a later lot with nothing to hold', () => {
    expect(
      judgeLotClose({
        lotCount: 3,
        closedLots: 0,
        piecesInLot: 2,
        unitsRequired: 3,
        unitsPacked: 2,
      }),
    ).toBe('too_few_left');
    expect(
      judgeLotClose({
        lotCount: 3,
        closedLots: 0,
        piecesInLot: 1,
        unitsRequired: 3,
        unitsPacked: 1,
      }),
    ).toBe('ok');
    expect(
      judgeLotClose({
        lotCount: 3,
        closedLots: 0,
        piecesInLot: 0,
        unitsRequired: 3,
        unitsPacked: 0,
      }),
    ).toBe('empty');
    expect(
      judgeLotClose({
        lotCount: 3,
        closedLots: 2,
        piecesInLot: 1,
        unitsRequired: 3,
        unitsPacked: 3,
      }),
    ).toBe('last_lot');
    expect(judgeLotFinish({ lotCount: 3, closedLots: 1, piecesInLot: 1 })).toBe('lots_open');
    expect(judgeLotFinish({ lotCount: 1, closedLots: 0, piecesInLot: 0 })).toBe('ok');
  });
});

describe('the handover (D-808)', () => {
  it('lets the order go exactly when every lot was scanned, in any order, repeats included', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: LOT_COUNT_MAX }),
        fc.array(fc.integer({ min: 0, max: 22 }), { maxLength: 60 }),
        (lotCount, codes) => {
          const scanned = new Set<number>();
          for (const lot of codes) {
            const outcome = judgeHandoverScan({ lotCount, scanned, lot });
            if (outcome === 'accepted') scanned.add(lot);
            if (outcome === 'already') expect(scanned.has(lot)).toBe(true);
            if (outcome === 'no_such_lot') expect(lot < 1 || lot > lotCount).toBe(true);
          }
          const every = Array.from({ length: lotCount }, (_, index) => index + 1).every((lot) =>
            scanned.has(lot),
          );
          expect(handoverComplete({ lotCount, scanned })).toBe(every);
          expect(handoverMissing({ lotCount, scanned }).every((lot) => !scanned.has(lot))).toBe(
            true,
          );
        },
      ),
    );
  });
});

describe('the print queue (D-813, D-817, D-818)', () => {
  const candidate = fc.record({
    id: fc.uuid(),
    name: fc.stringMatching(/^Label [1-9]$/),
    online: fc.boolean(),
    queued: fc.integer({ min: 0, max: 30 }),
  });

  it('picks an online terminal when there is one, with the shortest queue among them', () => {
    fc.assert(
      fc.property(fc.array(candidate, { maxLength: 8 }), (candidates) => {
        const chosen = pickTerminal(candidates);
        if (candidates.length === 0) {
          expect(chosen).toBeNull();
          return;
        }
        expect(chosen).not.toBeNull();
        const anyOnline = candidates.some((one) => one.online);
        if (anyOnline) expect(chosen?.online).toBe(true);
        const pool = anyOnline ? candidates.filter((one) => one.online) : candidates;
        expect(chosen?.queued).toBe(Math.min(...pool.map((one) => one.queued)));
        // The same answer whatever order the candidates arrive in.
        expect(pickTerminal([...candidates].reverse())?.id).toBe(chosen?.id);
      }),
    );
  });

  it('moves a job only along queued, sending, printed or failed, and back to queued to retry', () => {
    expect(printJobAfter('queued', 'send')).toBe('sending');
    expect(printJobAfter('sending', 'printed')).toBe('printed');
    expect(printJobAfter('sending', 'requeue')).toBe('queued');
    expect(printJobAfter('failed', 'retry')).toBe('queued');
    expect(printJobAfter('printed', 'send')).toBeNull();
    expect(printJobAfter('printed', 'cancel')).toBeNull();
    expect(printJobAfter('cancelled', 'retry')).toBeNull();
    expect(printJobAfter('queued', 'cancel')).toBe('cancelled');
  });

  it('counts the printed jobs only and names the newest', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 17, 8, minute));
    const summary = printSummary([
      { state: 'printed', at: at(1), byName: null, auto: true, terminalName: 'Label 1' },
      { state: 'failed', at: at(5), byName: 'Rahim', auto: false, terminalName: 'Label 1' },
      { state: 'printed', at: at(9), byName: 'Rahim', auto: false, terminalName: 'Label 2' },
      { state: 'queued', at: at(12), byName: 'Rahim', auto: false, terminalName: 'Label 2' },
    ]);
    expect(summary.count).toBe(2);
    expect(summary.last).toMatchObject({ byName: 'Rahim', terminalName: 'Label 2' });
  });

  it('works out orders per hour from Dhaka midnight, at least one hour', () => {
    const since = new Date('2026-10-16T18:00:00Z');
    expect(ordersPerHour({ completed: 6, since, now: new Date('2026-10-16T18:30:00Z') })).toBe(6);
    expect(ordersPerHour({ completed: 9, since, now: new Date('2026-10-17T00:00:00Z') })).toBe(1.5);
  });
});
