import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { CALL_OUTCOMES } from '../orders/ownership.js';
import {
  ATTEMPT_NOTE_MAX,
  CALL_BUTTON_TALK_PROVES_ANSWER_SECONDS,
  PHONE_CALL_DIRECTIONS,
  PHONE_CALL_DISPOSITIONS,
  PHONE_CALL_STATUSES,
  attemptNoteOf,
  suggestWrapUp,
  wrapUpAsked,
  wrapUpInputProblem,
  wrapUpNoteOf,
  wrapUpRefusal,
  type WrapUpCallFacts,
} from './index.js';

/**
 * D-859's rules: which calls ask for a wrap-up, what the ERP suggests from what Envo's data
 * really says (a Call button call's `answered` and talk time are the person's own leg), who may
 * write one, and what a wrap-up must carry.
 */

const ended: WrapUpCallFacts = {
  status: 'ended',
  direction: 'outbound',
  callButton: false,
  answered: false,
  disposition: null,
  talkSeconds: null,
  errorCode: null,
  hasRecording: false,
};

const facts = fc.record({
  status: fc.constantFrom(...PHONE_CALL_STATUSES),
  direction: fc.constantFrom(...PHONE_CALL_DIRECTIONS),
  callButton: fc.boolean(),
  answered: fc.boolean(),
  disposition: fc.option(fc.constantFrom(...PHONE_CALL_DISPOSITIONS), { nil: null }),
  talkSeconds: fc.option(fc.nat({ max: 7200 }), { nil: null }),
  errorCode: fc.option(fc.constantFrom('envo_refused', 'envo_unreachable', 'not_connected'), {
    nil: null,
  }),
  hasRecording: fc.boolean(),
});

describe('which calls ask for a wrap-up', () => {
  it('asks only of a call that is over and rang a customer', () => {
    expect(wrapUpAsked(ended)).toBe(true);
    expect(wrapUpAsked({ ...ended, status: 'answered' })).toBe(false);
    expect(wrapUpAsked({ ...ended, status: 'failed', errorCode: 'envo_refused' })).toBe(false);
    expect(wrapUpAsked({ ...ended, callButton: true, errorCode: 'not_connected' })).toBe(false);
    expect(wrapUpAsked({ ...ended, direction: 'internal' })).toBe(false);
  });

  it('does not ask of a Call button call whose ring-back the person never picked up', () => {
    // Envo dials the customer only once the person's own leg answers (`[envo-cc]`).
    expect(wrapUpAsked({ ...ended, callButton: true, answered: false })).toBe(false);
    expect(wrapUpAsked({ ...ended, callButton: true, answered: true })).toBe(true);
  });
});

describe('the suggested result', () => {
  it('never suggests for a call that does not ask, and only one of the five', () => {
    fc.assert(
      fc.property(facts, (call) => {
        const suggested = suggestWrapUp(call);
        if (!wrapUpAsked(call)) expect(suggested).toBeNull();
        if (suggested !== null) expect(CALL_OUTCOMES).toContain(suggested);
      }),
    );
  });

  it('reads a Call button call’s answer and talk time as the person’s own leg', () => {
    const click = { ...ended, callButton: true, answered: true, disposition: 'answered' as const };
    // Answered and talked a minute: the customer may have rung unanswered all that time.
    expect(suggestWrapUp({ ...click, talkSeconds: 60 })).toBeNull();
    expect(suggestWrapUp({ ...click, talkSeconds: CALL_BUTTON_TALK_PROVES_ANSWER_SECONDS })).toBe(
      null,
    );
    // Longer than the customer's leg could ring: they picked up.
    expect(
      suggestWrapUp({ ...click, talkSeconds: CALL_BUTTON_TALK_PROVES_ANSWER_SECONDS + 1 }),
    ).toBe('reached');
    // A recording has audio only once the customer's leg was bridged.
    expect(suggestWrapUp({ ...click, talkSeconds: 20, hasRecording: true })).toBe('reached');
    // Envo's grouped disposition hides the customer's busy: no suggestion.
    expect(suggestWrapUp({ ...click, disposition: 'busy', talkSeconds: 4 })).toBeNull();
  });

  it('takes a call dialled on the person’s own phone at Envo’s word', () => {
    expect(suggestWrapUp({ ...ended, answered: true, disposition: 'answered' })).toBe('reached');
    expect(suggestWrapUp({ ...ended, disposition: 'busy' })).toBe('busy');
    expect(suggestWrapUp({ ...ended, disposition: 'no_answer' })).toBe('no_answer');
    expect(suggestWrapUp({ ...ended, disposition: 'failed' })).toBeNull();
    expect(suggestWrapUp({ ...ended, disposition: 'congestion' })).toBeNull();
    expect(suggestWrapUp({ ...ended, disposition: null })).toBeNull();
  });

  it('suggests reached for an inbound call the person answered, nothing for one they missed', () => {
    const inbound = { ...ended, direction: 'inbound' as const };
    expect(suggestWrapUp({ ...inbound, answered: true, disposition: 'answered' })).toBe('reached');
    expect(suggestWrapUp({ ...inbound, disposition: 'no_answer' })).toBeNull();
  });

  it('does not guess for a call whose direction Envo never said', () => {
    expect(suggestWrapUp({ ...ended, direction: 'unknown', answered: true })).toBeNull();
  });
});

describe('who may wrap up', () => {
  const mine = { ...ended, answered: true, personId: 'u1', wrappedUp: false };

  it('is the person on the call, once, after it ended', () => {
    expect(wrapUpRefusal(mine, 'u1')).toBeNull();
    expect(wrapUpRefusal(mine, 'u2')).toBe('not_yours');
    expect(wrapUpRefusal({ ...mine, personId: null }, 'u1')).toBe('not_yours');
    expect(wrapUpRefusal({ ...mine, wrappedUp: true }, 'u1')).toBe('wrapped_up');
    expect(wrapUpRefusal({ ...mine, status: 'answered' }, 'u1')).toBe('not_over');
    expect(wrapUpRefusal({ ...mine, errorCode: 'not_connected' }, 'u1')).toBe('not_asked');
  });
});

describe('what a wrap-up carries', () => {
  const now = new Date('2026-10-19T10:00:00Z');

  it('needs a note for reached and call_back, and M41’s call-back time', () => {
    expect(wrapUpInputProblem({ result: 'no_answer', note: null, callBackAt: null, now })).toBe(
      null,
    );
    expect(
      wrapUpInputProblem({ result: 'reached', note: ' x ', callBackAt: null, now }),
    ).not.toBeNull();
    expect(
      wrapUpInputProblem({ result: 'reached', note: 'Confirmed size M', callBackAt: null, now }),
    ).toBeNull();
    expect(
      wrapUpInputProblem({ result: 'call_back', note: 'After Friday', callBackAt: null, now }),
    ).toBe('Say when to call back.');
    expect(
      wrapUpInputProblem({
        result: 'call_back',
        note: 'After Friday',
        callBackAt: new Date('2026-10-20T10:00:00Z'),
        now,
      }),
    ).toBeNull();
    expect(
      wrapUpInputProblem({
        result: 'busy',
        note: null,
        callBackAt: new Date('2026-10-20T10:00:00Z'),
        now,
      }),
    ).toBe('Only a call-back has a time to call again.');
    expect(
      wrapUpInputProblem({ result: 'reached', note: 'x'.repeat(1001), callBackAt: null, now }),
    ).toBe('Keep the note to 1,000 characters.');
  });

  it('keeps a trimmed note, and M41’s attempt its first 500 characters', () => {
    expect(wrapUpNoteOf('  ')).toBeNull();
    expect(wrapUpNoteOf(' Paid ')).toBe('Paid');
    expect(attemptNoteOf(undefined)).toBeUndefined();
    expect(attemptNoteOf('Paid')).toBe('Paid');
    const long = attemptNoteOf('y'.repeat(1000));
    expect(long).toHaveLength(ATTEMPT_NOTE_MAX);
    expect(long?.endsWith('…')).toBe(true);
  });
});
