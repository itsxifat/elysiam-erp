import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isE164Phone } from '../orders/phone.js';
import {
  automaticStage,
  chooseStage,
  CONTACT_STAGES,
  extractBdPhones,
  mapWhatsAppStatus,
  MESSENGER_RECEIPT_MAP,
  nextOutboundStatus,
  OUTBOUND_STATUSES,
  phoneFromWhatsAppId,
  phonesAcrossMessages,
  reconcileStage,
  replyWindow,
  stageAfterOrder,
  WHATSAPP_STATUS_MAP,
  type OutboundStatus,
} from './index.js';

const BANGLA = '০১২৩৪৫৬৭৮৯';
const toBangla = (digits: string) => digits.replace(/\d/g, (d) => BANGLA[Number(d)] ?? d);

/** A valid mobile's ten national digits after the trunk zero: `1`, operator, eight more. */
const mobileTail = fc
  .tuple(
    fc.constantFrom('1', '3', '4', '5', '6', '7', '8', '9'),
    fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 8, maxLength: 8 }),
  )
  .map(([operator, rest]) => `1${operator}${rest.join('')}`);

/** One way a person writes a number: the prefix, separators between digit groups, the script. */
const written = fc
  .record({
    tail: mobileTail,
    prefix: fc.constantFrom('0', '+880', '880', '00880', '+8800', '+880 ', '+880-'),
    separator: fc.constantFrom('', ' ', '-', '.'),
    split: fc.integer({ min: 1, max: 7 }),
    bangla: fc.boolean(),
  })
  .map(({ tail, prefix, separator, split, bangla }) => {
    // The two groups a person might separate: `01712 345678` or `+880 1712-345678`.
    const head = tail.slice(0, 2 + split);
    const rest = tail.slice(2 + split);
    const text = `${prefix}${head}${separator}${rest}`;
    return { text: bangla ? toBangla(text) : text, e164: `+880${tail}` };
  });

/** Words around a number: anything but digits and plus signs, so it stands alone. */
const filler = fc
  .string({ maxLength: 20 })
  .map((value) => value.replace(/[\d+০-৯٠-٩０-９＋]/g, ''));

describe('extractBdPhones (M42 check 3, D-739)', () => {
  it('finds a number however it is written, in E.164', () => {
    fc.assert(
      fc.property(written, filler, filler, ({ text, e164 }, before, after) => {
        expect(extractBdPhones(`${before} ${text} ${after}`)).toEqual([e164]);
      }),
      { numRuns: 400 },
    );
  });

  it('finds several, in order, each once', () => {
    fc.assert(
      fc.property(fc.array(written, { minLength: 1, maxLength: 5 }), (numbers) => {
        const text = numbers.map((n) => `call ${n.text} or`).join(' ');
        const expected = [...new Set(numbers.map((n) => n.e164))];
        expect(extractBdPhones(text)).toEqual(expected);
      }),
    );
  });

  it('never throws, and returns only unique E.164 mobiles', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (text) => {
        const found = extractBdPhones(text);
        expect(found.every((phone) => isE164Phone(phone))).toBe(true);
        expect(new Set(found).size).toBe(found.length);
      }),
      { numRuns: 500 },
    );
  });

  it('ignores a number glued inside a longer run of digits', () => {
    fc.assert(
      fc.property(
        mobileTail,
        // 88 and 880 glued in front make a real `880…` number, which is found on purpose.
        fc.integer({ min: 1, max: 999 }).filter((glue) => glue !== 88 && glue !== 880),
        (tail, glue) => {
          expect(extractBdPhones(`order ${String(glue)}0${tail}`)).toEqual([]);
          expect(extractBdPhones(`order 0${tail}${String(glue)}`)).toEqual([]);
        },
      ),
    );
  });

  it('reads worked examples', () => {
    expect(extractBdPhones('amar number 01712-345678, thanks')).toEqual(['+8801712345678']);
    expect(extractBdPhones('০১৮১২৩৪৫৬৭৮ e call korben')).toEqual(['+8801812345678']);
    expect(extractBdPhones('+880 1912 345 678')).toEqual(['+8801912345678']);
    expect(extractBdPhones('whatsapp 8801512345678 / 01512345678')).toEqual(['+8801512345678']);
    // Not mobiles: a landline, an unissued operator digit, ten digits without the zero.
    expect(extractBdPhones('office 02-9611000')).toEqual([]);
    expect(extractBdPhones('01212345678')).toEqual([]);
    expect(extractBdPhones('trx 1712345678')).toEqual([]);
    expect(extractBdPhones('')).toEqual([]);
  });

  it('collects across messages, newest first, with extra candidates last', () => {
    expect(
      phonesAcrossMessages(
        ['now 01812345678', null, 'old 01712345678 and 01812345678'],
        ['+8801912345678', 'not a phone'],
      ),
    ).toEqual(['+8801812345678', '+8801712345678', '+8801912345678']);
  });

  it('reads a WhatsApp id as a phone only when it is a Bangladeshi mobile', () => {
    expect(phoneFromWhatsAppId('8801712345678')).toBe('+8801712345678');
    expect(phoneFromWhatsAppId('16505551234')).toBeNull();
    expect(phoneFromWhatsAppId('abc')).toBeNull();
  });
});

describe('replyWindow (M42 check 2, D-734)', () => {
  const kinds = fc.constantFrom('messenger' as const, 'instagram' as const, 'whatsapp' as const);

  it('is open for exactly 24 hours after the last inbound message', () => {
    fc.assert(
      fc.property(
        kinds,
        fc.integer({ min: 1_600_000_000_000, max: 1_900_000_000_000 }),
        fc.integer({ min: -10_000_000, max: 200_000_000 }),
        (kind, inbound, offset) => {
          const window = replyWindow(kind, new Date(inbound), new Date(inbound + offset));
          const closes = inbound + 24 * 60 * 60 * 1000;
          expect(window.open).toBe(inbound + offset < closes);
          if (window.open) expect(window.closesAt.getTime()).toBe(closes);
          else {
            expect(window.reason).toBe('expired');
            expect(window.closedAt?.getTime()).toBe(closes);
          }
        },
      ),
    );
  });

  it('is closed when the person never wrote', () => {
    expect(replyWindow('whatsapp', null, new Date())).toEqual({
      open: false,
      reason: 'never_wrote',
      closedAt: null,
    });
  });

  it('closes at 24 hours to the millisecond', () => {
    const at = new Date('2026-10-11T10:00:00.000Z');
    expect(replyWindow('messenger', at, new Date('2026-10-12T09:59:59.999Z')).open).toBe(true);
    expect(replyWindow('messenger', at, new Date('2026-10-12T10:00:00.000Z')).open).toBe(false);
  });
});

describe('contact stages (M42 check 3, D-738)', () => {
  const stages = fc.constantFrom(...CONTACT_STAGES);

  it('becomes customer on an order, except fraud, which sticks', () => {
    fc.assert(
      fc.property(stages, (stage) => {
        expect(stageAfterOrder(stage)).toBe(stage === 'fraud' ? 'fraud' : 'customer');
        expect(stageAfterOrder(stageAfterOrder(stage))).toBe(stageAfterOrder(stage));
      }),
    );
  });

  it('never sets customer by hand, and refuses lead once they have ordered', () => {
    expect(chooseStage('lead', { hasOrdered: false })).toEqual({ ok: true, stage: 'lead' });
    expect(chooseStage('lead', { hasOrdered: true })).toEqual({
      ok: false,
      reason: 'already_customer',
    });
    expect(chooseStage('fraud', { hasOrdered: true })).toEqual({ ok: true, stage: 'fraud' });
    expect(chooseStage('not_qualified', { hasOrdered: false })).toEqual({
      ok: true,
      stage: 'not_qualified',
    });
    expect(chooseStage('auto', { hasOrdered: true })).toEqual({ ok: true, stage: 'customer' });
    expect(chooseStage('auto', { hasOrdered: false })).toEqual({ ok: true, stage: 'visitor' });
    expect(automaticStage({ hasOrdered: false })).toBe('visitor');
  });

  it('reconciles a stored stage with what is known', () => {
    fc.assert(
      fc.property(stages, fc.boolean(), (stored, hasOrdered) => {
        const shown = reconcileStage(stored, { hasOrdered });
        if (!hasOrdered) expect(shown).toBe(stored);
        else expect(shown).toBe(stored === 'fraud' ? 'fraud' : 'customer');
      }),
    );
  });
});

describe('delivery status (M42, D-735)', () => {
  const statuses = fc.constantFrom(...OUTBOUND_STATUSES);
  const rank = (status: OutboundStatus) =>
    ({ queued: 0, sent: 1, delivered: 2, read: 3, failed: -1 })[status];

  it('only moves forward, and a repeat changes nothing', () => {
    fc.assert(
      fc.property(statuses, statuses, (current, incoming) => {
        const next = nextOutboundStatus(current, incoming);
        expect(nextOutboundStatus(next, incoming)).toBe(next);
        if (current !== 'failed' && next !== 'failed')
          expect(rank(next)).toBeGreaterThanOrEqual(rank(current));
        if (next === 'failed') expect(['queued', 'sent', 'failed']).toContain(current);
      }),
    );
  });

  it('reaches the same place whatever order non-failure receipts arrive in', () => {
    const receipts = fc.array(fc.constantFrom<OutboundStatus>('sent', 'delivered', 'read'), {
      maxLength: 6,
    });
    fc.assert(
      fc.property(receipts, (list) => {
        const forward = list.reduce<OutboundStatus>(nextOutboundStatus, 'queued');
        const backward = [...list].reverse().reduce<OutboundStatus>(nextOutboundStatus, 'queued');
        expect(forward).toBe(backward);
      }),
    );
  });

  it('keeps delivered when WhatsApp also says failed (several devices)', () => {
    expect(nextOutboundStatus('delivered', 'failed')).toBe('delivered');
    expect(nextOutboundStatus('sent', 'failed')).toBe('failed');
    expect(nextOutboundStatus('failed', 'delivered')).toBe('delivered');
    expect(nextOutboundStatus('failed', 'sent')).toBe('failed');
  });

  it('maps every WhatsApp status and Messenger receipt it lists, and nothing else', () => {
    expect(WHATSAPP_STATUS_MAP).toEqual({
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      played: 'read',
      failed: 'failed',
    });
    for (const [word, status] of Object.entries(WHATSAPP_STATUS_MAP)) {
      expect(mapWhatsAppStatus(word)).toBe(status);
    }
    expect(mapWhatsAppStatus('deleted')).toBeNull();
    expect(mapWhatsAppStatus('toString')).toBeNull();
    expect(MESSENGER_RECEIPT_MAP).toEqual({ delivery: 'delivered', read: 'read' });
  });
});
