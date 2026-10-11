import type { Action, AppAbility, Subject } from '@elysium/contracts';

import type { SettingsMessageKey } from './messages.js';

/**
 * The settings tabs and the grant each one's routes declare (D-394).
 *
 * One list, read by the tabs and by the sidebar: the Settings link shows for anyone who can
 * open at least one tab, and each tab is shown only to the roles its own routes admit. Nothing
 * here widens a grant — every ability is the one the server already declares on the routes the
 * tab calls.
 *
 * - thresholds: `read ApprovalThreshold` (org_admin; the `PUT` is `update`, the same role).
 * - zones: `update Catalog` (org_admin), the grant `PUT /v1/delivery-zones` declares. Every
 *   desk role can *read* zones; only the one who can change them needs this screen.
 * - couriers: `read CourierSettlement` (org_admin, accounts), with saving on `update`.
 * - site keys: `create LandingPage` (org_admin, marketing). Sales and branch managers *read*
 *   landing pages to apply codes; issuing a brand's order key is not that.
 * - registers: `update Wallet` (org_admin, accounts, branch managers for their branches).
 * - security: `update SecurityPolicy` (M40, D-692), which no membership role holds: super
 *   admins only.
 */
export interface SettingsTab {
  readonly path: string;
  readonly labelKey: SettingsMessageKey;
  readonly required: { readonly action: Action; readonly subject: Subject };
}

export const SETTINGS_TABS: readonly SettingsTab[] = [
  {
    path: '/settings/thresholds',
    labelKey: 'settings.nav.thresholds',
    required: { action: 'read', subject: 'ApprovalThreshold' },
  },
  {
    path: '/settings/zones',
    labelKey: 'settings.nav.zones',
    required: { action: 'update', subject: 'Catalog' },
  },
  {
    path: '/settings/couriers',
    labelKey: 'settings.nav.couriers',
    required: { action: 'read', subject: 'CourierSettlement' },
  },
  {
    path: '/settings/site-keys',
    labelKey: 'settings.nav.siteKeys',
    required: { action: 'create', subject: 'LandingPage' },
  },
  {
    path: '/settings/registers',
    labelKey: 'settings.nav.registers',
    required: { action: 'update', subject: 'Wallet' },
  },
  {
    path: '/settings/security',
    labelKey: 'settings.nav.security',
    required: { action: 'update', subject: 'SecurityPolicy' },
  },
];

export function visibleTabs(ability: AppAbility): readonly SettingsTab[] {
  return SETTINGS_TABS.filter((tab) => ability.can(tab.required.action, tab.required.subject));
}
