import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { removalRefusal, stepDownRefusal, type RemovalTarget } from './index.js';

/** Removing a super admin (D-954): any super admin, at once, never the last one. */

const ids = fc.constantFrom('usr_a', 'usr_b', 'usr_c', 'usr_d');
const superAdmins = fc.uniqueArray(ids, { maxLength: 4 });
const targets = fc.record<RemovalTarget>({
  userId: ids,
  isActive: fc.boolean(),
  isSuperAdmin: fc.boolean(),
  isOwner: fc.boolean(),
});

describe('removalRefusal', () => {
  it('lets any super admin remove another active, non-owner super admin while one remains', () => {
    fc.assert(
      fc.property(ids, targets, superAdmins, (actorId, target, list) => {
        const refusal = removalRefusal({ userId: actorId, isSuperAdmin: true }, target, {
          superAdmins: list,
        });
        const allowed =
          actorId !== target.userId &&
          target.isActive &&
          target.isSuperAdmin &&
          !target.isOwner &&
          list.some((id) => id !== target.userId);
        expect(refusal === null).toBe(allowed);
      }),
    );
  });

  it('refuses everyone who is not a super admin', () => {
    fc.assert(
      fc.property(ids, targets, superAdmins, (actorId, target, list) => {
        expect(
          removalRefusal({ userId: actorId, isSuperAdmin: false }, target, { superAdmins: list }),
        ).toBe('not_super_admin');
      }),
    );
  });
});

describe('stepDownRefusal', () => {
  it('lets a super admin step down while another remains, never an owner', () => {
    expect(
      stepDownRefusal(
        { userId: 'usr_a', isSuperAdmin: true, isOwner: false },
        { superAdmins: ['usr_a', 'usr_b'] },
      ),
    ).toBeNull();
    expect(
      stepDownRefusal(
        { userId: 'usr_a', isSuperAdmin: true, isOwner: false },
        { superAdmins: ['usr_a'] },
      ),
    ).toBe('last_super_admin');
    expect(
      stepDownRefusal(
        { userId: 'usr_a', isSuperAdmin: true, isOwner: true },
        { superAdmins: ['usr_b'] },
      ),
    ).toBe('not_removable');
  });
});
