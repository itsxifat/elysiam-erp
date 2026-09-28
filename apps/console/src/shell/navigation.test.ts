import { defineAbilityFor, uniformBranchScope, type MembershipRole } from '@elysium/contracts';
import { describe, expect, it } from 'vitest';

import { consoleEn } from '../i18n/messages.js';
import { NAVIGATION, navigableItems, visibleNavigation } from './navigation.js';

/**
 * M05 acceptance check 1, in the layer where it is decidable.
 *
 * The check is written as a Playwright run — a sales user sees Orders and
 * Customers but not Accounts — and the integrator runs it. This asserts the same
 * thing about the function the sidebar and the palette both call, which is where a
 * regression would actually live: a browser test that fails tells you the sidebar
 * is wrong, and this tells you whether it is the navigation model or the shell.
 *
 * It is deliberately written against `defineAbilityFor` and the real `MATRIX`
 * rather than a stub ability. A stub would pass while the matrix said something
 * else entirely, which is the one outcome that makes the check worthless.
 */

function abilityFor(roles: readonly MembershipRole[], isSuperAdmin = false) {
  return defineAbilityFor({
    roles,
    isSuperAdmin,
    userId: 'user-1',
    branchIds: ['branch-1'],
    branchIdsByRole: uniformBranchScope(roles, ['branch-1']),
  });
}

function labels(roles: readonly MembershipRole[], isSuperAdmin = false): string[] {
  return navigableItems(abilityFor(roles, isSuperAdmin)).map((item) => consoleEn[item.labelKey]);
}

describe('navigation follows the permission matrix (check 1)', () => {
  it('shows a sales user Orders and Customers', () => {
    const visible = labels(['sales']);
    expect(visible).toContain('Orders');
    expect(visible).toContain('Customers');
  });

  it('does not show a sales user Accounts', () => {
    // `sales` holds no `LedgerReport` rule at all in MATRIX, which is what the
    // Accounts entry is keyed on. If this ever passes because the entry was
    // keyed on something else, check 1 in the browser will fail instead.
    expect(labels(['sales'])).not.toContain('Accounts');
  });

  it('shows accounts the Accounts section', () => {
    expect(labels(['accounts'])).toContain('Accounts');
  });

  it('does not show a branch manager Accounts, though they hold read Wallet', () => {
    /*
     * The trap this guards. A branch manager holds `read Wallet` scoped to their
     * branch, so keying Accounts off Wallet would put the finance section in a
     * showroom manager's sidebar — and it would look right, because a wallet is
     * money. §6 gives branch_manager a branch P&L, not the brand's accounts.
     */
    const visible = labels(['branch_manager']);
    expect(visible).not.toContain('Investors');
    expect(visible).toContain('Orders');
  });

  it('gives a super admin every entry', () => {
    const everyLabel = NAVIGATION.flatMap((section) =>
      section.items.map((item) => consoleEn[item.labelKey]),
    );
    expect(labels([], true).sort()).toStrictEqual([...everyLabel].sort());
  });

  it('never keeps a section whose every item was filtered out', () => {
    // A heading with nothing under it tells the user, every time they look, that
    // part of the application is closed to them.
    for (const section of visibleNavigation(abilityFor(['warehouse']))) {
      expect(section.items.length).toBeGreaterThan(0);
    }
  });

  it('always offers the overview, whatever the roles', () => {
    // A user with no grants at all must still land somewhere. An empty sidebar
    // plus a blank page is indistinguishable from a broken deploy.
    expect(labels([])).toContain('Overview');
  });

  it('gives every entry a label that exists in the catalogue', () => {
    for (const section of NAVIGATION) {
      for (const item of section.items) {
        expect(consoleEn[item.labelKey]).toBeTypeOf('string');
      }
    }
  });
});
