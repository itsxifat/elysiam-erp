import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CLICK_TO_CALL_MATCH_MS,
  ENVO_DISPOSITIONS,
  PHONE_CALL_STATUSES,
  answeredAfter,
  customerPhoneFrom,
  customerSide,
  dispositionFromEnvo,
  envoBaseUrl,
  envoDialNumber,
  isPhoneCallOver,
  matchClick,
  parseEnvoCall,
  parseEnvoSignature,
  phoneCallStatusAfter,
  recordingExpired,
  recordingIdFrom,
  signatureFresh,
  storedNumber,
  talkTime,
  type PhoneCallStatus,
} from './index.js';

/**
 * M47's rules (D-830 to D-842): Envo's payloads, the numbers, a call's statuses over any order of
 * events, linking a call to its click, the base URL and the recording link.
 */

const nationalMobile = fc
  .tuple(fc.constantFrom('3', '4', '5', '6', '7', '8', '9'), fc.stringMatching(/^\d{8}$/))
  .map(([operator, rest]) => `01${operator}${rest}`);

const EVENTS = ['call.started', 'call.answered', 'call.ended', 'sync'] as const;

describe('numbers (D-833)', () => {
  it('dials the national eleven digits Envo routes, from any way the ERP wrote the phone', () => {
    fc.assert(
      fc.property(nationalMobile, (national) => {
        const e164 = `+880${national.slice(1)}`;
        expect(envoDialNumber(e164)).toBe(national);
        expect(envoDialNumber(national)).toBe(national);
        expect(envoDialNumber(`880${national.slice(1)}`)).toBe(national);
      }),
    );
  });

  it('reads a caller in every form Envo may send back to the same customer', () => {
    fc.assert(
      fc.property(nationalMobile, (national) => {
        const e164 = `+880${national.slice(1)}`;
        for (const form of [national, `880${national.slice(1)}`, e164]) {
          expect(customerPhoneFrom(form)).toBe(e164);
          expect(storedNumber(form)).toBe(e164);
        }
      }),
    );
  });

  it('keeps an extension, a landline or a short code as sent, and drops anything else', () => {
    expect(storedNumber('101')).toBe('101');
    expect(storedNumber('09644342036')).toBe('09644342036');
    expect(storedNumber('*97')).toBe('*97');
    expect(storedNumber('anonymous')).toBeNull();
    expect(storedNumber('')).toBeNull();
    expect(customerPhoneFrom('101')).toBeNull();
  });

  it('takes the customer from the right side of the call', () => {
    const mobile = '01712345678';
    const e164 = '+8801712345678';
    expect(customerSide({ direction: 'inbound', from: mobile, to: '09644342036' })).toBe(e164);
    expect(customerSide({ direction: 'outbound', from: '101', to: mobile })).toBe(e164);
    expect(customerSide({ direction: 'internal', from: '101', to: '102' })).toBeNull();
    expect(customerSide({ direction: 'unknown', from: '101', to: mobile })).toBe(e164);
  });
});

describe('dispositions, one test per entry of the table', () => {
  for (const [envo, ours] of Object.entries(ENVO_DISPOSITIONS)) {
    it(`"${envo}" is ${ours}`, () => {
      expect(dispositionFromEnvo(envo)).toBe(ours);
      expect(dispositionFromEnvo(envo.toUpperCase())).toBe(ours);
    });
  }
  it('anything else is unknown, and nothing is nothing', () => {
    expect(dispositionFromEnvo('weird')).toBe('unknown');
    expect(dispositionFromEnvo(null)).toBeNull();
    expect(dispositionFromEnvo('')).toBeNull();
  });
});

describe('a call over any order of events (D-837)', () => {
  it('ends furthest along, never leaves ended or failed, and stays answered once answered', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<PhoneCallStatus | null>(null, 'requested', 'dialing'),
        fc.array(
          fc.record({
            event: fc.constantFrom(...EVENTS),
            answered: fc.option(fc.boolean(), { nil: null }),
          }),
          { maxLength: 8 },
        ),
        (start, events) => {
          let status = start;
          let answered = false;
          let wasAnswered = false;
          for (const step of events) {
            const before = status;
            status = phoneCallStatusAfter(status, step.event);
            if (before !== null && isPhoneCallOver(before)) expect(status).toBe(before);
            const next = answeredAfter(answered, step);
            if (answered) expect(next).toBe(true);
            answered = next;
            wasAnswered ||= step.event === 'call.answered' || step.answered === true;
          }
          expect(answered).toBe(wasAnswered);
          const ended = events.some((step) => step.event === 'call.ended' || step.event === 'sync');
          if (ended) expect(status).toBe('ended');
          if (status !== null) expect(PHONE_CALL_STATUSES).toContain(status);
        },
      ),
    );
  });

  it('keeps a refused click failed whatever arrives', () => {
    for (const event of EVENTS) expect(phoneCallStatusAfter('failed', event)).toBe('failed');
  });
});

describe('linking a call to its click (D-835)', () => {
  const now = new Date('2026-10-18T10:00:00Z');
  const click = (id: string, extension: string, national: string, secondsAgo: number) => ({
    id,
    extension,
    toE164: `+880${national.slice(1)}`,
    requestedAt: new Date(now.getTime() - secondsAgo * 1000),
  });

  it('takes the newest click whose extension or number is on the call, within three minutes', () => {
    const pending = [
      click('old', '101', '01712345678', 200),
      click('a', '101', '01712345678', 30),
      click('b', '101', '01712345678', 5),
      click('other', '102', '01812345678', 1),
    ];
    expect(matchClick(pending, { from: '101', to: null, direction: 'unknown' }, now)?.id).toBe('b');
    expect(
      matchClick(pending, { from: null, to: '01812345678', direction: 'outbound' }, now)?.id,
    ).toBe('other');
    expect(
      matchClick(pending, { from: '8801712345678', to: '9', direction: 'unknown' }, now)?.id,
    ).toBe('b');
  });

  it('never links an inbound call, a stranger, or a click older than the window', () => {
    const pending = [click('a', '101', '01712345678', CLICK_TO_CALL_MATCH_MS / 1000 + 1)];
    expect(matchClick(pending, { from: '101', to: null, direction: 'outbound' }, now)).toBeNull();
    const fresh = [click('a', '101', '01712345678', 10)];
    expect(matchClick(fresh, { from: '01712345678', to: '09', direction: 'inbound' }, now)).toBeNull();
    expect(matchClick(fresh, { from: '103', to: '01912345678', direction: 'outbound' }, now)).toBeNull();
  });
});

describe("Envo's payloads", () => {
  it('reads the call.ended example from Envo’s Developers page', () => {
    const facts = parseEnvoCall({
      event: 'call.ended',
      id: '1789455634.59',
      sipServer: { id: 1, name: 'Main', slug: 'main' },
      direction: 'inbound',
      from: '01712345678',
      to: '09644342036',
      answered: true,
      talkSec: 38,
      recordingUrl: 'https://envo.enfinito.cloud/api/v1/recordings/42',
    });
    expect(facts).toMatchObject({
      event: 'call.ended',
      callId: '1789455634.59',
      sipServerId: 1,
      direction: 'inbound',
      answered: true,
      talkSeconds: 38,
      test: false,
    });
  });

  it('reads a call-history row as a sync, marks Envo’s test delivery, and refuses junk', () => {
    expect(parseEnvoCall({ id: '1.2', startedAt: '2026-10-18T09:00:00Z' }, 'sync')?.event).toBe(
      'sync',
    );
    expect(parseEnvoCall({ event: 'call.ended', id: '1789.1', test: true })?.test).toBe(true);
    expect(parseEnvoCall({ event: 'call.ended', id: "1'; drop" })).toBeNull();
    expect(parseEnvoCall({ event: 'call.parked', id: '1.1' })).toBeNull();
    expect(parseEnvoCall({ id: '1.1' })).toBeNull();
    expect(parseEnvoCall(null)).toBeNull();
  });
});

describe('the signature header (D-832)', () => {
  it('reads t and v1, and refuses anything else', () => {
    const hex = 'a'.repeat(64);
    expect(parseEnvoSignature(`t=1789455634,v1=${hex}`)).toEqual({
      timestamp: 1789455634,
      signatures: [hex],
    });
    expect(parseEnvoSignature(`v1=${hex}`)).toBeNull();
    expect(parseEnvoSignature('t=1789455634')).toBeNull();
    expect(parseEnvoSignature(`t=abc,v1=${hex}`)).toBeNull();
    expect(parseEnvoSignature(undefined)).toBeNull();
  });

  it('accepts five minutes either way and nothing past it', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2_000_000_000 }), fc.integer({ min: -900, max: 900 }), (t, skew) => {
        expect(signatureFresh(t, t + skew)).toBe(Math.abs(skew) <= 300);
      }),
    );
  });
});

describe('the base URL and the recording link (D-830, D-840)', () => {
  it('keeps an https origin and refuses everything that could reach somewhere else', () => {
    expect(envoBaseUrl('https://envo.enfinito.cloud/')).toEqual({
      ok: true,
      origin: 'https://envo.enfinito.cloud',
    });
    expect(envoBaseUrl('http://envo.enfinito.cloud')).toEqual({ ok: false, problem: 'not_https' });
    expect(envoBaseUrl('https://envo.enfinito.cloud/api')).toMatchObject({ ok: false });
    expect(envoBaseUrl('https://user:pw@envo.enfinito.cloud')).toMatchObject({ ok: false });
    for (const host of ['https://127.0.0.1', 'https://localhost', 'https://[::1]', 'https://db.internal']) {
      expect(envoBaseUrl(host), host).toEqual({ ok: false, problem: 'host_refused' });
    }
    expect(envoBaseUrl('http://127.0.0.1:4555', { allowPlainHttp: true })).toEqual({
      ok: true,
      origin: 'http://127.0.0.1:4555',
    });
  });

  it('fetches a recording only from the connection’s own origin and Envo’s path', () => {
    const base = 'https://envo.enfinito.cloud';
    expect(recordingIdFrom(`${base}/api/v1/recordings/42`, base)).toBe('42');
    expect(recordingIdFrom('https://evil.example/api/v1/recordings/42', base)).toBeNull();
    expect(recordingIdFrom(`${base}/api/v1/recordings/42/../../x`, base)).toBeNull();
    expect(recordingIdFrom(`${base}/api/v1/calls`, base)).toBeNull();
    expect(recordingIdFrom(`https://envo.enfinito.cloud:8443/api/v1/recordings/42`, base)).toBeNull();
    expect(recordingIdFrom(42, base)).toBeNull();
  });

  it('expires a recording past its retention, and writes talk time plainly', () => {
    const ended = new Date('2025-10-18T00:00:00Z');
    expect(recordingExpired(ended, 365, new Date('2026-10-18T00:00:01Z'))).toBe(true);
    expect(recordingExpired(ended, 365, new Date('2026-10-17T00:00:00Z'))).toBe(false);
    expect(talkTime(38)).toBe('0:38');
    expect(talkTime(725)).toBe('12:05');
    expect(talkTime(3729)).toBe('1:02:09');
  });
});
