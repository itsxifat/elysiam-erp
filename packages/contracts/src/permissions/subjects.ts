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
  'CourierSettlement',
  'Campaign',
  'LandingPage',
  'Employee',
  'Target',
  'ResellerAdmin',
  'Investor',
  'CompanyLoan',
  /**
   * Ad spend, which is not a campaign.
   *
   * §6 gives accounts "spend entry" on the campaigns row and gives marketing
   * the row itself. Transcribed as one subject, that became `accounts may
   * create Campaign` — the finance team able to launch a brand's campaigns.
   * Two subjects is what the cell actually says.
   */
  'CampaignSpend',
  /**
   * Payroll, which is not an employee record.
   *
   * Same shape of error: §6's employees row gives accounts "payroll posting
   * and payment", and collapsing the row into `Employee` gave accounts create
   * and update on staff records. HR owns the people; accounts posts the money.
   */
  'Payroll',
  /** §6's "Users, roles, settings" row. Org configuration, thresholds included. */
  'Settings',
  /** §18's cross-org normalized ranking. See the `all` scope note below. */
  'Leaderboard',
] as const;

export type Subject = (typeof SUBJECTS)[number];

/**
 * How far a permission reaches.
 *
 * - `own`               — rows where `created_by` or `assigned_to` is the user
 * - `own_or_unassigned` — the above, plus rows nobody has been assigned yet
 * - `branch`            — rows whose `branch_id` is in the user's branch scope
 * - `org`               — the whole active org
 * - `all`               — every org. super_admin, plus §18's leaderboard.
 *
 * Ordered weakest to strongest, and `SCOPE_RANK` below depends on that order.
 *
 * `own_or_unassigned` exists because §6's orders cell for sales reads "own +
 * unassigned queue", and that queue is the COD workflow: orders arrive with no
 * agent on them and an agent claims one. Transcribed as plain `own` it made
 * the queue invisible, so the only way to work it would have been to widen the
 * rule to `org` — which hands every agent every other agent's orders. It is a
 * scope rather than a flag on the rule because `effectiveScope` has to be able
 * to rank it, and it sits exactly where it belongs: wider than `own`, and
 * narrower than a branch.
 */
export const SCOPES = ['own', 'own_or_unassigned', 'branch', 'org', 'all'] as const;
export type Scope = (typeof SCOPES)[number];

export const SCOPE_RANK: Readonly<Record<Scope, number>> = {
  own: 0,
  own_or_unassigned: 1,
  branch: 2,
  org: 3,
  all: 4,
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
