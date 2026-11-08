import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { isSuperAdminCandidate, nominationRefusal, type NominationCandidate } from './index.js';

/** Making a super admin (D-954): a super admin's permission is the whole rule. */

const ids = fc.constantFrom('usr_a', 'usr_b', 'usr_c');
const candidates = fc.record<NominationCandidate>({
  userId: ids,
  isActive: fc.boolean(),
  isSuperAdmin: fc.boolean(),
  isOwner: fc.boolean(),
  activeAdminHere: fc.boolean(),
});

describe('nominationRefusal', () => {
  it('lets any super admin make any eligible admin a super admin, at once', () => {
    fc.assert(
      fc.property(ids, candidates, (actorId, candidate) => {
        const refusal = nominationRefusal({ userId: actorId, isSuperAdmin: true }, candidate);
        if (actorId !== candidate.userId && isSuperAdminCandidate(candidate)) {
          expect(refusal).toBeNull();
        } else {
          expect(refusal).not.toBeNull();
        }
      }),
    );
  });

  it('refuses everyone who is not a super admin', () => {
    fc.assert(
      fc.property(ids, candidates, (actorId, candidate) => {
        expect(nominationRefusal({ userId: actorId, isSuperAdmin: false }, candidate)).toBe(
          'not_super_admin',
        );
      }),
    );
  });

  it('never makes an owner, a super admin or someone who is not an active admin a candidate', () => {
    const base = {
      userId: 'usr_b',
      isActive: true,
      isSuperAdmin: false,
      isOwner: false,
      activeAdminHere: true,
    };
    const root = { userId: 'usr_a', isSuperAdmin: true };
    expect(nominationRefusal(root, base)).toBeNull();
    expect(nominationRefusal(root, { ...base, isOwner: true })).toBe('already_super_admin');
    expect(nominationRefusal(root, { ...base, isSuperAdmin: true })).toBe('already_super_admin');
    expect(nominationRefusal(root, { ...base, activeAdminHere: false })).toBe('not_admin_here');
    expect(nominationRefusal(root, { ...base, isActive: false })).toBe('not_admin_here');
    expect(nominationRefusal(root, { ...base, userId: 'usr_a' })).toBe('self');
  });
});
