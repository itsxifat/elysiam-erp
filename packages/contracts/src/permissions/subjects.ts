/**
 * What a permission is *about* (architecture §6).
 *
 * Subjects are the nouns of the matrix and actions are its verbs. Both are
 * closed unions rather than strings: a typo in `can('raed', 'Order')` must be a
 * compile error, because at runtime it reads as "this role cannot do that" and
 * silently denies — or, in the mirror-image bug, a typo'd subject matches
 * nothing and a guard that checks it lets everything through.
 */

export const ACTIONS = [
  'read',
  'create',
  'update',
  'delete',
  /** Maker-checker: request the action, and decide on someone else's request. */
  'request',
  'approve',
  /** Reading a list is not reading a row: exports leave the building. */
  'export',
] as const;

export type Action = (typeof ACTIONS)[number];

/**
 * The subjects that exist today plus the ones §6's matrix names.
 *
 * Listed ahead of the modules that own them on purpose: the matrix is the
 * design, and a milestone that adds `Order` should be filling in a row that
 * already exists rather than inventing the policy as it goes.
 */
export const SUBJECTS = [
  // M02b
  'ApprovalRequest',
  /** Per-org approval thresholds: §6 "settings", org_admin only. */
  'ApprovalThreshold',
  'AuditLog',
  'User',
  'CostedItem',

  // Named by §6's matrix; owned by later milestones.
  'Catalog',
  'Cost',
  'Stock',
  'StockAdjustment',
  'Supply',
  'Order',
  'Customer',
  'BuyerExport',
  'FraudSignal',
  'FraudOverride',
  'Wallet',
  'LedgerReport',
  /** Closing and reopening monthly periods (§7): org_admin and accounts (D-083). */
  'LedgerPeriod',
  'CourierSettlement',
  'Campaign',
  'LandingPage',
  'Employee',
  'Target',
  'ResellerAdmin',
  'Investor',
  'CompanyLoan',
] as const;

export type Subject = (typeof SUBJECTS)[number];

/**
 * How far a permission reaches.
 *
 * - `own`     — rows where `created_by` or `assigned_to` is the user
 * - `branch`  — rows whose `branch_id` is in the user's branch scope
 * - `org`     — the whole active org
 * - `all`     — every org. super_admin only (§5 exception 3).
 *
 * Ordered weakest to strongest, and `SCOPE_RANK` below depends on that order.
 */
export const SCOPES = ['own', 'branch', 'org', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_RANK: Readonly<Record<Scope, number>> = {
  own: 0,
  branch: 1,
  org: 2,
  all: 3,
};

/**
 * Fields only a role with `read:cost` may see (§6, invariant 5).
 *
 * This list is the enforcement, not documentation of it: `serializeFor` strips
 * anything named here from every response, and the matrix test asserts the
 * absence. Adding a cost-bearing column to any table means adding its name
 * here, and `assertNoCostFields` is what fails when someone forgets.
 */
export const COST_FIELDS = [
  'unitCostPoisha',
  'unit_cost_poisha',
  'wacPoisha',
  'wac_poisha',
  'cogsPoisha',
  'cogs_poisha',
  'grossProfitPoisha',
  'gross_profit_poisha',
  'stockValuePoisha',
  'stock_value_poisha',
  'supplyLinePricePoisha',
  'supply_line_price_poisha',
  'supplierBalancePoisha',
  'supplier_balance_poisha',
] as const;

/**
 * The only catalog fields a reseller may see (§6).
 *
 * An allow-list rather than a deny-list, and the asymmetry is deliberate: cost
 * is a known set of columns to hide, but what a reseller may see is a much
 * smaller set than what exists, and a new column must default to hidden.
 */
export const RESELLER_VISIBLE_FIELDS = [
  'id',
  'skuId',
  'sku',
  'skuCode',
  'name',
  'images',
  'attributes',
  'resellerPricePoisha',
  'availableQty',
] as const;

export type CostField = (typeof COST_FIELDS)[number];
