import type { MembershipRole } from '../iam.js';
import type { Action, Scope, Subject } from './subjects.js';

/**
 * The permission matrix (architecture §6).
 *
 * One declarative table, transcribed from §6's capability grid. Everything that
 * enforces permissions — the guard, `serializeFor`, the route-coverage gate,
 * the generated role-matrix suite — reads this and nothing else. §6 says the
 * code becomes authoritative from M02b, and any change needs a decision row.
 *
 * Read a rule as: this role may perform this action on this subject, at most
 * this far. Absence is denial; there is no "default allow" anywhere.
 *
 * `super_admin` is not in this table. It is not a role with a long list of
 * grants but a different question entirely — §5 exception 3 — and treating it
 * as a row would mean every future subject needed remembering to add it to.
 * `defineAbilityFor` gives it `manage all` and the tests assert that.
 */

export interface Rule {
  readonly action: Action | readonly Action[];
  readonly subject: Subject;
  readonly scope: Scope;
}

/*
 * There was an `except?: readonly string[]` here, set to `['unitCostPoisha']`
 * on four rules and read by nothing. It was harmless only because that field is
 * in COST_FIELDS anyway — the next person to write `except: ['customerPhone']`
 * would have got a rule that silently granted it. Field-level exclusion belongs
 * to `serializeFor`, which is the one place that actually removes fields.
 */

/**
 * Cost is a capability, not a subject: `read:cost` in §6's wording. These are
 * the roles that hold it, and `serializeFor` strips COST_FIELDS for everyone
 * else regardless of what else they may read.
 */
export const COST_READING_ROLES: readonly MembershipRole[] = ['org_admin', 'accounts'];

/**
 * Which approval types each role may *decide* (architecture §6).
 *
 * `approve ApprovalRequest` is one capability, but §6's "Approvals (as checker)"
 * row is not one capability: it gives accounts **payments**, hr **payroll**,
 * branch_manager **branch items under threshold**, and reserves reopening a
 * closed period for super_admin. Collapsing that into a single subject meant a
 * showroom branch_manager could approve a payroll run, a reseller payout batch
 * or a period reopen raised by anyone in the org — reproduced against the real
 * API, 201.
 *
 * So the type is checked separately from the ability. The ability decides
 * whether you are a checker at all; this decides what you may check.
 *
 * `period_reopen` is in nobody's list. §7 says reopening needs super_admin
 * approval, and super_admin is not a matrix row — `canDecideType` short-circuits
 * on it. Leaving it out of every role is how "super_admin only" is expressed.
 */
export const CHECKER_TYPES: Readonly<Record<MembershipRole, readonly string[]>> = {
  org_admin: [
    'wallet_adjustment',
    'stock_write_off',
    'stock_gain',
    'supplier_payment',
    'settlement_posting',
    'closing_variance',
    'back_dated_entry',
    'payroll_run',
    'bonus_rule',
    'reseller_payout_batch',
    'investor_withdrawal',
    'investor_distribution',
    // §6 puts fraud block override in org_admin's column and nobody else's.
    'fraud_override',
  ],
  // §6: payments. Investor withdrawals and distributions are money leaving the
  // company, which is the same kind of thing as a supplier payment.
  accounts: [
    'supplier_payment',
    'settlement_posting',
    'reseller_payout_batch',
    'closing_variance',
    'investor_withdrawal',
    'investor_distribution',
  ],
  // §6: payroll.
  hr: ['payroll_run', 'bonus_rule'],
  // §6: branch items. Stock and till, not money leaving the company — and only
  // under the org's threshold for the type. See LIMITED_CHECKER_ROLES.
  branch_manager: ['stock_write_off', 'stock_gain', 'closing_variance'],
  sales: [],
  marketing: [],
  warehouse: [],
  reseller: [],
  investor: [],
};

/**
 * May these roles decide a request of this type?
 *
 * A super admin may decide anything, including `period_reopen`, which is the
 * only way that type can ever be approved (§7).
 */
export function canDecideType(
  roles: readonly MembershipRole[],
  type: string,
  isSuperAdmin: boolean,
): boolean {
  if (isSuperAdmin) return true;
  return roles.some((role) => (CHECKER_TYPES[role] ?? []).includes(type));
}

/**
 * Checkers whose authority is capped by an amount (architecture §6).
 *
 * §6's checker cell for branch_manager is not "branch items" but "branch items
 * **under threshold**", and the three words at the end were not transcribed:
 * a showroom manager could approve a stock write-off of any size, including
 * one they had a colleague raise. `CHECKER_TYPES` answers *which* types; this
 * answers *how much*, and `withinCheckerLimit` in the domain does the
 * comparison, because that is where arithmetic lives (invariant 11).
 *
 * The limit is the org's own approval threshold for the type — the same number
 * that decides whether a second person is needed at all. So a request under it
 * may be raised voluntarily and decided in the branch, and anything at or above
 * it goes to an org-level checker. With no threshold configured the branch
 * checker may decide nothing, which is the same fail-closed direction
 * `requiresApproval` already takes.
 */
export const LIMITED_CHECKER_ROLES: readonly MembershipRole[] = ['branch_manager'];

/**
 * Is every checker role this caller holds an amount-limited one?
 *
 * Roles are additive, so someone who is both `branch_manager` and `accounts`
 * is not limited — the wider role is what applies, exactly as `effectiveScope`
 * treats scope. Only a caller whose *sole* route to this type is a limited role
 * is capped.
 */
export function isLimitedChecker(
  roles: readonly MembershipRole[],
  type: string,
  isSuperAdmin: boolean,
): boolean {
  if (isSuperAdmin) return false;
  const deciding = roles.filter((role) => (CHECKER_TYPES[role] ?? []).includes(type));
  if (deciding.length === 0) return false;
  return deciding.every((role) => LIMITED_CHECKER_ROLES.includes(role));
}

export const MATRIX: Readonly<Record<MembershipRole, readonly Rule[]>> = {
  org_admin: [
    { action: ['read', 'create', 'update', 'delete'], subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'Cost', scope: 'org' },
    { action: ['read', 'create', 'update', 'delete'], subject: 'CostedItem', scope: 'org' },
    /*
     * Read only, and no `update Stock` for anybody.
     *
     * §6's stock row is "Stock availability" — a read. Changing stock is the
     * next row down, and it is `StockAdjustment`. A bare `update Stock` grant
     * contradicts invariant 3, which says stock changes only through inventory
     * movements: the permission would have described a path that must not
     * exist, and M07 would have found a rule inviting it to build one.
     */
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: ['read', 'request', 'approve'], subject: 'StockAdjustment', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Supply', scope: 'org' },
    { action: ['read', 'create', 'update', 'delete'], subject: 'Order', scope: 'org' },
    { action: ['read', 'update'], subject: 'Customer', scope: 'org' },
    { action: 'export', subject: 'BuyerExport', scope: 'org' },
    { action: 'read', subject: 'FraudSignal', scope: 'org' },
    { action: 'update', subject: 'FraudOverride', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Wallet', scope: 'org' },
    { action: 'read', subject: 'LedgerReport', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'CourierSettlement', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Campaign', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'CampaignSpend', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'LandingPage', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Employee', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Payroll', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Target', scope: 'org' },
    { action: ['read', 'update'], subject: 'ResellerAdmin', scope: 'org' },
    { action: 'read', subject: 'Investor', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'CompanyLoan', scope: 'org' },
    { action: ['read', 'create', 'update', 'delete'], subject: 'User', scope: 'org' },
    { action: ['read', 'request', 'approve'], subject: 'ApprovalRequest', scope: 'org' },
    { action: 'read', subject: 'AuditLog', scope: 'org' },
    // §6's row is "Users, roles, settings". Settings was never transcribed, so
    // approval thresholds — the numbers that decide when maker-checker applies
    // at all — were governed by no rule anybody could name.
    { action: ['read', 'update'], subject: 'Settings', scope: 'org' },
    /*
     * The one cross-org grant an ordinary role holds, and §18 is explicit about
     * why it is not a tenancy hole: org admins see other orgs' **normalized
     * metrics and ranks only**, never raw financials (D-023). It is read
     * through `erp_analytics` (§5 exception 2), never through a tenant query,
     * and it carries no money at all — growth percentages, rates and ranks.
     *
     * The matrix test allows exactly this cell and fails on any other `all`.
     */
    { action: 'read', subject: 'Leaderboard', scope: 'all' },
  ],

  accounts: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'Cost', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'org' },
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: 'read', subject: 'StockAdjustment', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Supply', scope: 'org' },
    { action: 'read', subject: 'Order', scope: 'org' },
    { action: 'read', subject: 'Customer', scope: 'org' },
    { action: 'read', subject: 'FraudSignal', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Wallet', scope: 'org' },
    { action: 'read', subject: 'LedgerReport', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'CourierSettlement', scope: 'org' },
    // §6's cell is "spend entry", not the campaigns row. Transcribed as
    // `create Campaign`, it let the finance team launch a brand's campaigns.
    { action: ['read', 'create', 'update'], subject: 'CampaignSpend', scope: 'org' },
    // §6 gives accounts "payroll posting and payment" on the employees row —
    // not the employees. Create and update on staff records is HR's.
    { action: 'read', subject: 'Employee', scope: 'org' },
    { action: ['read', 'update'], subject: 'Payroll', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'ResellerAdmin', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Investor', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'CompanyLoan', scope: 'org' },
    // §6's matrix gives accounts approvals over payments specifically.
    { action: ['read', 'request', 'approve'], subject: 'ApprovalRequest', scope: 'org' },
  ],

  sales: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'org' },
    { action: 'read', subject: 'Stock', scope: 'org' },
    // §6: "own + unassigned queue". Plain `own` hid the queue the whole COD
    // workflow runs on, and the obvious repair for that is `org`.
    { action: ['read', 'create', 'update'], subject: 'Order', scope: 'own_or_unassigned' },
    { action: ['read', 'create', 'update'], subject: 'Customer', scope: 'own' },
    { action: 'read', subject: 'FraudSignal', scope: 'org' },
    // §6 says "apply codes", not edit pages. `update LandingPage` would have let
    // a sales agent rewrite a brand's storefront; applying a promo code is an
    // Order concern and is covered by the Order rules above.
    { action: 'read', subject: 'LandingPage', scope: 'org' },
    { action: 'read', subject: 'Employee', scope: 'own' },
    { action: 'read', subject: 'Target', scope: 'own' },
    /*
     * Read *own*, alongside request.
     *
     * §6's approvals row is about being a checker, and it gives sales nothing
     * — correctly. But the maker-checker list lets anyone raise a request, and
     * with `request` alone a sales agent who raised one got 403 on
     * `GET /v1/approvals` and could never find out what happened to it. The
     * service already narrowed the list to "what you raised, plus what you may
     * decide"; that first clause was unreachable for exactly the roles it was
     * written for.
     */
    { action: ['read', 'request'], subject: 'ApprovalRequest', scope: 'own' },
  ],

  marketing: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'org' },
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: 'read', subject: 'Order', scope: 'org' },
    { action: ['read', 'update'], subject: 'Customer', scope: 'org' },
    { action: 'export', subject: 'BuyerExport', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Campaign', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'LandingPage', scope: 'org' },
    { action: 'read', subject: 'Employee', scope: 'own' },
    { action: 'read', subject: 'Target', scope: 'own' },
  ],

  hr: [
    { action: ['read', 'create', 'update'], subject: 'Employee', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Payroll', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Target', scope: 'org' },
    // §6 makes hr the checker for payroll. CHECKER_TYPES is what narrows this
    // to payroll and bonuses; without the ability hr could check nothing at all,
    // and nobody but org_admin could approve a payroll run.
    { action: ['read', 'request', 'approve'], subject: 'ApprovalRequest', scope: 'org' },
  ],

  branch_manager: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    // §6's catalog and stock-availability rows both say `org` for a branch
    // manager, and the reason is operational: a showroom needs to see that
    // another branch holds the size before it offers a transfer. Cost is kept
    // out by `serializeFor`, not by the scope.
    { action: 'read', subject: 'CostedItem', scope: 'org' },
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: ['read', 'request'], subject: 'StockAdjustment', scope: 'branch' },
    { action: ['read', 'create', 'update'], subject: 'Order', scope: 'branch' },
    { action: ['read', 'update'], subject: 'Customer', scope: 'branch' },
    { action: 'read', subject: 'FraudSignal', scope: 'branch' },
    { action: ['read', 'update'], subject: 'Wallet', scope: 'branch' },
    // §6: branch P&L without cost detail. The scope grants the report; the
    // COST_FIELDS strip is what keeps the cost out of it.
    { action: 'read', subject: 'LedgerReport', scope: 'branch' },
    // §6: "apply at POS", which is not editing the page.
    { action: 'read', subject: 'LandingPage', scope: 'branch' },
    { action: ['read', 'create', 'update'], subject: 'Employee', scope: 'branch' },
    { action: 'read', subject: 'Target', scope: 'branch' },
    { action: ['read', 'request', 'approve'], subject: 'ApprovalRequest', scope: 'branch' },
  ],

  warehouse: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'org' },
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: 'request', subject: 'StockAdjustment', scope: 'org' },
    // Qty-only supply drafts (D-005): create and update, never read cost.
    { action: ['create', 'update'], subject: 'Supply', scope: 'org' },
    { action: ['read', 'update'], subject: 'Order', scope: 'org' },
    { action: 'read', subject: 'Employee', scope: 'own' },
    // Same as sales: raising a request you cannot then see is not a workflow.
    { action: ['read', 'request'], subject: 'ApprovalRequest', scope: 'own' },
  ],

  reseller: [
    // The reseller's catalog view is an allow-list of fields, applied by
    // `serializeFor` on top of this rule (RESELLER_VISIBLE_FIELDS).
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'org' },
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: ['read', 'create'], subject: 'Order', scope: 'own' },
    { action: 'read', subject: 'Customer', scope: 'own' },
    { action: 'read', subject: 'FraudSignal', scope: 'own' },
    { action: 'read', subject: 'ResellerAdmin', scope: 'own' },
  ],

  investor: [{ action: 'read', subject: 'Investor', scope: 'own' }],
};
