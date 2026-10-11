import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TWO_FACTOR_POLICY,
  DEFAULT_TWO_FACTOR_REQUIRED_ROLES,
  normaliseRequiredRoles,
  planTurnOffTwoFactor,
  policyChange,
  readTwoFactorPolicy,
  requiresTwoFactorUnder,
  rolesRequiringTwoFactor,
  storedTwoFactorPolicy,
  TWO_FACTOR_POLICY_ROLES,
  twoFactorRequirementFor,
  type BrandRole,
  type TwoFactorPolicy,
} from './index.js';

/**
 * A brand's two-step policy (M40, D-691), as properties over every role set and policy: the
 * answer the wall, the scanner, the Staff list and the account page all ask for.
 */

const roles = fc.constantFrom(...TWO_FACTOR_POLICY_ROLES);
const roleSets = fc.uniqueArray(roles, { maxLength: TWO_FACTOR_POLICY_ROLES.length });
const policies = roleSets.map((required): TwoFactorPolicy => ({
  requiredRoles: normaliseRequiredRoles(required),
  isDefault: false,
}));
const orgs = fc.constantFrom('org-a', 'org-b', 'org-c');
const held = fc.array(fc.record<BrandRole>({ orgId: orgs, role: roles }), { maxLength: 6 });

describe('readTwoFactorPolicy', () => {
  it("is today's list when a brand has chosen nothing", () => {
    expect(readTwoFactorPolicy(undefined)).toBe(DEFAULT_TWO_FACTOR_POLICY);
    expect(readTwoFactorPolicy(null)).toBe(DEFAULT_TWO_FACTOR_POLICY);
    expect(DEFAULT_TWO_FACTOR_REQUIRED_ROLES).toEqual(['org_admin', 'accounts', 'investor']);
  });

  it('falls back to the default for a value nobody could have written through the setting', () => {
    for (const stored of ['sales', 42, [], ['sales'], { roles: ['sales'] }, { requiredRoles: 1 }]) {
      expect(readTwoFactorPolicy(stored), JSON.stringify(stored)).toBe(DEFAULT_TWO_FACTOR_POLICY);
    }
  });

  it('keeps the roles once each, in the setting order', () => {
    expect(readTwoFactorPolicy({ requiredRoles: ['sales', 'org_admin', 'sales'] })).toEqual({
      requiredRoles: ['org_admin', 'sales'],
      isDefault: false,
    });
    // Nothing required is a real choice, not the default.
    expect(readTwoFactorPolicy({ requiredRoles: [] })).toEqual({
      requiredRoles: [],
      isDefault: false,
    });
  });

  it('reads a row naming any role it does not know as the default, never as "not required"', () => {
    for (const stored of [
      { requiredRoles: ['org-admin'] },
      { requiredRoles: ['sales', 'super_admin'] },
      { requiredRoles: ['sales', 7] },
      { requiredRoles: [null] },
    ]) {
      expect(readTwoFactorPolicy(stored), JSON.stringify(stored)).toBe(DEFAULT_TWO_FACTOR_POLICY);
    }
  });

  it('reads back exactly what the setting stores', () => {
    fc.assert(
      fc.property(roleSets, (chosen) => {
        const policy = readTwoFactorPolicy(
          JSON.parse(JSON.stringify(storedTwoFactorPolicy(chosen))),
        );
        expect(new Set(policy.requiredRoles)).toEqual(new Set(chosen));
        expect(policy.isDefault).toBe(false);
      }),
    );
  });
});

describe('requiresTwoFactorUnder', () => {
  it('always requires a super admin, whatever the policy and roles', () => {
    fc.assert(
      fc.property(policies, roleSets, (policy, held) => {
        expect(requiresTwoFactorUnder(policy, held, true)).toBe(true);
      }),
    );
  });

  it('requires anyone else exactly when one of their roles is in the policy', () => {
    fc.assert(
      fc.property(policies, roleSets, (policy, held) => {
        const expected = held.some((role) => policy.requiredRoles.includes(role));
        expect(requiresTwoFactorUnder(policy, held, false)).toBe(expected);
        expect(rolesRequiringTwoFactor(policy, held).length > 0).toBe(expected);
      }),
    );
  });

  it('matches the old fixed list under the default', () => {
    expect(requiresTwoFactorUnder(DEFAULT_TWO_FACTOR_POLICY, ['sales'], false)).toBe(false);
    expect(requiresTwoFactorUnder(DEFAULT_TWO_FACTOR_POLICY, ['warehouse'], false)).toBe(false);
    expect(requiresTwoFactorUnder(DEFAULT_TWO_FACTOR_POLICY, ['accounts'], false)).toBe(true);
    expect(requiresTwoFactorUnder(DEFAULT_TWO_FACTOR_POLICY, ['org_admin'], false)).toBe(true);
    expect(requiresTwoFactorUnder(DEFAULT_TWO_FACTOR_POLICY, ['investor'], false)).toBe(true);
    expect(requiresTwoFactorUnder(DEFAULT_TWO_FACTOR_POLICY, [], true)).toBe(true);
  });
});

describe('twoFactorRequirementFor', () => {
  it("reads each role against its own brand's policy, never another brand's", () => {
    fc.assert(
      fc.property(held, fc.dictionary(orgs, policies), fc.boolean(), (roles, byOrg, superAdmin) => {
        const policyFor = (orgId: string) => byOrg[orgId] ?? DEFAULT_TWO_FACTOR_POLICY;
        const answer = twoFactorRequirementFor({
          isSuperAdmin: superAdmin,
          held: roles,
          policyFor,
        });
        const expected = roles.filter((entry) =>
          policyFor(entry.orgId).requiredRoles.includes(entry.role as never),
        );
        expect(answer.requiredBy).toEqual(expected);
        expect(answer.required).toBe(superAdmin || expected.length > 0);
      }),
    );
  });

  it('a sales role required in one brand does not make sales required in another', () => {
    const salesRequired: TwoFactorPolicy = { requiredRoles: ['sales'], isDefault: false };
    const answer = twoFactorRequirementFor({
      isSuperAdmin: false,
      held: [{ orgId: 'org-b', role: 'sales' }],
      policyFor: (orgId) => (orgId === 'org-a' ? salesRequired : DEFAULT_TWO_FACTOR_POLICY),
    });
    expect(answer.required).toBe(false);
  });
});

describe('planTurnOffTwoFactor', () => {
  it('allows it only when on, and nothing requires it, for someone who is not an owner', () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        held,
        policies,
        fc.boolean(),
        (enabled, owner, roles, policy, superAdmin) => {
          const requirement = twoFactorRequirementFor({
            isSuperAdmin: superAdmin,
            held: roles,
            policyFor: () => policy,
          });
          const plan = planTurnOffTwoFactor({ enabled, isOwner: owner, requirement });
          expect(plan.allowed).toBe(enabled && !owner && !requirement.required);
        },
      ),
    );
  });

  it('says why it is refused', () => {
    const none = twoFactorRequirementFor({
      isSuperAdmin: false,
      held: [],
      policyFor: () => DEFAULT_TWO_FACTOR_POLICY,
    });
    expect(planTurnOffTwoFactor({ enabled: false, isOwner: false, requirement: none })).toEqual({
      allowed: false,
      code: 'TWO_FACTOR_NOT_ENABLED',
      because: 'not_enabled',
    });
    const superAdmin = { ...none, required: true, isSuperAdmin: true };
    expect(
      planTurnOffTwoFactor({ enabled: true, isOwner: false, requirement: superAdmin }),
    ).toMatchObject({ code: 'TWO_FACTOR_REQUIRED', because: 'super_admin' });
    expect(
      planTurnOffTwoFactor({ enabled: true, isOwner: true, requirement: superAdmin }),
    ).toMatchObject({
      because: 'owner',
    });
    const accounts = twoFactorRequirementFor({
      isSuperAdmin: false,
      held: [{ orgId: 'org-a', role: 'accounts' }],
      policyFor: () => DEFAULT_TWO_FACTOR_POLICY,
    });
    expect(
      planTurnOffTwoFactor({ enabled: true, isOwner: false, requirement: accounts }),
    ).toMatchObject({ code: 'TWO_FACTOR_REQUIRED', because: 'role' });
    expect(planTurnOffTwoFactor({ enabled: true, isOwner: false, requirement: none })).toEqual({
      allowed: true,
    });
  });
});

describe('policyChange', () => {
  it('names the roles a change starts and stops requiring, and nothing else', () => {
    fc.assert(
      fc.property(policies, policies, (before, after) => {
        const change = policyChange(before, after);
        for (const role of TWO_FACTOR_POLICY_ROLES) {
          const was = before.requiredRoles.includes(role);
          const now = after.requiredRoles.includes(role);
          expect(change.added.includes(role)).toBe(!was && now);
          expect(change.removed.includes(role)).toBe(was && !now);
        }
      }),
    );
  });
});
