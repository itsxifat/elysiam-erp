import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  CALL_BACK_MAX_DAYS,
  assignmentDecision,
  callAttemptProblem,
  canHoldOrder,
  hubStageOf,
  isSupervisor,
  ownershipVerdict,
} from './ownership.js';

/**
 * M41's ownership rules (D-710 to D-712): one person handles an order, anybody else must
 * acknowledge them, and only the owner or a supervisor moves an order on.
 */

describe('ownershipVerdict', () => {
  it('is free for nobody’s order and for the owner, and refuses anyone else without the acknowledgement', () => {
    expect(ownershipVerdict({ ownerId: null, callerId: 'a', acknowledged: false })).toEqual({
      kind: 'free',
    });
    expect(ownershipVerdict({ ownerId: 'a', callerId: 'a', acknowledged: false })).toEqual({
      kind: 'free',
    });
    expect(ownershipVerdict({ ownerId: 'a', callerId: 'b', acknowledged: false })).toEqual({
      kind: 'refused',
      ownerId: 'a',
    });
    expect(ownershipVerdict({ ownerId: 'a', callerId: 'b', acknowledged: true })).toEqual({
      kind: 'acknowledged',
      ownerId: 'a',
    });
  });

  it('never lets a non-owner through without acknowledging, whoever they are', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }),
        fc.string({ minLength: 1 }),
        fc.boolean(),
        (owner, caller, ack) => {
          const verdict = ownershipVerdict({ ownerId: owner, callerId: caller, acknowledged: ack });
          if (owner === caller) expect(verdict.kind).toBe('free');
          else expect(verdict.kind).toBe(ack ? 'acknowledged' : 'refused');
        },
      ),
    );
  });
});

describe('assignmentDecision', () => {
  const decide = (
    ownerId: string | null,
    callerId: string,
    target: string | null,
    supervisor = false,
  ) => assignmentDecision({ ownerId, callerId, target, supervisor });

  it('lets anyone take a queued order for themselves, and only a supervisor route it to someone else', () => {
    expect(decide(null, 'a', 'a')).toEqual({ allowed: true, change: 'take' });
    expect(decide(null, 'a', 'b')).toEqual({ allowed: false, reason: 'not_owner' });
    expect(decide(null, 'a', 'b', true)).toEqual({ allowed: true, change: 'reassign' });
    expect(decide(null, 'a', null)).toEqual({ allowed: true, change: 'unchanged' });
  });

  it('lets the owner release or hand over, and a supervisor do either to anyone', () => {
    expect(decide('a', 'a', null)).toEqual({ allowed: true, change: 'release' });
    expect(decide('a', 'a', 'b')).toEqual({ allowed: true, change: 'hand_over' });
    expect(decide('a', 'b', null)).toEqual({ allowed: false, reason: 'not_owner' });
    expect(decide('a', 'b', 'b')).toEqual({ allowed: false, reason: 'not_owner' });
    expect(decide('a', 's', 'b', true)).toEqual({ allowed: true, change: 'reassign' });
    expect(decide('a', 's', null, true)).toEqual({ allowed: true, change: 'release' });
    expect(decide('a', 'b', 'a')).toEqual({ allowed: true, change: 'unchanged' });
  });

  it('never lets a non-supervisor move somebody else’s order', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('a', 'b', 'c'),
        fc.constantFrom('a', 'b', 'c'),
        fc.option(fc.constantFrom('a', 'b', 'c'), { nil: null }),
        (owner, caller, target) => {
          const decision = decide(owner, caller, target);
          if (owner !== caller && target !== owner) expect(decision.allowed).toBe(false);
        },
      ),
    );
  });

  it('counts org admins, branch managers and super admins as supervisors', () => {
    expect(isSupervisor(['org_admin'], false)).toBe(true);
    expect(isSupervisor(['branch_manager'], false)).toBe(true);
    expect(isSupervisor(['sales', 'warehouse'], false)).toBe(false);
    expect(isSupervisor([], true)).toBe(true);
  });
});

describe('callAttemptProblem', () => {
  const now = new Date('2026-10-11T10:00:00.000Z');
  it('needs a future time for a call-back and none for anything else', () => {
    expect(callAttemptProblem({ outcome: 'no_answer', callBackAt: null, now })).toBeNull();
    expect(callAttemptProblem({ outcome: 'reached', callBackAt: now, now })).not.toBeNull();
    expect(callAttemptProblem({ outcome: 'call_back', callBackAt: null, now })).not.toBeNull();
    expect(
      callAttemptProblem({
        outcome: 'call_back',
        callBackAt: new Date(now.getTime() - 3_600_000),
        now,
      }),
    ).not.toBeNull();
    expect(
      callAttemptProblem({
        outcome: 'call_back',
        callBackAt: new Date(now.getTime() + 3_600_000),
        now,
      }),
    ).toBeNull();
    expect(
      callAttemptProblem({
        outcome: 'call_back',
        callBackAt: new Date(now.getTime() + (CALL_BACK_MAX_DAYS + 1) * 86_400_000),
        now,
      }),
    ).not.toBeNull();
  });
});

describe('hubStageOf', () => {
  it('follows a confirmed order through the hub', () => {
    expect(hubStageOf({ status: 'pending', slipPrintedAt: null })).toBeNull();
    expect(hubStageOf({ status: 'confirmed', slipPrintedAt: null })).toBe('to_print');
    expect(hubStageOf({ status: 'confirmed', slipPrintedAt: '2026-10-11T10:00:00Z' })).toBe(
      'packing',
    );
    expect(hubStageOf({ status: 'packed', slipPrintedAt: null })).toBe('packed');
    expect(hubStageOf({ status: 'shipped', slipPrintedAt: null })).toBe('handed_over');
    expect(hubStageOf({ status: 'cancelled', slipPrintedAt: null })).toBeNull();
  });
});

describe('canHoldOrder', () => {
  it('lets the desk roles hold any order and a branch manager only their branches’', () => {
    expect(canHoldOrder([{ role: 'sales', branchIds: [] }], null)).toBe(true);
    expect(canHoldOrder([{ role: 'warehouse', branchIds: ['b1'] }], null)).toBe(true);
    expect(canHoldOrder([{ role: 'branch_manager', branchIds: ['b1'] }], null)).toBe(false);
    expect(canHoldOrder([{ role: 'branch_manager', branchIds: ['b1'] }], 'b1')).toBe(true);
    expect(canHoldOrder([{ role: 'branch_manager', branchIds: ['b1'] }], 'b2')).toBe(false);
    expect(canHoldOrder([{ role: 'branch_manager', branchIds: [] }], 'b2')).toBe(true);
    expect(canHoldOrder([{ role: 'accounts', branchIds: [] }], null)).toBe(false);
    expect(canHoldOrder([], null)).toBe(false);
  });
});
