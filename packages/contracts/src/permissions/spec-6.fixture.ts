/**
 * §6's permission grid, frozen line by line. A test fixture, not code.
 *
 * The generated matrix suite reads `MATRIX` on both sides of its assertions —
 * it checks that CASL agrees with the matrix, which is worth checking and is
 * also a tautology about whether the matrix is *right*. Seven real deviations
 * from §6 lived in this repo under a fully green suite:
 *
 *   - `accounts` held create and update on `Employee`, where §6's cell reads
 *     "payroll posting and payment";
 *   - `accounts` could create campaigns, where the cell reads "spend entry";
 *   - `accounts` could check `closing_variance`, which is a till
 *     reconciliation and not a payment — and holding `branch_manager` too then
 *     lifted the branch amount cap on it;
 *   - a bare `update Stock` existed, which invariant 3 says must not;
 *   - `branch_manager` had stock availability at `branch`, where §6 says `org`;
 *   - `Leaderboard`, `CampaignSpend` and `Payroll` were not subjects at all,
 *     so three of §6's cells were governed by nothing.
 *
 * So this is the other side: one line per grant, grouped under §6's own row
 * and its cell text quoted verbatim, compared for set equality in both
 * directions. A permission cannot move without editing a file whose comments
 * say what the spec promised, and a reviewer can read the two together.
 *
 * **What kind of evidence this is.** The grants were read out of `MATRIX` and
 * then checked, subject by subject, against the table in `docs/architecture.md`
 * — it is a reviewed freeze, not a blind transcription, and it is worth
 * exactly that. What it buys is that the next change shows up as a diff beside
 * the sentence it has to satisfy.
 *
 * `super_admin` is absent for the same reason it is absent from `MATRIX`:
 * §5 exception 3 makes it a different question, answered by `manage all`.
 *
 * Format: `role|action|subject|scope`.
 */
export const SPEC_6_GRANTS: readonly string[] = [
  // | Catalog read (no cost) | org_admin org | sales org | accounts org | marketing org | hr — | branch_manager org | warehouse org | reseller limited fields | investor — |
  /*
   * `CostedItem` carries the same grant as `Catalog`: a catalog row with cost
   * columns on it. "No cost" is enforced by `serializeFor`, not by withholding
   * the read, and the reseller's "limited fields" is RESELLER_VISIBLE_FIELDS.
   */
  'accounts|read|Catalog|org',
  'branch_manager|read|Catalog|org',
  'marketing|read|Catalog|org',
  'org_admin|create|Catalog|org',
  'org_admin|delete|Catalog|org',
  'org_admin|read|Catalog|org',
  'org_admin|update|Catalog|org',
  'reseller|read|Catalog|org',
  'sales|read|Catalog|org',
  'warehouse|read|Catalog|org',
  'accounts|read|CostedItem|org',
  'branch_manager|read|CostedItem|branch',
  'marketing|read|CostedItem|org',
  'org_admin|create|CostedItem|org',
  'org_admin|delete|CostedItem|org',
  'org_admin|read|CostedItem|org',
  'org_admin|update|CostedItem|org',
  'reseller|read|CostedItem|org',
  'sales|read|CostedItem|org',
  'warehouse|read|CostedItem|org',

  // | Cost, WAC, stock value, margins | org_admin org | accounts org | rest — |
  /*
   * Mirrored by COST_READING_ROLES, which is what `serializeFor` reads.
   */
  'accounts|read|Cost|org',
  'org_admin|read|Cost|org',

  // | Stock availability | org_admin org | sales org | accounts org | marketing org | branch_manager org | warehouse org | reseller Beownz only |
  /*
   * Read only, for everybody. There is deliberately no `update Stock`:
   * invariant 3 says stock changes only through inventory movements, so the
   * next row down is the whole of it.
   */
  'accounts|read|Stock|org',
  'branch_manager|read|Stock|org',
  'marketing|read|Stock|org',
  'org_admin|read|Stock|org',
  'reseller|read|Stock|org',
  'sales|read|Stock|org',
  'warehouse|read|Stock|org',

  // | Stock adjust / transfer / count | org_admin org + approve | accounts read | branch_manager request (branch) | warehouse request |
  'accounts|read|StockAdjustment|org',
  'branch_manager|read|StockAdjustment|branch',
  'branch_manager|request|StockAdjustment|branch',
  'org_admin|approve|StockAdjustment|org',
  'org_admin|read|StockAdjustment|org',
  'org_admin|request|StockAdjustment|org',
  'warehouse|request|StockAdjustment|org',

  // | Supply entries, suppliers | org_admin org | accounts org | warehouse qty-only drafts |
  /*
   * Warehouse writes without reading, which is what "qty-only drafts" means
   * once supply lines carry prices (D-005).
   */
  'accounts|create|Supply|org',
  'accounts|read|Supply|org',
  'accounts|update|Supply|org',
  'org_admin|create|Supply|org',
  // M39a (D-630): a supplier nothing names is deleted, by org_admin only.
  'org_admin|delete|Supply|org',
  'org_admin|read|Supply|org',
  'org_admin|update|Supply|org',
  'warehouse|create|Supply|org',
  'warehouse|update|Supply|org',

  // | Orders | org_admin org | sales own + unassigned queue | accounts read | marketing read | branch_manager branch | warehouse pack, ship, returns | reseller own (portal) |
  'accounts|read|Order|org',
  'branch_manager|create|Order|branch',
  'branch_manager|read|Order|branch',
  'branch_manager|update|Order|branch',
  'marketing|read|Order|org',
  'org_admin|create|Order|org',
  'org_admin|delete|Order|org',
  'org_admin|read|Order|org',
  'org_admin|update|Order|org',
  'reseller|create|Order|own',
  'reseller|read|Order|own',
  'sales|create|Order|own',
  'sales|read|Order|own',
  'sales|update|Order|own',
  'warehouse|read|Order|org',
  'warehouse|update|Order|org',

  // | Customers, buyer history | org_admin org | sales customers of own orders | accounts read | marketing org | branch_manager branch | reseller own end customers |
  'accounts|read|Customer|org',
  'branch_manager|read|Customer|branch',
  'branch_manager|update|Customer|branch',
  'marketing|read|Customer|org',
  'marketing|update|Customer|org',
  'org_admin|read|Customer|org',
  'org_admin|update|Customer|org',
  'reseller|read|Customer|own',
  'sales|create|Customer|own',
  'sales|read|Customer|own',
  'sales|update|Customer|own',

  // | Buyer list export | org_admin org | marketing org | rest — |
  /*
   * A separate action because a list leaving the building is not a row read.
   */
  'marketing|export|BuyerExport|org',
  'org_admin|export|BuyerExport|org',

  // §6's two fraud rows (trust badge, block override) are gone: the owner removed the
  // fraud check from scope (D-291).

  // | Wallets, cash entries, petty cash | org_admin org | accounts org | branch_manager own branch wallets |
  'accounts|create|Wallet|org',
  'accounts|read|Wallet|org',
  'accounts|update|Wallet|org',
  'branch_manager|read|Wallet|branch',
  'branch_manager|update|Wallet|branch',
  'org_admin|read|Wallet|org',
  'org_admin|update|Wallet|org',

  // | Ledger reports, P&L, balance sheet | org_admin org | accounts org | branch_manager branch P&L without cost detail |
  /*
   * "without cost detail" is `serializeFor` again: branch_manager is not in
   * COST_READING_ROLES, so the report arrives with the cost columns gone.
   * `LedgerPeriod` is M03's: closing and reopening the books is the same
   * authority as the reports drawn from them.
   */
  'accounts|read|LedgerReport|org',
  'branch_manager|read|LedgerReport|branch',
  'org_admin|read|LedgerReport|org',
  'accounts|read|LedgerPeriod|org',
  'accounts|update|LedgerPeriod|org',
  'org_admin|read|LedgerPeriod|org',
  'org_admin|update|LedgerPeriod|org',

  // | Courier settlements | org_admin org | accounts org | rest — |
  'accounts|create|CourierSettlement|org',
  'accounts|read|CourierSettlement|org',
  'accounts|update|CourierSettlement|org',
  'org_admin|read|CourierSettlement|org',
  'org_admin|update|CourierSettlement|org',

  // | Campaigns, ad spend, leads | org_admin org | accounts spend entry | marketing org |
  /*
   * Two subjects, because the accounts cell is three words narrower than the
   * row. As one it let finance launch a brand's campaigns. Marketing keeps
   * both: its cell is `org` for the whole row, and §11 defines CPO, CPDO and
   * ROAS from the spend figure.
   */
  'marketing|create|Campaign|org',
  'marketing|read|Campaign|org',
  'marketing|update|Campaign|org',
  'org_admin|create|Campaign|org',
  // M39a (D-632): an ad campaign or SMS template that never ran is deleted, by org_admin only.
  'org_admin|delete|Campaign|org',
  'org_admin|read|Campaign|org',
  'org_admin|update|Campaign|org',
  'accounts|create|CampaignSpend|org',
  'accounts|read|CampaignSpend|org',
  'accounts|update|CampaignSpend|org',
  'marketing|create|CampaignSpend|org',
  'marketing|read|CampaignSpend|org',
  'marketing|update|CampaignSpend|org',
  'org_admin|create|CampaignSpend|org',
  'org_admin|read|CampaignSpend|org',
  'org_admin|update|CampaignSpend|org',

  // | Landing pages, promo codes | org_admin org | sales apply codes | marketing org | branch_manager apply at POS |
  /*
   * "apply codes" and "apply at POS" are reads: applying a promo code is an
   * Order concern. `update LandingPage` here would let a sales agent rewrite
   * a brand's storefront.
   */
  'branch_manager|read|LandingPage|branch',
  'marketing|create|LandingPage|org',
  'marketing|read|LandingPage|org',
  'marketing|update|LandingPage|org',
  'org_admin|create|LandingPage|org',
  // M39a (D-631): a discount or flash sale nobody used is deleted, by org_admin only.
  'org_admin|delete|LandingPage|org',
  'org_admin|read|LandingPage|org',
  'org_admin|update|LandingPage|org',
  'sales|read|LandingPage|org',

  // | Employees, attendance, payroll | org_admin org | sales own | accounts payroll posting and payment | marketing own | hr org | branch_manager branch staff | warehouse own |
  /*
   * Split into the people and the money. Accounts' cell is about payroll, and
   * as one subject it gave finance create and update over staff records.
   */
  'accounts|read|Employee|org',
  'branch_manager|create|Employee|branch',
  'branch_manager|read|Employee|branch',
  'branch_manager|update|Employee|branch',
  'hr|create|Employee|org',
  'hr|read|Employee|org',
  'hr|update|Employee|org',
  'marketing|read|Employee|own',
  'org_admin|create|Employee|org',
  'org_admin|read|Employee|org',
  'org_admin|update|Employee|org',
  'sales|read|Employee|own',
  'warehouse|read|Employee|own',
  'accounts|read|Payroll|org',
  'accounts|update|Payroll|org',
  'hr|create|Payroll|org',
  'hr|read|Payroll|org',
  'hr|update|Payroll|org',
  'org_admin|create|Payroll|org',
  'org_admin|read|Payroll|org',
  'org_admin|update|Payroll|org',

  // | Targets and bonus rules | org_admin org | sales own progress | marketing own progress | hr org | branch_manager branch progress |
  'branch_manager|read|Target|branch',
  'hr|create|Target|org',
  'hr|read|Target|org',
  'hr|update|Target|org',
  'marketing|read|Target|own',
  'org_admin|create|Target|org',
  'org_admin|read|Target|org',
  'org_admin|update|Target|org',
  'sales|read|Target|own',

  // | Reseller admin, payouts | org_admin Beownz org | accounts Beownz org | reseller own |
  /*
   * Kept although M21/M22 are dropped (D-075): the grants are built and inert,
   * and removing them would mean reopening §6, a database enum and the
   * serializer to delete working code.
   */
  'accounts|create|ResellerAdmin|org',
  'accounts|read|ResellerAdmin|org',
  'accounts|update|ResellerAdmin|org',
  'org_admin|read|ResellerAdmin|org',
  'org_admin|update|ResellerAdmin|org',
  'reseller|read|ResellerAdmin|own',

  // | Investors | org_admin org (read) | accounts org | investor own |
  'accounts|create|Investor|org',
  'accounts|read|Investor|org',
  'accounts|update|Investor|org',
  'investor|read|Investor|own',
  'org_admin|read|Investor|org',

  // | Company loans | org_admin org | accounts org | rest — |
  'accounts|create|CompanyLoan|org',
  'accounts|read|CompanyLoan|org',
  'accounts|update|CompanyLoan|org',
  'org_admin|create|CompanyLoan|org',
  'org_admin|read|CompanyLoan|org',
  'org_admin|update|CompanyLoan|org',

  // | Approvals (as checker) | org_admin org | accounts payments | hr payroll | branch_manager branch items under threshold |
  /*
   * The ability gets a role to the endpoint. *Which* types it may decide is
   * CHECKER_TYPES, *which* it may raise is REQUESTER_TYPES, and *how much* is
   * BRANCH_TIER_CHECKERS — §6's cells here are narrower than any single
   * grant can express. `ApprovalThreshold` is the number behind all three.
   */
  'accounts|approve|ApprovalRequest|org',
  'accounts|read|ApprovalRequest|org',
  'accounts|request|ApprovalRequest|org',
  'branch_manager|approve|ApprovalRequest|branch',
  'branch_manager|read|ApprovalRequest|branch',
  'branch_manager|request|ApprovalRequest|branch',
  'hr|approve|ApprovalRequest|org',
  'hr|read|ApprovalRequest|org',
  'hr|request|ApprovalRequest|org',
  'org_admin|approve|ApprovalRequest|org',
  'org_admin|read|ApprovalRequest|org',
  'org_admin|request|ApprovalRequest|org',
  'warehouse|request|ApprovalRequest|org',
  'org_admin|read|ApprovalThreshold|org',
  'org_admin|update|ApprovalThreshold|org',

  // | Leaderboard | (removed by M31, D-471: a brand's ERP ranks no brands) |

  // | (not a row in the grid) | §18's org dashboard (M24, D-325) |
  /*
   * §6 has no dashboard row. The org dashboard puts the brand's revenue, gross profit,
   * cash and stock value on one screen, which is the org admin's; Super Admin holds it
   * through `manage all`. `update` is
   * recomputing the brand's rollups for a range.
   */
  'org_admin|read|Dashboard|org',
  'org_admin|update|Dashboard|org',

  // | Users, roles, settings | org_admin org | everyone else — |
  'org_admin|create|User|org',
  'org_admin|delete|User|org',
  'org_admin|read|User|org',
  'org_admin|update|User|org',

  // | (not a row in the grid) | §25 requires an audit trail and someone able to read it |
  'org_admin|read|AuditLog|org',

  /*
   * | (not a row in the grid) | §22's files |
   *
   * §6 has no files row, because nobody's job is "files": people attach a
   * payment screenshot to an order, upload a trade licence, download a
   * payslip. So this grant is deliberately coarse — it says who may use the
   * file endpoints at all — and the document-level question is answered
   * elsewhere, by mapping the file's `purpose` onto the subject it is really
   * about (a payslip needs `read Payroll`, a KYC scan `read Employee`). Both
   * halves are needed; either alone is wrong (D-115).
   *
   * `investor` gets read and no create: §15 gives them their own statements
   * and they upload nothing. `reseller` and `investor` are `own`, applied as
   * `owner_user_id = me`.
   */
  'accounts|create|FileObject|org',
  'accounts|read|FileObject|org',
  'branch_manager|create|FileObject|org',
  'branch_manager|read|FileObject|org',
  'hr|create|FileObject|org',
  'hr|read|FileObject|org',
  'investor|read|FileObject|own',
  'marketing|create|FileObject|org',
  'marketing|read|FileObject|org',
  'org_admin|create|FileObject|org',
  'org_admin|delete|FileObject|org',
  'org_admin|read|FileObject|org',
  'org_admin|update|FileObject|org',
  'reseller|create|FileObject|own',
  'reseller|read|FileObject|own',
  'sales|create|FileObject|org',
  'sales|read|FileObject|org',
  'warehouse|create|FileObject|org',
  'warehouse|read|FileObject|org',

  /*
   * | (not a row in the grid) | the brand's website, run from its ERP (M33, D-508) |
   *
   * §6 predates the website moving into the ERP (D-469). The website is marketing's work as
   * much as the landing pages are, so org_admin and marketing manage it; sales reads it, to
   * answer a shopper about what the site shows, and edits nothing.
   */
  'marketing|create|Storefront|org',
  'marketing|delete|Storefront|org',
  'marketing|read|Storefront|org',
  'marketing|update|Storefront|org',
  'org_admin|create|Storefront|org',
  'org_admin|delete|Storefront|org',
  'org_admin|read|Storefront|org',
  'org_admin|update|Storefront|org',
  'org_admin|read|WebsiteCredentials|org',
  'org_admin|update|WebsiteCredentials|org',
  'sales|read|Storefront|org',

  // | (not a row in the grid) | a branch's own record (M39a, D-633) |
  // §6's "users, roles, settings" cell: org_admin renames a branch or switches it off.
  'org_admin|read|Branch|org',
  'org_admin|update|Branch|org',

  // | (not a row in the grid) | the packing video (M38b, D-614) |
  // Evidence for a complaint about a parcel: org_admin and the warehouse across the brand,
  // sales for the orders in their own scope. The brand's recording setting is org_admin's.
  'org_admin|read|PackingVideo|org',
  'org_admin|update|PackingVideo|org',
  'sales|read|PackingVideo|own',
  'warehouse|read|PackingVideo|org',
];
