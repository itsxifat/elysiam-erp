import { describe, expect, it } from 'vitest';

import {
  CHECKER_TYPES,
  REQUESTER_TYPES,
  resetNeedsSecondPerson,
  SECOND_ADMIN_RESET_ROLES,
} from './matrix.js';

/**
 * Whose sign-in one admin may not reset alone (D-404, after the ledger audit's C1 and W1).
 */
describe('SECOND_ADMIN_RESET_ROLES', () => {
  it('is every role that can raise or decide an approval, and the investor', () => {
    expect([...SECOND_ADMIN_RESET_ROLES].sort()).toEqual([
      'accounts',
      'branch_manager',
      'hr',
      'investor',
      'org_admin',
      'warehouse',
    ]);
    for (const [role, types] of Object.entries(REQUESTER_TYPES)) {
      if (types.length > 0) expect(SECOND_ADMIN_RESET_ROLES).toContain(role);
    }
    for (const [role, types] of Object.entries(CHECKER_TYPES)) {
      if (types.length > 0) expect(SECOND_ADMIN_RESET_ROLES).toContain(role);
    }
  });

  it('counts a role once held, and a super admin always', () => {
    expect(resetNeedsSecondPerson(['sales', 'accounts'], false)).toBe(true);
    expect(resetNeedsSecondPerson(['sales', 'marketing'], false)).toBe(false);
    expect(resetNeedsSecondPerson([], true)).toBe(true);
  });
});
