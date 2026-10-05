import type { Action, AppAbility, Subject } from '@elysium/contracts';

import type { WebsiteMessageKey } from './messages.js';

/**
 * The Website section's screens and the grant each one's routes declare (M33, D-508).
 *
 * Every screen reads with `read Storefront` (org_admin, marketing, sales); its saves ask for
 * `create`, `update` or `delete Storefront`, which only org_admin and marketing hold, so a
 * sales agent sees what the website shows and changes none of it. One list, read by the
 * section's own navigation and by the sidebar.
 */
export interface WebsiteTab {
  readonly path: string;
  readonly labelKey: WebsiteMessageKey;
  readonly required: { readonly action: Action; readonly subject: Subject };
  /** The route refuses anything short of an org-wide reach of `required` (M34 audit W6). */
  readonly orgWide?: true;
}

export const WEBSITE_TABS: readonly WebsiteTab[] = [
  {
    path: '/website/settings',
    labelKey: 'web.nav.settings',
    required: { action: 'read', subject: 'Storefront' },
  },
  {
    path: '/website/hero',
    labelKey: 'web.nav.hero',
    required: { action: 'read', subject: 'Storefront' },
  },
  {
    path: '/website/menu',
    labelKey: 'web.nav.menu',
    required: { action: 'read', subject: 'Storefront' },
  },
  {
    path: '/website/size-charts',
    labelKey: 'web.nav.sizeCharts',
    required: { action: 'read', subject: 'Storefront' },
  },
  {
    path: '/website/connection',
    labelKey: 'web.nav.connection',
    required: { action: 'read', subject: 'Storefront' },
  },
  // M34: the gateway, the email server and the shoppers' accounts.
  {
    path: '/website/payments',
    labelKey: 'web.nav.payments',
    required: { action: 'read', subject: 'Storefront' },
  },
  {
    path: '/website/email',
    labelKey: 'web.nav.email',
    required: { action: 'read', subject: 'Storefront' },
  },
  // Every shopper's email and phone: for those who see every buyer (M34 ledger audit W6).
  {
    path: '/website/customers',
    labelKey: 'web.nav.customers',
    required: { action: 'read', subject: 'Customer' },
    orgWide: true,
  },
];

export function visibleWebsiteTabs(
  ability: AppAbility,
  orgWide: (action: Action, subject: Subject) => boolean = () => true,
): readonly WebsiteTab[] {
  return WEBSITE_TABS.filter(
    (tab) =>
      ability.can('read', 'Storefront') &&
      ability.can(tab.required.action, tab.required.subject) &&
      (tab.orgWide !== true || orgWide(tab.required.action, tab.required.subject)),
  );
}
