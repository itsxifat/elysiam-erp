import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  expectRingBack,
  forgetRingBack,
  lookupAgainIn,
  nationalDigits,
  takeRingBack,
} from './phone-store.js';
import { phoneSocketAllowed } from './widget.js';

/**
 * The console phone's own rules (M47, D-843): which incoming call is the ring-back of the
 * person's own Call (answered at once), when the screen pop asks again, and which SIP sockets
 * this build's policy lets the phone open.
 */

afterEach(() => {
  // Nothing left expected between cases.
  takeRingBack('01712345678', 'Envo call 01712345678');
  takeRingBack('01812345678', 'Envo call 01812345678');
  vi.unstubAllGlobals();
});

describe('the ring-back of a Call', () => {
  it('is the call from that number with Envo’s ring-back name, once', () => {
    expectRingBack('+8801712345678', 'Rumana Akter');
    // The customer calling at that moment carries their own name: a call like any other.
    expect(takeRingBack('01712345678', 'Rumana')).toBeNull();
    expect(takeRingBack('01712345678', '')).toBeNull();
    // Envo's name for another number is not this one.
    expect(takeRingBack('01712345678', 'Envo call 01812345678')).toBeNull();
    expect(takeRingBack('8801712345678', 'Envo call 01712345678')).toBe('Rumana Akter');
    expect(takeRingBack('01712345678', 'Envo call 01712345678')).toBeNull();
  });

  it('is not another number’s, and not after thirty seconds', () => {
    expectRingBack('01712345678', 'Rumana Akter');
    expect(takeRingBack('01812345678', 'Envo call 01812345678')).toBeNull();
    expect(takeRingBack('01712345678', 'Envo call 01712345678', Date.now() + 31_000)).toBeNull();
  });

  it('is forgotten when the server refused the Call, and only for that number', () => {
    expectRingBack('01712345678', 'Rumana Akter');
    forgetRingBack('01812345678');
    forgetRingBack('+8801712345678');
    expect(takeRingBack('01712345678', 'Envo call 01712345678')).toBeNull();
  });

  it('reads any spelling of a Bangladeshi mobile as its national digits', () => {
    expect(nationalDigits('+8801712345678')).toBe('01712345678');
    expect(nationalDigits('8801712345678')).toBe('01712345678');
    expect(nationalDigits('1712345678')).toBe('01712345678');
    expect(nationalDigits('01712345678')).toBe('01712345678');
  });
});

describe('the screen pop asking again', () => {
  const at = 1_000_000;
  it('asks every two seconds for a ringing card that names nobody, for its first twelve', () => {
    const ringing = { kind: 'incoming', at };
    expect(lookupAgainIn(ringing, null, at + 1_000)).toBe(2_000);
    expect(lookupAgainIn(ringing, null, at + 11_000)).toBe(2_000);
    expect(lookupAgainIn(ringing, null, at + 12_000)).toBe(false);
  });

  it('stops once it names someone, and never asks for another card', () => {
    expect(lookupAgainIn({ kind: 'incoming', at }, { id: 'c' }, at)).toBe(false);
    expect(lookupAgainIn({ kind: 'ringBack', at }, null, at)).toBe(false);
    expect(lookupAgainIn({ kind: 'active' }, null, at)).toBe(false);
    expect(lookupAgainIn(null, null, at)).toBe(false);
  });
});

describe('the phone’s SIP socket', () => {
  it('is allowed anywhere by a build that names no sockets (a test or a local build)', () => {
    expect(phoneSocketAllowed('call.enfinito.cloud')).toBe(true);
    expect(phoneSocketAllowed(null)).toBe(true);
  });

  it('is allowed only on the hosts the build’s policy names', () => {
    vi.stubGlobal('__TELEPHONY_SOCKETS__', ['wss://call.enfinito.cloud']);
    expect(phoneSocketAllowed('call.enfinito.cloud')).toBe(true);
    expect(phoneSocketAllowed('CALL.Enfinito.Cloud')).toBe(true);
    expect(phoneSocketAllowed('envo.enfinito.cloud')).toBe(false);
    expect(phoneSocketAllowed('call.enfinito.cloud.evil.example')).toBe(false);
    // Envo named no SIP domain: the phone tries, and says what happened.
    expect(phoneSocketAllowed(null)).toBe(true);
  });
});
