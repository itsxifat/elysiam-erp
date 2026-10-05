import type { Action, AppAbility, Subject } from '@elysium/contracts';
import type { MessageKey } from '@elysium/i18n';
import {
  ArrowLeftRight,
  BadgeCheck,
  Banknote,
  BarChart3,
  Boxes,
  ChartLine,
  ClipboardList,
  Cog,
  Handshake,
  Landmark,
  LayoutDashboard,
  ListChecks,
  Megaphone,
  Package,
  PackageCheck,
  PackagePlus,
  PackageSearch,
  ScrollText,
  Shapes,
  ShoppingCart,
  SquarePen,
  Store,
  Table2,
  TrendingUp,
  Target,
  Truck,
  Upload,
  UserCog,
  UserPlus,
  UserSearch,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react';

import type { ConsoleMessageKey } from '../i18n/messages.js';
import { SETTINGS_TABS } from '../routes/settings/tabs.js';

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
 *
 * **The groups follow the work, not the milestones (D-449).** Home, Sell, Products and
 * stock, Money, People and Admin: the questions an owner asks of a fashion brand, in
 * the order a day goes. Settings sits apart at the foot of the sidebar.
 */

interface Grant {
  readonly action: Action;
  readonly subject: Subject;
}

type Required = Grant | readonly Grant[] | 'always';

export interface NavItem {
  readonly to: string;
  readonly labelKey: ConsoleMessageKey;
  readonly icon: LucideIcon;
  /**
   * The permission that makes this screen reachable — or, for a section of tabs that each
   * declare their own (Settings), the list of them: the entry shows when any one is held.
   */
  readonly required: Required;
  /** Rendered at the foot of the sidebar rather than in its group (Settings). */
  readonly footer?: boolean;
}

export interface NavSection {
  readonly titleKey: ConsoleMessageKey;
  readonly items: readonly NavItem[];
  /** The first group is the home screens: always open, no heading. */
  readonly untitled?: boolean;
}

export const NAVIGATION: readonly NavSection[] = [
  {
    titleKey: 'nav.sectionHome',
    untitled: true,
    items: [
      { to: '/', labelKey: 'nav.overview', icon: LayoutDashboard, required: 'always' },
      // M24. `read Dashboard`, org_admin's (D-325): the brand's own dashboard.
      {
        to: '/analytics',
        labelKey: 'nav.analytics',
        icon: ChartLine,
        required: { action: 'read', subject: 'Dashboard' },
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
    titleKey: 'nav.sectionSell',
    items: [
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
        to: '/courier',
        labelKey: 'nav.courier',
        icon: PackageCheck,
        // The parcels, stuck queue and returns screens are order work; settlements and
        // the performance report gate themselves on their own grants inside the section.
        required: { action: 'read', subject: 'Order' },
      },
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
    ],
  },
  {
    titleKey: 'nav.sectionStock',
    items: [
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
      // M26: company loans, for the two roles §6 gives them (org_admin and accounts).
      {
        to: '/loans',
        labelKey: 'nav.loans',
        icon: Landmark,
        required: { action: 'read', subject: 'CompanyLoan' },
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
       * gaps-users-auth. `read User`, org_admin's (and super admin's through `manage all`):
       * the brand's people, their roles and sign-in, and the resets waiting for a second
       * admin.
       */
      {
        to: '/users',
        labelKey: 'nav.users',
        icon: UserCog,
        required: { action: 'read', subject: 'User' },
      },
      {
        to: '/audit',
        labelKey: 'nav.audit',
        icon: ScrollText,
        required: { action: 'read', subject: 'AuditLog' },
      },
      /*
       * Settings is a section of tabs, each gated on the grant its own routes declare
       * (`routes/settings/tabs.ts`, D-394), so the link shows for anyone who can open one of
       * them — an accountant for the courier accounts and till registers, marketing for the
       * website order keys — and not, as before, for org_admin alone.
       */
      {
        to: '/settings',
        labelKey: 'nav.settings',
        icon: Cog,
        required: SETTINGS_TABS.map((tab) => tab.required),
        footer: true,
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

function grantsOf(required: Required): readonly Grant[] | 'always' {
  if (required === 'always') return 'always';
  return 'action' in required ? [required] : required;
}

function allowed(ability: AppAbility, required: Required): boolean {
  const grants = grantsOf(required);
  if (grants === 'always') return true;
  return grants.some((grant) => ability.can(grant.action, grant.subject));
}

export function canSee(ability: AppAbility, item: NavItem): boolean {
  return allowed(ability, item.required);
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
    ...section,
    items: section.items.filter((item) => canSee(ability, item)),
  })).filter((section) => section.items.length > 0);
}

/** Flat, for the command palette. */
export function navigableItems(ability: AppAbility): readonly NavItem[] {
  return visibleNavigation(ability).flatMap((section) => section.items);
}

/** The section and entry a path belongs to, for the topbar's breadcrumb. */
export function locate(
  pathname: string,
): { readonly section: NavSection; readonly item: NavItem } | null {
  let best: { section: NavSection; item: NavItem } | null = null;
  for (const section of NAVIGATION) {
    for (const item of section.items) {
      const hit =
        item.to === '/'
          ? pathname === '/'
          : pathname === item.to || pathname.startsWith(`${item.to}/`);
      if (hit && (best === null || item.to.length > best.item.to.length)) best = { section, item };
    }
  }
  return best;
}

// --- the command palette's catalogue (D-463) ----------------------------------

/**
 * A screen inside a section, for the palette: "Transfers" under Accounts, "Stuck
 * parcels" under Couriers. The sidebar shows the sections; the palette reaches every
 * screen in one step, which is what "easy to point" means for someone who knows
 * where they are going.
 */
export interface PalettePage {
  readonly to: string;
  readonly labelKey: MessageKey;
  /** The sidebar entry it lives under, shown beside it. */
  readonly parentKey: ConsoleMessageKey;
  readonly icon: LucideIcon;
  readonly required: Required;
}

export const PALETTE_PAGES: readonly PalettePage[] = [
  {
    to: '/orders/queue',
    labelKey: 'orders.nav.queue',
    parentKey: 'nav.orders',
    icon: ListChecks,
    required: { action: 'read', subject: 'Order' },
  },
  {
    to: '/orders/buyers',
    labelKey: 'orders.nav.buyers',
    parentKey: 'nav.orders',
    icon: Users,
    required: { action: 'read', subject: 'Order' },
  },
  {
    to: '/orders/returns',
    labelKey: 'orders.nav.returns',
    parentKey: 'nav.orders',
    icon: PackageSearch,
    required: { action: 'read', subject: 'Order' },
  },
  {
    to: '/customers/lapsed',
    labelKey: 'customers.nav.lapsed',
    parentKey: 'nav.customers',
    icon: Users,
    required: { action: 'read', subject: 'Customer' },
  },
  {
    to: '/courier/stuck',
    labelKey: 'courier.nav.stuck',
    parentKey: 'nav.courier',
    icon: PackageSearch,
    required: { action: 'read', subject: 'Order' },
  },
  {
    to: '/courier/settlements',
    labelKey: 'courier.nav.settlements',
    parentKey: 'nav.courier',
    icon: Banknote,
    required: { action: 'read', subject: 'CourierSettlement' },
  },
  {
    to: '/courier/returns',
    labelKey: 'courier.nav.returns',
    parentKey: 'nav.courier',
    icon: PackageSearch,
    required: { action: 'read', subject: 'Order' },
  },
  {
    to: '/catalog/structure',
    labelKey: 'catalog.structure',
    parentKey: 'nav.catalog',
    icon: Shapes,
    required: { action: 'read', subject: 'Catalog' },
  },
  {
    to: '/catalog/import',
    labelKey: 'catalog.import',
    parentKey: 'nav.catalog',
    icon: Upload,
    required: { action: 'read', subject: 'Catalog' },
  },
  {
    to: '/stock/adjustments',
    labelKey: 'stock.adjustments',
    parentKey: 'nav.stock',
    icon: Boxes,
    required: { action: 'read', subject: 'Stock' },
  },
  {
    to: '/stock/transfers',
    labelKey: 'stock.transfers',
    parentKey: 'nav.stock',
    icon: ArrowLeftRight,
    required: { action: 'read', subject: 'Stock' },
  },
  {
    to: '/stock/counts',
    labelKey: 'stock.counts',
    parentKey: 'nav.stock',
    icon: ClipboardList,
    required: { action: 'read', subject: 'Stock' },
  },
  {
    to: '/supply/entries',
    labelKey: 'supply.entries',
    parentKey: 'nav.supply',
    icon: Truck,
    required: { action: 'read', subject: 'Supply' },
  },
  {
    to: '/supply/payments',
    labelKey: 'supply.payments',
    parentKey: 'nav.supply',
    icon: Banknote,
    required: { action: 'read', subject: 'Supply' },
  },
  {
    to: '/accounts/transfers',
    labelKey: 'accounts.nav.transfers',
    parentKey: 'nav.accounts',
    icon: ArrowLeftRight,
    required: { action: 'read', subject: 'LedgerReport' },
  },
  {
    to: '/accounts/wallets',
    labelKey: 'accounts.nav.wallets',
    parentKey: 'nav.accounts',
    icon: Wallet,
    required: { action: 'read', subject: 'LedgerReport' },
  },
  {
    to: '/accounts/reports',
    labelKey: 'accounts.nav.reports',
    parentKey: 'nav.accounts',
    icon: ScrollText,
    required: { action: 'read', subject: 'LedgerReport' },
  },
  {
    to: '/accounts/ledger',
    labelKey: 'accounts.nav.ledger',
    parentKey: 'nav.accounts',
    icon: ScrollText,
    required: { action: 'read', subject: 'LedgerReport' },
  },
  {
    to: '/accounts/advances',
    labelKey: 'accounts.nav.advances',
    parentKey: 'nav.accounts',
    icon: Banknote,
    required: { action: 'read', subject: 'LedgerReport' },
  },
  {
    to: '/people/attendance',
    labelKey: 'hr.attendance',
    parentKey: 'nav.people',
    icon: ClipboardList,
    required: { action: 'read', subject: 'Employee' },
  },
  {
    to: '/payroll/loans',
    labelKey: 'hr.loans',
    parentKey: 'nav.payroll',
    icon: Banknote,
    required: { action: 'read', subject: 'Payroll' },
  },
  {
    to: '/performance/targets',
    labelKey: 'perf.targets',
    parentKey: 'nav.performance',
    icon: Target,
    required: { action: 'read', subject: 'Target' },
  },
  ...SETTINGS_TABS.map((tab): PalettePage => ({
    to: tab.path,
    labelKey: tab.labelKey,
    parentKey: 'nav.settings',
    icon: Cog,
    required: tab.required,
  })),
];

/**
 * The things people come to the console to do, named as actions: "Take a new order",
 * not "Order desk". Each opens the screen where the action starts, and each asks the
 * same ability the screen's own route declares, so the palette never offers a 403.
 */
export interface PaletteAction {
  readonly id: string;
  readonly to: string;
  readonly labelKey: MessageKey;
  readonly icon: LucideIcon;
  readonly required: Required;
  /** Extra words people type for it ("sell", "invoice"). Matched, never shown. */
  readonly keywords: readonly string[];
}

export const PALETTE_ACTIONS: readonly PaletteAction[] = [
  {
    id: 'new-order',
    to: '/orders/new',
    labelKey: 'palette.actionNewOrder',
    icon: SquarePen,
    required: { action: 'create', subject: 'Order' },
    keywords: ['new order', 'sell', 'order desk', 'নতুন অর্ডার'],
  },
  {
    id: 'order-queue',
    to: '/orders/queue',
    labelKey: 'palette.actionOrderQueue',
    icon: ListChecks,
    required: { action: 'read', subject: 'Order' },
    keywords: ['queue', 'confirm', 'call'],
  },
  {
    id: 'add-product',
    to: '/catalog/new',
    labelKey: 'palette.actionAddProduct',
    icon: PackagePlus,
    required: { action: 'create', subject: 'Catalog' },
    keywords: ['add product', 'new product', 'item', 'sku'],
  },
  {
    id: 'find-buyer',
    to: '/customers',
    labelKey: 'palette.actionFindBuyer',
    icon: UserSearch,
    required: { action: 'read', subject: 'Customer' },
    keywords: ['customer', 'buyer', 'phone'],
  },
  {
    id: 'move-money',
    to: '/accounts/transfers',
    labelKey: 'palette.actionMoveMoney',
    icon: ArrowLeftRight,
    required: [{ action: 'update', subject: 'Wallet' }],
    keywords: ['transfer', 'bkash', 'bank', 'cash', 'wallet'],
  },
  {
    id: 'record-supply',
    to: '/supply/entries',
    labelKey: 'palette.actionRecordSupply',
    icon: Truck,
    required: { action: 'create', subject: 'Supply' },
    keywords: ['purchase', 'supplier', 'buy', 'goods received'],
  },
  {
    id: 'transfer-stock',
    to: '/stock/transfers',
    labelKey: 'palette.actionTransferStock',
    icon: Boxes,
    required: { action: 'request', subject: 'StockAdjustment' },
    keywords: ['move stock', 'showroom', 'warehouse'],
  },
  {
    id: 'review-approvals',
    to: '/approvals',
    labelKey: 'palette.actionReviewApprovals',
    icon: BadgeCheck,
    required: { action: 'approve', subject: 'ApprovalRequest' },
    keywords: ['approve', 'reject', 'pending'],
  },
  {
    id: 'stuck-parcels',
    to: '/courier/stuck',
    labelKey: 'palette.actionStuckParcels',
    icon: PackageSearch,
    required: { action: 'read', subject: 'Order' },
    keywords: ['courier', 'parcel', 'late', 'stuck'],
  },
  {
    id: 'invite-staff',
    to: '/users',
    labelKey: 'palette.actionInviteStaff',
    icon: UserPlus,
    required: { action: 'create', subject: 'User' },
    keywords: ['invite', 'staff', 'user', 'employee', 'add user'],
  },
];

export function visiblePalettePages(ability: AppAbility): readonly PalettePage[] {
  return PALETTE_PAGES.filter((page) => allowed(ability, page.required));
}

export function visiblePaletteActions(ability: AppAbility): readonly PaletteAction[] {
  return PALETTE_ACTIONS.filter((action) => allowed(ability, action.required));
}
