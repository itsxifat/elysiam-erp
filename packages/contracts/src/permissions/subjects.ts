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

  // M04
  /**
   * A stored file (§22): its row, not its bytes.
   *
   * Not a row in §6's grid, because §6 describes what people do and nobody's
   * job is "files" — they attach a payment screenshot to an order, upload a
   * trade licence, download a payslip. So the ability here is coarse on
   * purpose: it says whether a caller may use the file endpoints at all, and
   * *what* they may see is decided per row by the file's `purpose`, which maps
   * back onto the subject the document is really about (a payslip is Payroll, a
   * KYC scan is Employee, an invoice is LedgerReport).
   *
   * Collapsing the two into one grant is what would be wrong: a single
   * `read FileObject` at org scope would hand every staff role every payslip in
   * the brand, and every role legitimately needs to download *something*
   * (D-115).
   */
  'FileObject',

  // Named by §6's matrix; owned by later milestones.
  'Catalog',
  'Cost',
  'Stock',
  'StockAdjustment',
  'Supply',
  'Order',
  'Customer',
  'BuyerExport',
  'Wallet',
  'LedgerReport',
  /** Closing and reopening monthly periods (§7): org_admin and accounts (D-083). */
  'LedgerPeriod',
  'CourierSettlement',
  'Campaign',
  /**
   * Ad spend, which is not a campaign.
   *
   * §6 gives accounts "spend entry" on the campaigns row and gives marketing
   * the row itself. Transcribed as one subject that became `accounts may
   * create Campaign` — the finance team able to launch a brand's campaigns.
   * Two subjects is what the cell actually says. §11 defines CPO, CPDO and
   * ROAS from this number, so marketing keeps it too: their cell is `org` for
   * the whole row.
   */
  'CampaignSpend',
  'LandingPage',
  'Employee',
  /**
   * Payroll, which is not an employee record.
   *
   * Same shape of error: §6's employees row gives accounts "payroll posting
   * and payment", and collapsing the row into `Employee` handed finance create
   * and update over staff records. HR owns the people; accounts posts the
   * money.
   */
  'Payroll',
  'Target',
  /**
   * §18's org dashboard and its rollups (M24, D-325): org_admin at `org`. §6 has no row for it; the dashboard puts
   * revenue, cash and stock value side by side, which is the org admin's picture, and
   * every other role already has a dashboard of its own (marketing, accounts, the desk).
   * `update` is recomputing the brand's rollups for a range.
   */
  'Dashboard',
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
  /**
   * The cost a unit left stock at, carried on the order line so a return or an
   * exchange can put it back at the price it went out at rather than at today's
   * weighted average (M10). It is purchase cost by another name, so it is
   * withheld exactly like `unitCostPoisha` — an order desk that could read it
   * could derive the margin on every line it sells.
   */
  'dispatchUnitCostPoisha',
  'dispatch_unit_cost_poisha',
  /**
   * The cost a returned supply line was originally received at (M09). Same
   * reasoning: it is the supplier's price, reachable from a returns screen.
   */
  'originalUnitCostPoisha',
  'original_unit_cost_poisha',
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
