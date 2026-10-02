import type { Action, AppAbility, Subject } from '@elysium/contracts';
import {
  BadgeCheck,
  Banknote,
  BarChart3,
  Boxes,
  ClipboardList,
  Cog,
  Handshake,
  LayoutDashboard,
  Megaphone,
  Package,
  PackageCheck,
  ScrollText,
  ShoppingCart,
  Store,
  Table2,
  TrendingUp,
  Target,
  Truck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

import type { ConsoleMessageKey } from '../i18n/messages.js';

/**
 * The navigation, as a function of the permission matrix (M05 check 1).
 *
 * Every entry names the (action, subject) that makes its screen reachable, and
 * `visibleNavigation` asks the caller's CASL ability. Nothing here is a list of
 * who sees what — that lives in `MATRIX` in `packages/contracts`, once, where the
 * server guard reads it too.
 *
 * Why this rather than a hardcoded sidebar: the failure mode of a list is
 * silent. A permission is narrowed in the matrix, the link stays, and the first
 * person to discover it is a sales agent clicking Accounts and getting a 403 they
 * cannot interpret. Worse in the other direction — a subject is added to a role
 * and nobody adds the link, so the feature ships invisible.
 *
 * The check the milestone measures is exactly this: a sales user sees Orders and
 * Customers and not Accounts. From `MATRIX`, `sales` holds
 * `read Order` (own) and `read Customer` (own) and no `LedgerReport` at all, so
 * the answer falls out of the matrix rather than out of this file.
 *
 * **The ability is asked with a bare subject string, deliberately.** CASL answers
 * "could this caller do this to *some* row", which is the right question for a
 * navigation entry: a sales agent whose `read Order` is scoped to their own
 * orders should still see Orders. Passing a row here would hide the section from
 * everyone whose grant is scoped, which is most people.
 */

export interface NavItem {
  readonly to: string;
  readonly labelKey: ConsoleMessageKey;
  readonly icon: LucideIcon;
  /** The permission that makes this screen reachable. */
  readonly required: { readonly action: Action; readonly subject: Subject } | 'always';
}

export interface NavSection {
  readonly titleKey: ConsoleMessageKey;
  readonly items: readonly NavItem[];
}

export const NAVIGATION: readonly NavSection[] = [
  {
    titleKey: 'nav.sectionWork',
    items: [
      { to: '/', labelKey: 'nav.overview', icon: LayoutDashboard, required: 'always' },
      {
        to: '/orders',
        labelKey: 'nav.orders',
        icon: ShoppingCart,
        required: { action: 'read', subject: 'Order' },
      },
      {
        to: '/customers',
        labelKey: 'nav.customers',
        icon: Users,
        required: { action: 'read', subject: 'Customer' },
      },
      {
        to: '/catalog',
        labelKey: 'nav.catalog',
        icon: Package,
        required: { action: 'read', subject: 'Catalog' },
      },
      {
        to: '/stock',
        labelKey: 'nav.stock',
        icon: Boxes,
        required: { action: 'read', subject: 'Stock' },
      },
      {
        to: '/supply',
        labelKey: 'nav.supply',
        icon: Truck,
        required: { action: 'read', subject: 'Supply' },
      },
      {
        to: '/courier',
        labelKey: 'nav.courier',
        icon: PackageCheck,
        // The parcels, stuck queue and returns screens are order work; settlements and
        // the performance report gate themselves on their own grants inside the section.
        required: { action: 'read', subject: 'Order' },
      },
    ],
  },
  {
    titleKey: 'nav.sectionMoney',
    items: [
      /*
       * `read LedgerReport`, not `read Wallet`, and the difference is check 1.
       *
       * A branch manager holds `read Wallet` scoped to their branch, so keying
       * Accounts off Wallet would put the finance section in a showroom
       * manager's sidebar. `LedgerReport` is the reports subject §6 gives to
       * accounts, org_admin and branch_manager — and it is the one `sales` does
       * not hold at all, which is what the check asserts.
       */
      {
        to: '/accounts',
        labelKey: 'nav.accounts',
        icon: Banknote,
        required: { action: 'read', subject: 'LedgerReport' },
      },
      /*
       * The showroom dashboards (M23). `read LedgerReport` like Accounts, and for
       * the same reason: §6 gives a branch manager "branch P&L without cost
       * detail", and the server scopes the list to the branches their role reaches.
       */
      {
        to: '/branches',
        labelKey: 'nav.branches',
        icon: Store,
        required: { action: 'read', subject: 'LedgerReport' },
      },
      {
        to: '/investors',
        labelKey: 'nav.investors',
        icon: Wallet,
        required: { action: 'read', subject: 'Investor' },
      },
      {
        to: '/approvals',
        labelKey: 'nav.approvals',
        icon: BadgeCheck,
        required: { action: 'read', subject: 'ApprovalRequest' },
      },
    ],
  },
  {
    titleKey: 'nav.sectionPeople',
    items: [
      {
        to: '/people',
        labelKey: 'nav.people',
        icon: ClipboardList,
        required: { action: 'read', subject: 'Employee' },
      },
      {
        to: '/payroll',
        labelKey: 'nav.payroll',
        icon: BarChart3,
        required: { action: 'read', subject: 'Payroll' },
      },
      /*
       * M20. `read Target`, which every desk role holds for its own targets: an agent's
       * entry opens their own dashboard, and HR's opens the same section with the
       * brand's targets, rules and report beside it.
       */
      {
        to: '/performance',
        labelKey: 'nav.performance',
        icon: Target,
        required: { action: 'read', subject: 'Target' },
      },
      {
        to: '/resellers',
        labelKey: 'nav.resellers',
        icon: Handshake,
        required: { action: 'read', subject: 'ResellerAdmin' },
      },
    ],
  },
  {
    titleKey: 'nav.sectionAdmin',
    items: [
      /*
       * M18. `read CampaignSpend`, the wider of the section's two subjects: accounts holds
       * it for spend entry (§6) and nothing else here, so an accountant sees Marketing with
       * one tab, Spend. Marketing and org_admin hold both.
       */
      {
        to: '/marketing',
        labelKey: 'nav.marketing',
        icon: TrendingUp,
        required: { action: 'read', subject: 'CampaignSpend' },
      },
      {
        to: '/campaigns',
        labelKey: 'nav.campaigns',
        icon: Megaphone,
        required: { action: 'read', subject: 'Campaign' },
      },
      {
        to: '/audit',
        labelKey: 'nav.audit',
        icon: ScrollText,
        required: { action: 'read', subject: 'AuditLog' },
      },
      {
        to: '/settings',
        labelKey: 'nav.settings',
        icon: Cog,
        required: { action: 'update', subject: 'ApprovalThreshold' },
      },
      /*
       * M05's DataTable showcase, with invented rows. Development builds only: shown
       * to every role in production it put fake figures one click from real ones,
       * and a demo page in a staff tool reads as unfinished software.
       */
      ...(import.meta.env.DEV
        ? [{ to: '/tables', labelKey: 'nav.tables', icon: Table2, required: 'always' } as const]
        : []),
    ],
  },
];

export function canSee(ability: AppAbility, item: NavItem): boolean {
  if (item.required === 'always') return true;
  return ability.can(item.required.action, item.required.subject);
}

/**
 * The sections this caller can act in, with empty ones dropped.
 *
 * Dropping the empty section is not tidiness. A heading with nothing under it
 * tells the user that a part of the application exists and is closed to them,
 * every time they look at the screen — which is the message §24's
 * permission-denied state exists to deliver *once*, on purpose, when absence
 * would look like a bug.
 */
export function visibleNavigation(ability: AppAbility): readonly NavSection[] {
  return NAVIGATION.map((section) => ({
    titleKey: section.titleKey,
    items: section.items.filter((item) => canSee(ability, item)),
  })).filter((section) => section.items.length > 0);
}

/** Flat, for the command palette. */
export function navigableItems(ability: AppAbility): readonly NavItem[] {
  return visibleNavigation(ability).flatMap((section) => section.items);
}
