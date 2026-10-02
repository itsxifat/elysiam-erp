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
    // D-073: a relaxed threshold needs a second org admin.
    'threshold_change',
    // M25: owners' money. Both are in SERVER_DERIVED_AMOUNT_TYPES, so no threshold
    // can auto-approve one however small it is.
    'investor_distribution',
    'investor_withdrawal',
    // M26: repaying a company loan (D-298).
    'loan_repayment',
  ],
  // §6: payments.
  /*
   * §6's cell is one word: **"payments"**. Every entry has to be money leaving
   * the company, and this list is the whole of the interpretation.
   *
   * `closing_variance` was here and should not have been. A daily closing
   * variance is a till reconciliation — §6's maker-checker list names it
   * separately from "supplier payments above the threshold" — and it belongs
   * to org_admin and to the branch checker under threshold. Two things
   * followed, and the second is worse: `accounts` holds create and update on
   * `Wallet` at org scope, so the team booking the cash entry also approved the
   * shortfall at any amount; and a caller holding `branch_manager` *and*
   * `accounts` came out uncapped on the one type where the branch is the till.
   */
  accounts: [
    'supplier_payment',
    'settlement_posting',
    'reseller_payout_batch',
    // Money leaving to an owner is still a payment, which is the whole of §6's cell.
    // A *distribution* is not: declaring profit is an equity decision, not a payment,
    // so it stays with org_admin.
    'investor_withdrawal',
    // M26: a loan instalment repaid is a payment, the whole of §6's cell (D-298).
    'loan_repayment',
  ],
  // §6: payroll.
  hr: ['payroll_run', 'bonus_rule'],
  // §6: branch items. Stock and till, not money leaving the company.
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
 * Which approval types each role may *raise* (D-072).
 *
 * The maker side needed the same narrowing the checker side got. With only
 * `request ApprovalRequest`, any requester could raise any type — a sales
 * agent a payroll run, a warehouse hand a supplier payment — and choose its
 * amount. Read from §6's capability rows:
 *
 * - accounts: payments, settlements, wallets, payroll posting, closing
 *   variances, back-dated entries, and asking to reopen a period (§7).
 * - hr: payroll and bonuses.
 * - branch_manager: stock adjustments (request, branch), own branch wallets,
 *   closing variances.
 * - warehouse: stock adjustments (request).
 * - org_admin: all of the above.
 *
 * `threshold_change` is in nobody's list: it is raised only by
 * `PUT /v1/approvals/thresholds`, never through the generic route.
 */
export const REQUESTER_TYPES: Readonly<Record<MembershipRole, readonly string[]>> = {
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
    'period_reopen',
    'investor_distribution',
    'investor_withdrawal',
    'loan_repayment',
  ],
  accounts: [
    'wallet_adjustment',
    'supplier_payment',
    'settlement_posting',
    'closing_variance',
    'back_dated_entry',
    'payroll_run',
    'reseller_payout_batch',
    'period_reopen',
    'investor_distribution',
    'investor_withdrawal',
    'loan_repayment',
  ],
  hr: ['payroll_run', 'bonus_rule'],
  branch_manager: ['stock_write_off', 'stock_gain', 'closing_variance', 'wallet_adjustment'],
  warehouse: ['stock_write_off', 'stock_gain'],
  sales: [],
  marketing: [],
  reseller: [],
  investor: [],
};

/** May these roles raise a request of this type through the generic route? */
export function canRequestType(
  roles: readonly MembershipRole[],
  type: string,
  isSuperAdmin: boolean,
): boolean {
  if (type === 'threshold_change') return false;
  if (isSuperAdmin) return true;
  return roles.some((role) => (REQUESTER_TYPES[role] ?? []).includes(type));
}

/**
 * Roles whose checker authority is branch-tier: §6 gives branch_manager "branch
 * items **under threshold**", which is narrower than the type list alone.
 */
export const BRANCH_TIER_CHECKERS: readonly MembershipRole[] = ['branch_manager'];

/**
 * At what tier may these roles decide a request of this type?
 *
 * - `org`    — some role that is not branch-tier may decide it (or super admin),
 *              at any amount and for any branch in the org.
 * - `branch` — only a branch-tier role may. The service then also requires the
 *              request to belong to one of the checker's branches and to sit
 *              under the org's configured threshold for its type (§6).
 * - `null`   — nobody holding these roles may decide it.
 */
export function checkerTier(
  roles: readonly MembershipRole[],
  type: string,
  isSuperAdmin: boolean,
): 'org' | 'branch' | null {
  if (isSuperAdmin) return 'org';

  let tier: 'org' | 'branch' | null = null;
  for (const role of roles) {
    if (!(CHECKER_TYPES[role] ?? []).includes(type)) continue;
    if (!BRANCH_TIER_CHECKERS.includes(role)) return 'org';
    tier = 'branch';
  }
  return tier;
}

export const MATRIX: Readonly<Record<MembershipRole, readonly Rule[]>> = {
  org_admin: [
    { action: ['read', 'create', 'update', 'delete'], subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'Cost', scope: 'org' },
    { action: ['read', 'create', 'update', 'delete'], subject: 'CostedItem', scope: 'org' },
    /*
     * Read only, and no `update Stock` for anybody.
     *
     * §6's row is "Stock availability" — a read. Changing stock is the next
     * row down, and it is `StockAdjustment`. A bare `update Stock` grant
     * contradicts invariant 3, which says stock changes only through inventory
     * movements: the permission described a path that must not exist, and M07
     * would have found a rule inviting it to build one.
     */
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: ['read', 'request', 'approve'], subject: 'StockAdjustment', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Supply', scope: 'org' },
    { action: ['read', 'create', 'update', 'delete'], subject: 'Order', scope: 'org' },
    { action: ['read', 'update'], subject: 'Customer', scope: 'org' },
    { action: 'export', subject: 'BuyerExport', scope: 'org' },
    { action: ['read', 'update'], subject: 'Wallet', scope: 'org' },
    { action: 'read', subject: 'LedgerReport', scope: 'org' },
    // §7: org_admin or accounts closes a period; reopening goes through a
    // period_reopen request only super_admin decides (D-083).
    { action: ['read', 'update'], subject: 'LedgerPeriod', scope: 'org' },
    { action: ['read', 'update'], subject: 'CourierSettlement', scope: 'org' },
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
    // §6 "users, roles, settings": org_admin only. A threshold is the setting
    // that decides whether maker-checker applies at all, so a checker who could
    // raise it could exempt their own team's requests.
    { action: ['read', 'update'], subject: 'ApprovalThreshold', scope: 'org' },
    { action: 'read', subject: 'AuditLog', scope: 'org' },
    /*
     * The one cross-org grant an ordinary role holds, and §18 is explicit
     * about why it is not a tenancy hole: org admins see other orgs'
     * **normalized metrics and ranks only**, never raw financials (D-023),
     * read through `erp_analytics` (§5 exception 2), carrying no money at all.
     * The matrix test allows exactly this cell by name and fails on any other
     * `all` scope.
     */
    { action: 'read', subject: 'Leaderboard', scope: 'all' },
    // M24 (D-325): the brand's own dashboard, and recomputing its rollups.
    { action: ['read', 'update'], subject: 'Dashboard', scope: 'org' },
    /*
     * §22's files. The grant is coarse and the row check is not (D-115).
     *
     * Everyone with a desk uploads and downloads something, so withholding the
     * ability would break ordinary work; granting it at `org` would, on its
     * own, hand every staff role every payslip in the brand. What actually
     * bounds a download is the file's `purpose`, which the files service maps
     * back onto the subject the document is about — a payslip needs
     * `read Payroll`, a KYC scan `read Employee`, an invoice `read
     * LedgerReport`. This rule only opens the door.
     */
    { action: ['read', 'create', 'update', 'delete'], subject: 'FileObject', scope: 'org' },
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
    { action: ['read', 'create', 'update'], subject: 'Wallet', scope: 'org' },
    { action: 'read', subject: 'LedgerReport', scope: 'org' },
    { action: ['read', 'update'], subject: 'LedgerPeriod', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'CourierSettlement', scope: 'org' },
    // §6's cell is "spend entry", not the campaigns row. As `create Campaign`
    // it let the finance team launch a brand's campaigns.
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
    /*
     * §22's files. The grant is coarse and the row check is not (D-115).
     *
     * Everyone with a desk uploads and downloads something, so withholding the
     * ability would break ordinary work; granting it at `org` would, on its
     * own, hand every staff role every payslip in the brand. What actually
     * bounds a download is the file's `purpose`, which the files service maps
     * back onto the subject the document is about — a payslip needs
     * `read Payroll`, a KYC scan `read Employee`, an invoice `read
     * LedgerReport`. This rule only opens the door.
     */
    { action: ['read', 'create'], subject: 'FileObject', scope: 'org' },
  ],

  sales: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'org' },
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Order', scope: 'own' },
    { action: ['read', 'create', 'update'], subject: 'Customer', scope: 'own' },
    // §6 says "apply codes", not edit pages. `update LandingPage` would have let
    // a sales agent rewrite a brand's storefront; applying a promo code is an
    // Order concern and is covered by the Order rules above.
    { action: 'read', subject: 'LandingPage', scope: 'org' },
    { action: 'read', subject: 'Employee', scope: 'own' },
    { action: 'read', subject: 'Target', scope: 'own' },
    // No `request ApprovalRequest`: §6 gives sales no action that goes through
    // maker-checker, and REQUESTER_TYPES lists none (D-072).
    /*
     * §22's files. The grant is coarse and the row check is not (D-115).
     *
     * Everyone with a desk uploads and downloads something — an order desk
     * agent attaches the customer's bKash screenshot — so withholding the
     * ability would break ordinary work; granting it at `org` would, on its
     * own, hand every staff role every payslip in the brand. What actually
     * bounds a download is the file's `purpose`, which the files service maps
     * back onto the subject the document is about. This rule only opens the
     * door.
     */
    { action: ['read', 'create'], subject: 'FileObject', scope: 'org' },
  ],

  marketing: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'org' },
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: 'read', subject: 'Order', scope: 'org' },
    { action: ['read', 'update'], subject: 'Customer', scope: 'org' },
    { action: 'export', subject: 'BuyerExport', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Campaign', scope: 'org' },
    /*
     * Marketing keeps ad spend, and splitting the subject nearly took it away.
     *
     * §6's cell is `org` for the *whole* row — "Campaigns, ad spend, leads" —
     * so marketing owns the spend figure as much as the campaign. The split
     * exists because the **accounts** cell is narrower than its row ("spend
     * entry"); narrowing marketing's too would leave the team that owns CPO,
     * CPDO and ROAS (§11) unable to read the input to them.
     */
    { action: ['read', 'create', 'update'], subject: 'CampaignSpend', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'LandingPage', scope: 'org' },
    { action: 'read', subject: 'Employee', scope: 'own' },
    { action: 'read', subject: 'Target', scope: 'own' },
    /*
     * §22's files. The grant is coarse and the row check is not (D-115).
     *
     * Everyone with a desk uploads and downloads something, so withholding the
     * ability would break ordinary work; granting it at `org` would, on its
     * own, hand every staff role every payslip in the brand. What actually
     * bounds a download is the file's `purpose`, which the files service maps
     * back onto the subject the document is about — a payslip needs
     * `read Payroll`, a KYC scan `read Employee`, an invoice `read
     * LedgerReport`. This rule only opens the door.
     */
    { action: ['read', 'create'], subject: 'FileObject', scope: 'org' },
  ],

  hr: [
    { action: ['read', 'create', 'update'], subject: 'Employee', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Payroll', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Target', scope: 'org' },
    // §6 makes hr the checker for payroll. CHECKER_TYPES is what narrows this
    // to payroll and bonuses; without the ability hr could check nothing at all,
    // and nobody but org_admin could approve a payroll run.
    { action: ['read', 'request', 'approve'], subject: 'ApprovalRequest', scope: 'org' },
    /*
     * §22's files. The grant is coarse and the row check is not (D-115).
     *
     * Everyone with a desk uploads and downloads something, so withholding the
     * ability would break ordinary work; granting it at `org` would, on its
     * own, hand every staff role every payslip in the brand. What actually
     * bounds a download is the file's `purpose`, which the files service maps
     * back onto the subject the document is about — a payslip needs
     * `read Payroll`, a KYC scan `read Employee`, an invoice `read
     * LedgerReport`. This rule only opens the door.
     */
    { action: ['read', 'create'], subject: 'FileObject', scope: 'org' },
  ],

  branch_manager: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'branch' },
    /*
     * §6's catalog and stock-availability rows both say `org` for a branch
     * manager, and the reason is operational: a showroom needs to see that
     * another branch holds the size before it offers a transfer. Cost is kept
     * out by `serializeFor`, not by the scope.
     */
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: ['read', 'request'], subject: 'StockAdjustment', scope: 'branch' },
    { action: ['read', 'create', 'update'], subject: 'Order', scope: 'branch' },
    { action: ['read', 'update'], subject: 'Customer', scope: 'branch' },
    { action: ['read', 'update'], subject: 'Wallet', scope: 'branch' },
    // §6: branch P&L without cost detail. The scope grants the report; the
    // COST_FIELDS strip is what keeps the cost out of it.
    { action: 'read', subject: 'LedgerReport', scope: 'branch' },
    // §6: "apply at POS", which is not editing the page.
    { action: 'read', subject: 'LandingPage', scope: 'branch' },
    { action: ['read', 'create', 'update'], subject: 'Employee', scope: 'branch' },
    { action: 'read', subject: 'Target', scope: 'branch' },
    { action: ['read', 'request', 'approve'], subject: 'ApprovalRequest', scope: 'branch' },
    /*
     * §22's files. The grant is coarse and the row check is not (D-115).
     *
     * Everyone with a desk uploads and downloads something, so withholding the
     * ability would break ordinary work; granting it at `org` would, on its
     * own, hand every staff role every payslip in the brand. What actually
     * bounds a download is the file's `purpose`, which the files service maps
     * back onto the subject the document is about — a payslip needs
     * `read Payroll`, a KYC scan `read Employee`, an invoice `read
     * LedgerReport`. This rule only opens the door.
     */
    { action: ['read', 'create'], subject: 'FileObject', scope: 'org' },
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
    { action: 'request', subject: 'ApprovalRequest', scope: 'org' },
    /*
     * §22's files. The grant is coarse and the row check is not (D-115).
     *
     * Everyone with a desk uploads and downloads something, so withholding the
     * ability would break ordinary work; granting it at `org` would, on its
     * own, hand every staff role every payslip in the brand. What actually
     * bounds a download is the file's `purpose`, which the files service maps
     * back onto the subject the document is about — a payslip needs
     * `read Payroll`, a KYC scan `read Employee`, an invoice `read
     * LedgerReport`. This rule only opens the door.
     */
    { action: ['read', 'create'], subject: 'FileObject', scope: 'org' },
  ],

  reseller: [
    // The reseller's catalog view is an allow-list of fields, applied by
    // `serializeFor` on top of this rule (RESELLER_VISIBLE_FIELDS).
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'org' },
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: ['read', 'create'], subject: 'Order', scope: 'own' },
    { action: 'read', subject: 'Customer', scope: 'own' },
    { action: 'read', subject: 'ResellerAdmin', scope: 'own' },
    /*
     * `own`, not `org`. A reseller uploads their trade licence and their
     * NID and downloads their own commission statements; there is nothing
     * in the brand's file store they have any business reading. The scope
     * is applied by the handler as `owner_user_id = me`, so it is a WHERE
     * clause rather than a promise (D-115).
     */
    { action: ['read', 'create'], subject: 'FileObject', scope: 'own' },
  ],

  investor: [
    { action: 'read', subject: 'Investor', scope: 'own' },
    /*
     * Read-only and `own`: §15 gives an investor their own statements and
     * nothing else, and they upload nothing. No `create`, so the upload
     * route refuses them at the guard rather than at the row.
     */
    { action: 'read', subject: 'FileObject', scope: 'own' },
  ],
};
