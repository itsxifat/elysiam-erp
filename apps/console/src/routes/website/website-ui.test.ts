import { defineAbilityFor, type MembershipRole } from '@elysium/contracts';
import { describe, expect, it } from 'vitest';

import { NAVIGATION } from '../../shell/navigation.js';
import { moved } from './reorder.js';
import { visibleWebsiteTabs, WEBSITE_TABS } from './tabs.js';

function ability(role: MembershipRole) {
  return defineAbilityFor({
    roles: [role],
    isSuperAdmin: false,
    userId: 'u',
    branchIds: [],
    branchIdsByRole: { [role]: [] },
  });
}

describe('the Website section (M33)', () => {
  it('opens for org_admin, marketing and sales, and for nobody else', () => {
    for (const role of ['org_admin', 'marketing', 'sales'] as const) {
      expect(visibleWebsiteTabs(ability(role)).map((tab) => tab.path)).toEqual(
        WEBSITE_TABS.map((tab) => tab.path),
      );
    }
    for (const role of ['accounts', 'hr', 'warehouse', 'branch_manager', 'reseller'] as const) {
      expect(visibleWebsiteTabs(ability(role))).toEqual([]);
    }
  });

  it('sits in the sidebar’s Sell group, gated on read Storefront', () => {
    const entry = NAVIGATION.flatMap((section) => section.items).find(
      (item) => item.to === '/website',
    );
    expect(entry?.required).toEqual({ action: 'read', subject: 'Storefront' });
    const sell = NAVIGATION.find((section) => section.titleKey === 'nav.sectionSell');
    expect(sell?.items.some((item) => item.to === '/website')).toBe(true);
  });

  it('moves one row and keeps every other in order', () => {
    expect(moved(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(moved(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moved(['a', 'b'], 1, 9)).toEqual(['a', 'b']);
    expect(moved(['a'], 3, 0)).toEqual(['a']);
  });
});
