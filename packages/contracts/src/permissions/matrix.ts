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
  /** Fields this rule does NOT grant. Absent means the whole row. */
  readonly except?: readonly string[];
}

/**
 * Cost is a capability, not a subject: `read:cost` in §6's wording. These are
 * the roles that hold it, and `serializeFor` strips COST_FIELDS for everyone
 * else regardless of what else they may read.
 */
export const COST_READING_ROLES: readonly MembershipRole[] = ['org_admin', 'accounts'];

export const MATRIX: Readonly<Record<MembershipRole, readonly Rule[]>> = {
  org_admin: [
    { action: ['read', 'create', 'update', 'delete'], subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'Cost', scope: 'org' },
    { action: ['read', 'create', 'update', 'delete'], subject: 'CostedItem', scope: 'org' },
    { action: ['read', 'update'], subject: 'Stock', scope: 'org' },
    { action: ['read', 'request', 'approve'], subject: 'StockAdjustment', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Supply', scope: 'org' },
    { action: ['read', 'create', 'update', 'delete'], subject: 'Order', scope: 'org' },
    { action: ['read', 'update'], subject: 'Customer', scope: 'org' },
    { action: 'export', subject: 'BuyerExport', scope: 'org' },
    { action: 'read', subject: 'FraudSignal', scope: 'org' },
    { action: 'update', subject: 'FraudOverride', scope: 'org' },
    { action: ['read', 'update'], subject: 'Wallet', scope: 'org' },
    { action: 'read', subject: 'LedgerReport', scope: 'org' },
    { action: ['read', 'update'], subject: 'CourierSettlement', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Campaign', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'LandingPage', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Employee', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Target', scope: 'org' },
    { action: ['read', 'update'], subject: 'ResellerAdmin', scope: 'org' },
    { action: 'read', subject: 'Investor', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'CompanyLoan', scope: 'org' },
    { action: ['read', 'create', 'update', 'delete'], subject: 'User', scope: 'org' },
    { action: ['read', 'request', 'approve'], subject: 'ApprovalRequest', scope: 'org' },
    { action: 'read', subject: 'AuditLog', scope: 'org' },
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
    { action: 'create', subject: 'Campaign', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Employee', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'ResellerAdmin', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Investor', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'CompanyLoan', scope: 'org' },
    // §6's matrix gives accounts approvals over payments specifically.
    { action: ['read', 'request', 'approve'], subject: 'ApprovalRequest', scope: 'org' },
  ],

  sales: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'org', except: ['unitCostPoisha'] },
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: ['read', 'create', 'update'], subject: 'Order', scope: 'own' },
    { action: ['read', 'create', 'update'], subject: 'Customer', scope: 'own' },
    { action: 'read', subject: 'FraudSignal', scope: 'org' },
    { action: 'update', subject: 'LandingPage', scope: 'org' },
    { action: 'read', subject: 'Employee', scope: 'own' },
    { action: 'read', subject: 'Target', scope: 'own' },
    { action: 'request', subject: 'ApprovalRequest', scope: 'org' },
  ],

  marketing: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'org', except: ['unitCostPoisha'] },
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
    { action: ['read', 'create', 'update'], subject: 'Target', scope: 'org' },
    { action: ['read', 'request'], subject: 'ApprovalRequest', scope: 'org' },
  ],

  branch_manager: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'branch', except: ['unitCostPoisha'] },
    { action: 'read', subject: 'Stock', scope: 'branch' },
    { action: ['read', 'request'], subject: 'StockAdjustment', scope: 'branch' },
    { action: ['read', 'create', 'update'], subject: 'Order', scope: 'branch' },
    { action: ['read', 'update'], subject: 'Customer', scope: 'branch' },
    { action: 'read', subject: 'FraudSignal', scope: 'branch' },
    { action: ['read', 'update'], subject: 'Wallet', scope: 'branch' },
    // §6: branch P&L without cost detail. The scope grants the report; the
    // COST_FIELDS strip is what keeps the cost out of it.
    { action: 'read', subject: 'LedgerReport', scope: 'branch' },
    { action: 'update', subject: 'LandingPage', scope: 'branch' },
    { action: ['read', 'create', 'update'], subject: 'Employee', scope: 'branch' },
    { action: 'read', subject: 'Target', scope: 'branch' },
    { action: ['read', 'request', 'approve'], subject: 'ApprovalRequest', scope: 'branch' },
  ],

  warehouse: [
    { action: 'read', subject: 'Catalog', scope: 'org' },
    { action: 'read', subject: 'CostedItem', scope: 'org', except: ['unitCostPoisha'] },
    { action: 'read', subject: 'Stock', scope: 'org' },
    { action: 'request', subject: 'StockAdjustment', scope: 'org' },
    // Qty-only supply drafts (D-005): create and update, never read cost.
    { action: ['create', 'update'], subject: 'Supply', scope: 'org' },
    { action: ['read', 'update'], subject: 'Order', scope: 'org' },
    { action: 'read', subject: 'Employee', scope: 'own' },
    { action: 'request', subject: 'ApprovalRequest', scope: 'org' },
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
