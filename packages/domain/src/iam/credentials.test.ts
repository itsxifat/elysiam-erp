import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  canMoveReset,
  COLLECT_WINDOW_SECONDS,
  isCollectable,
  planCredentialReset,
  planRoleChange,
  resetAllowedByLimits,
  RESET_LIMITS,
  type ResetKind,
  type ResetStatus,
  type ResetTarget,
} from './index.js';

/**
 * Who may reset whose sign-in (D-402 to D-406), as properties over every
 * combination of facts rather than the handful of cases a person thinks of.
 * The server tests the same rules again against real Postgres; these say what
 * the rules are.
 */

const ids = fc.constantFrom('usr_a', 'usr_b', 'usr_c');
const kinds = fc.constantFrom<ResetKind>('password', 'two_factor');
const targets = fc.record<ResetTarget>({
  userId: ids,
  isSuperAdmin: fc.boolean(),
  activeHere: fc.boolean(),
  inOtherBrand: fc.boolean(),
  hasPasswordAccount: fc.boolean(),
  twoFactorEnabled: fc.boolean(),
  needsSecondPerson: fc.boolean(),
});
const actors = fc.record({ userId: ids, isSuperAdmin: fc.boolean() });

describe('planCredentialReset', () => {
  it('never lets anyone reset their own sign-in', () => {
    fc.assert(
      fc.property(actors, targets, kinds, (actor, target, kind) => {
        const plan = planCredentialReset({
          actor,
          target: { ...target, userId: actor.userId },
          kind,
        });
        expect(plan).toMatchObject({ decision: 'refuse', code: 'USER_SELF_MANAGEMENT' });
      }),
    );
  });

  it('never lets anyone but a super admin act on a super admin or a cross-brand person', () => {
    fc.assert(
      fc.property(actors, targets, kinds, (actor, target, kind) => {
        const plan = planCredentialReset({
          actor: { ...actor, isSuperAdmin: false },
          target,
          kind,
        });
        if (target.isSuperAdmin || target.inOtherBrand) expect(plan.decision).toBe('refuse');
      }),
    );
  });

  it('never resets a deactivated person', () => {
    fc.assert(
      fc.property(actors, targets, kinds, (actor, target, kind) => {
        const plan = planCredentialReset({ actor, target: { ...target, activeHere: false }, kind });
        expect(plan.decision).toBe('refuse');
      }),
    );
  });

  it('resets a checker-capable person at once only for a super admin, or to re-send an invite', () => {
    fc.assert(
      fc.property(actors, targets, kinds, (actor, target, kind) => {
        const plan = planCredentialReset({ actor, target, kind });
        if (plan.decision !== 'now' || !target.needsSecondPerson) return;
        expect(actor.isSuperAdmin || plan.effect === 'invite').toBe(true);
      }),
    );
  });

  it('only ever issues an invite to someone with no password account', () => {
    fc.assert(
      fc.property(actors, targets, kinds, (actor, target, kind) => {
        const plan = planCredentialReset({ actor, target, kind });
        if (plan.decision === 'now' && plan.effect === 'invite') {
          expect(target.hasPasswordAccount).toBe(false);
          expect(kind).toBe('password');
        }
      }),
    );
  });

  it('never resets a second factor that does not exist', () => {
    fc.assert(
      fc.property(actors, targets, (actor, target) => {
        const plan = planCredentialReset({
          actor,
          target: { ...target, twoFactorEnabled: false },
          kind: 'two_factor',
        });
        expect(plan.decision).toBe('refuse');
      }),
    );
  });

  it('reaches every outcome, so the properties above are not vacuous', () => {
    const base: ResetTarget = {
      userId: 'usr_b',
      isSuperAdmin: false,
      activeHere: true,
      inOtherBrand: false,
      hasPasswordAccount: true,
      twoFactorEnabled: true,
      needsSecondPerson: false,
    };
    const admin = { userId: 'usr_a', isSuperAdmin: false };
    const root = { userId: 'usr_a', isSuperAdmin: true };

    expect(planCredentialReset({ actor: admin, target: base, kind: 'password' })).toEqual({
      decision: 'now',
      effect: 'password',
    });
    expect(planCredentialReset({ actor: admin, target: base, kind: 'two_factor' })).toEqual({
      decision: 'now',
      effect: 'two_factor',
    });
    expect(
      planCredentialReset({
        actor: admin,
        target: { ...base, needsSecondPerson: true },
        kind: 'two_factor',
      }),
    ).toEqual({ decision: 'approval', effect: 'two_factor' });
    expect(
      planCredentialReset({
        actor: admin,
        target: { ...base, needsSecondPerson: true, hasPasswordAccount: false },
        kind: 'password',
      }),
    ).toEqual({ decision: 'now', effect: 'invite' });
    expect(
      planCredentialReset({
        actor: root,
        target: { ...base, needsSecondPerson: true, inOtherBrand: true },
        kind: 'password',
      }),
    ).toEqual({ decision: 'now', effect: 'password' });
    expect(
      planCredentialReset({
        actor: admin,
        target: { ...base, inOtherBrand: true },
        kind: 'password',
      }),
    ).toMatchObject({ decision: 'refuse', code: 'USER_PROTECTED' });
  });
});

describe('the reset limits and lifetimes', () => {
  it('refuses at the limit, not one past it', () => {
    expect(resetAllowedByLimits({ byActorLastHour: 19, forTargetLastDay: 4 })).toBe(true);
    expect(
      resetAllowedByLimits({ byActorLastHour: RESET_LIMITS.perActorPerHour, forTargetLastDay: 0 }),
    ).toBe(false);
    expect(
      resetAllowedByLimits({ byActorLastHour: 0, forTargetLastDay: RESET_LIMITS.perTargetPerDay }),
    ).toBe(false);
  });

  it('lets an approved reset be collected for 24 hours, and not before it was approved', () => {
    const approved = new Date('2026-10-02T10:00:00Z');
    expect(isCollectable(approved, new Date('2026-10-03T09:59:59Z'))).toBe(true);
    expect(
      isCollectable(approved, new Date(approved.getTime() + COLLECT_WINDOW_SECONDS * 1000 + 1)),
    ).toBe(false);
    expect(isCollectable(approved, new Date('2026-10-02T09:59:59Z'))).toBe(false);
  });
});

describe('the reset lifecycle', () => {
  const statuses: readonly ResetStatus[] = [
    'pending_approval',
    'approved',
    'completed',
    'rejected',
    'cancelled',
    'expired',
  ];

  it('freezes every finished reset', () => {
    for (const from of ['completed', 'rejected', 'cancelled', 'expired'] as const) {
      for (const to of statuses) expect(canMoveReset(from, to)).toBe(false);
    }
  });

  it('never goes back to waiting', () => {
    for (const from of statuses) expect(canMoveReset(from, 'pending_approval')).toBe(false);
  });
});

describe('planRoleChange', () => {
  const roles = fc.constantFrom('org_admin', 'sales', 'accounts', 'hr', 'branch_manager');
  const branches = fc.uniqueArray(fc.constantFrom('b1', 'b2', 'b3'), { maxLength: 3 });

  it('ends with exactly the wanted roles active, with the wanted branches', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.record({ role: roles, active: fc.boolean(), branchIds: branches }), {
          selector: (entry) => entry.role,
        }),
        fc.uniqueArray(fc.record({ role: roles, branchIds: branches }), {
          selector: (entry) => entry.role,
          minLength: 1,
        }),
        (held, wanted) => {
          const change = planRoleChange(held, wanted);
          const touched = [...change.grant, ...change.reshape, ...change.keep];

          // Every wanted role is granted, reshaped or kept, exactly once.
          expect([...touched].sort()).toEqual(wanted.map((entry) => entry.role).sort());
          // Every active role that is not wanted is revoked, and nothing else is.
          expect([...change.revoke].sort()).toEqual(
            held
              .filter((entry) => entry.active && !wanted.some((want) => want.role === entry.role))
              .map((entry) => entry.role)
              .sort(),
          );
          // A kept role really is unchanged.
          for (const role of change.keep) {
            const before = held.find((entry) => entry.role === role);
            const after = wanted.find((entry) => entry.role === role);
            expect(before?.active).toBe(true);
            expect(new Set(before?.branchIds)).toEqual(new Set(after?.branchIds));
          }
        },
      ),
    );
  });

  it('treats a switched-off role as a new grant, not a keep', () => {
    expect(
      planRoleChange(
        [{ role: 'sales', active: false, branchIds: [] }],
        [{ role: 'sales', branchIds: [] }],
      ),
    ).toEqual({ grant: ['sales'], reshape: [], keep: [], revoke: [] });
  });
});
