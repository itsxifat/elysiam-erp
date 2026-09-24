/**
 * §6's permission grid, transcribed by hand. A test fixture, not code.
 *
 * The generated matrix suite reads `MATRIX` on both sides of its assertions —
 * it checks that CASL agrees with the matrix, which is worth checking and is
 * also a tautology about whether the matrix is *right*. Every one of the
 * following shipped green under it:
 *
 *   - `accounts` held create and update on `Employee`, where §6 gives that
 *     column "payroll posting and payment";
 *   - `accounts` could create campaigns, where §6 says "spend entry";
 *   - `sales` had no unassigned-order queue, which is the COD workflow;
 *   - `branch_manager` could approve a stock write-off of any size, where §6
 *     says "branch items **under threshold**";
 *   - `Settings` and `Leaderboard` were not subjects at all, so §6's last two
 *     rows were governed by nothing;
 *   - a bare `update Stock` existed, which invariant 3 says must not.
 *
 * So this is the other side: one line per grant, written from the markdown
 * table in `docs/architecture.md` rather than from the code, with §6's own
 * wording quoted above each block. The test asserts set equality, which means
 * a permission cannot be added, widened or dropped without editing a file
 * whose comments say what the spec actually promised — and a reviewer can read
 * the two together.
 *
 * `super_admin` is absent for the same reason it is absent from `MATRIX`:
 * §5 exception 3 makes it a different question, answered by `manage all`.
 *
 * Format: `role|action|subject|scope`.
 */
export const SPEC_6_GRANTS: readonly string[] = [
  // | Catalog read (no cost) | org_admin org | sales org | accounts org |
  //   marketing org | hr — | branch_manager org | warehouse org |
  //   reseller limited fields | investor — |
  //
  // `CostedItem` carries the same grant as `Catalog`: it is a catalog row with
  // cost columns on it, and "no cost" is enforced by `serializeFor`, not by
  // withholding the read. The reseller's "limited fields" is likewise a
  // serializer concern (RESELLER_VISIBLE_FIELDS), not a narrower scope.
  'org_admin|read|Catalog|org',
  'sales|read|Catalog|org',
  'accounts|read|Catalog|org',
  'marketing|read|Catalog|org',
  'branch_manager|read|Catalog|org',
  'warehouse|read|Catalog|org',
  'reseller|read|Catalog|org',
  'org_admin|read|CostedItem|org',
  'sales|read|CostedItem|org',
  'accounts|read|CostedItem|org',
  'marketing|read|CostedItem|org',
  'branch_manager|read|CostedItem|org',
  'warehouse|read|CostedItem|org',
  'reseller|read|CostedItem|org',

  // | Catalog write, prices | org_admin org | everyone else — |
  'org_admin|create|Catalog|org',
  'org_admin|update|Catalog|org',
  'org_admin|delete|Catalog|org',
  'org_admin|create|CostedItem|org',
  'org_admin|update|CostedItem|org',
  'org_admin|delete|CostedItem|org',

  // | Cost, WAC, stock value, margins | org_admin org | accounts org | rest — |
  // Mirrored by COST_READING_ROLES, which is what `serializeFor` reads.
  'org_admin|read|Cost|org',
  'accounts|read|Cost|org',

  // | Stock availability | org_admin org | sales org | accounts org |
  //   marketing org | hr — | branch_manager org | warehouse org |
  //   reseller Beownz only | investor — |
  //
  // Read only, for everybody. "Beownz only" is an org, and a reseller has a
  // membership in exactly that org. There is deliberately no `update Stock`:
  // invariant 3 says stock changes only through inventory movements, so the
  // next row down is the whole of it.
  'org_admin|read|Stock|org',
  'sales|read|Stock|org',
  'accounts|read|Stock|org',
  'marketing|read|Stock|org',
  'branch_manager|read|Stock|org',
  'warehouse|read|Stock|org',
  'reseller|read|Stock|org',

  // | Stock adjust / transfer / count | org_admin org + approve |
  //   accounts read | branch_manager request (branch) | warehouse request |
  'org_admin|read|StockAdjustment|org',
  'org_admin|request|StockAdjustment|org',
  'org_admin|approve|StockAdjustment|org',
  'accounts|read|StockAdjustment|org',
  'branch_manager|read|StockAdjustment|branch',
  'branch_manager|request|StockAdjustment|branch',
  'warehouse|request|StockAdjustment|org',

  // | Supply entries, suppliers | org_admin org | accounts org |
  //   warehouse qty-only drafts |
  //
  // Warehouse writes without reading, which is what "qty-only drafts" means
  // once supply lines carry prices (D-005): they enter quantities into a draft
  // they cannot read back, and accounts prices it.
  'org_admin|read|Supply|org',
  'org_admin|create|Supply|org',
  'org_admin|update|Supply|org',
  'accounts|read|Supply|org',
  'accounts|create|Supply|org',
  'accounts|update|Supply|org',
  'warehouse|create|Supply|org',
  'warehouse|update|Supply|org',

  // | Orders | org_admin org | sales own + unassigned queue | accounts read |
  //   marketing read | branch_manager branch | warehouse pack, ship, returns |
  //   reseller own (portal) |
  'org_admin|read|Order|org',
  'org_admin|create|Order|org',
  'org_admin|update|Order|org',
  'org_admin|delete|Order|org',
  'sales|read|Order|own_or_unassigned',
  'sales|create|Order|own_or_unassigned',
  'sales|update|Order|own_or_unassigned',
  'accounts|read|Order|org',
  'marketing|read|Order|org',
  'branch_manager|read|Order|branch',
  'branch_manager|create|Order|branch',
  'branch_manager|update|Order|branch',
  // "pack, ship, returns" are all status changes on an order that already
  // exists, so: read and update, never create or delete.
  'warehouse|read|Order|org',
  'warehouse|update|Order|org',
  'reseller|read|Order|own',
  'reseller|create|Order|own',

  // | Customers, buyer history | org_admin org |
  //   sales customers of own orders | accounts read | marketing org |
  //   branch_manager branch | reseller own end customers |
  'org_admin|read|Customer|org',
  'org_admin|update|Customer|org',
  'sales|read|Customer|own',
  'sales|create|Customer|own',
  'sales|update|Customer|own',
  'accounts|read|Customer|org',
  'marketing|read|Customer|org',
  'marketing|update|Customer|org',
  'branch_manager|read|Customer|branch',
  'branch_manager|update|Customer|branch',
  'reseller|read|Customer|own',

  // | Buyer list export | org_admin org | marketing org | rest — |
  // A separate action because a list leaving the building is not a row read.
  'org_admin|export|BuyerExport|org',
  'marketing|export|BuyerExport|org',

  // | Fraud trust badge and reasons | org_admin org | sales yes |
  //   accounts read | branch_manager branch | reseller badge on own orders |
  'org_admin|read|FraudSignal|org',
  'sales|read|FraudSignal|org',
  'accounts|read|FraudSignal|org',
  'branch_manager|read|FraudSignal|branch',
  'reseller|read|FraudSignal|own',

  // | Fraud block override | org_admin org | everyone else — |
  'org_admin|update|FraudOverride|org',

  // | Wallets, cash entries, petty cash | org_admin org | accounts org |
  //   branch_manager own branch wallets |
  'org_admin|read|Wallet|org',
  'org_admin|create|Wallet|org',
  'org_admin|update|Wallet|org',
  'accounts|read|Wallet|org',
  'accounts|create|Wallet|org',
  'accounts|update|Wallet|org',
  'branch_manager|read|Wallet|branch',
  'branch_manager|update|Wallet|branch',

  // | Ledger reports, P&L, balance sheet | org_admin org | accounts org |
  //   branch_manager branch P&L without cost detail |
  //
  // "without cost detail" is `serializeFor` again: branch_manager is not in
  // COST_READING_ROLES, so the report arrives with the cost columns gone.
  'org_admin|read|LedgerReport|org',
  'accounts|read|LedgerReport|org',
  'branch_manager|read|LedgerReport|branch',

  // | Courier settlements | org_admin org | accounts org | rest — |
  'org_admin|read|CourierSettlement|org',
  'org_admin|create|CourierSettlement|org',
  'org_admin|update|CourierSettlement|org',
  'accounts|read|CourierSettlement|org',
  'accounts|create|CourierSettlement|org',
  'accounts|update|CourierSettlement|org',

  // | Campaigns, ad spend, leads | org_admin org | accounts spend entry |
  //   marketing org |
  //
  // Two subjects, because the accounts cell is three words narrower than the
  // row. Transcribed as one, it let finance launch a brand's campaigns.
  'org_admin|read|Campaign|org',
  'org_admin|create|Campaign|org',
  'org_admin|update|Campaign|org',
  'marketing|read|Campaign|org',
  'marketing|create|Campaign|org',
  'marketing|update|Campaign|org',
  'org_admin|read|CampaignSpend|org',
  'org_admin|create|CampaignSpend|org',
  'org_admin|update|CampaignSpend|org',
  'accounts|read|CampaignSpend|org',
  'accounts|create|CampaignSpend|org',
  'accounts|update|CampaignSpend|org',

  // | Landing pages, promo codes | org_admin org | sales apply codes |
  //   marketing org | branch_manager apply at POS |
  //
  // "apply codes" and "apply at POS" are reads: applying a promo code is an
  // Order concern and is covered by the orders row. `update LandingPage` here
  // would have let a sales agent rewrite a brand's storefront.
  'org_admin|read|LandingPage|org',
  'org_admin|create|LandingPage|org',
  'org_admin|update|LandingPage|org',
  'sales|read|LandingPage|org',
  'marketing|read|LandingPage|org',
  'marketing|create|LandingPage|org',
  'marketing|update|LandingPage|org',
  'branch_manager|read|LandingPage|branch',

  // | Employees, attendance, payroll | org_admin org | sales own |
  //   accounts payroll posting and payment | marketing own | hr org |
  //   branch_manager branch staff | warehouse own |
  //
  // Split into the people and the money. Accounts' cell is about payroll, and
  // as one subject it gave finance create and update over staff records.
  'org_admin|read|Employee|org',
  'org_admin|create|Employee|org',
  'org_admin|update|Employee|org',
  'sales|read|Employee|own',
  'marketing|read|Employee|own',
  'warehouse|read|Employee|own',
  'accounts|read|Employee|org',
  'hr|read|Employee|org',
  'hr|create|Employee|org',
  'hr|update|Employee|org',
  'branch_manager|read|Employee|branch',
  'branch_manager|create|Employee|branch',
  'branch_manager|update|Employee|branch',
  'org_admin|read|Payroll|org',
  'org_admin|create|Payroll|org',
  'org_admin|update|Payroll|org',
  'hr|read|Payroll|org',
  'hr|create|Payroll|org',
  'hr|update|Payroll|org',
  // "posting and payment": accounts moves the money a run produced, and does
  // not author the run.
  'accounts|read|Payroll|org',
  'accounts|update|Payroll|org',

  // | Targets and bonus rules | org_admin org | sales own progress |
  //   marketing own progress | hr org | branch_manager branch progress |
  'org_admin|read|Target|org',
  'org_admin|create|Target|org',
  'org_admin|update|Target|org',
  'sales|read|Target|own',
  'marketing|read|Target|own',
  'hr|read|Target|org',
  'hr|create|Target|org',
  'hr|update|Target|org',
  'branch_manager|read|Target|branch',

  // | Reseller admin, payouts | org_admin Beownz org | accounts Beownz org |
  //   reseller own |
  'org_admin|read|ResellerAdmin|org',
  'org_admin|update|ResellerAdmin|org',
  'accounts|read|ResellerAdmin|org',
  'accounts|create|ResellerAdmin|org',
  'accounts|update|ResellerAdmin|org',
  'reseller|read|ResellerAdmin|own',

  // | Investors | org_admin org (read) | accounts org | investor own |
  'org_admin|read|Investor|org',
  'accounts|read|Investor|org',
  'accounts|create|Investor|org',
  'accounts|update|Investor|org',
  'investor|read|Investor|own',

  // | Company loans | org_admin org | accounts org | rest — |
  'org_admin|read|CompanyLoan|org',
  'org_admin|create|CompanyLoan|org',
  'org_admin|update|CompanyLoan|org',
  'accounts|read|CompanyLoan|org',
  'accounts|create|CompanyLoan|org',
  'accounts|update|CompanyLoan|org',

  // | Approvals (as checker) | org_admin org | accounts payments |
  //   hr payroll | branch_manager branch items under threshold |
  //
  // The ability gets a role as far as the endpoint. *Which* types it may
  // decide is CHECKER_TYPES, and *how much* is LIMITED_CHECKER_ROLES —
  // §6's cells here are narrower than any single grant can express, and
  // SPEC_6_CHECKERS below carries that half.
  'org_admin|read|ApprovalRequest|org',
  'org_admin|request|ApprovalRequest|org',
  'org_admin|approve|ApprovalRequest|org',
  'accounts|read|ApprovalRequest|org',
  'accounts|request|ApprovalRequest|org',
  'accounts|approve|ApprovalRequest|org',
  'hr|read|ApprovalRequest|org',
  'hr|request|ApprovalRequest|org',
  'hr|approve|ApprovalRequest|org',
  'branch_manager|read|ApprovalRequest|branch',
  'branch_manager|request|ApprovalRequest|branch',
  'branch_manager|approve|ApprovalRequest|branch',
  /*
   * The maker-checker list in §6 lets anyone raise a request; only deciding is
   * restricted, which is what the checker cells above are about. Sales and
   * warehouse raise and decide nothing — but they read their own, because a
   * request you cannot see the outcome of is not a workflow. Scoped `own`, so
   * the grant cannot become a way to read the org's pending payments.
   */
  'sales|read|ApprovalRequest|own',
  'sales|request|ApprovalRequest|own',
  'warehouse|read|ApprovalRequest|own',
  'warehouse|request|ApprovalRequest|own',

  // | Leaderboard | org_admin all orgs (normalized metrics only) | rest — |
  //
  // The only cross-org grant an ordinary role holds. §18 and D-023 bound it:
  // normalized metrics and ranks, never raw financials, read through
  // `erp_analytics` (§5 exception 2). The matrix test allows this one cell by
  // name and fails on any other `all`.
  'org_admin|read|Leaderboard|all',

  // | Users, roles, settings | org_admin org | everyone else — |
  'org_admin|read|User|org',
  'org_admin|create|User|org',
  'org_admin|update|User|org',
  'org_admin|delete|User|org',
  'org_admin|read|Settings|org',
  'org_admin|update|Settings|org',

  // Not a row in the grid: §25 requires an audit trail and someone has to be
  // able to read it. Org admin only, scoped to the org.
  'org_admin|read|AuditLog|org',
];

/**
 * §6's "Approvals (as checker)" cells, which no single grant can express.
 *
 * The row gives each role a *subset of types*, and branch_manager an amount
 * limit on top. `limited: true` means "branch items **under threshold**".
 */
export const SPEC_6_CHECKERS: Readonly<
  Record<string, { readonly types: readonly string[]; readonly limited: boolean }>
> = {
  // "org": every type §6 lists as maker-checker, except the one it reserves.
  org_admin: {
    types: [
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
      'fraud_override',
    ],
    limited: false,
  },
  // "payments": money leaving the company, in any of its forms.
  accounts: {
    types: [
      'supplier_payment',
      'settlement_posting',
      'reseller_payout_batch',
      'closing_variance',
      'investor_withdrawal',
      'investor_distribution',
    ],
    limited: false,
  },
  // "payroll".
  hr: { types: ['payroll_run', 'bonus_rule'], limited: false },
  // "branch items under threshold".
  branch_manager: {
    types: ['stock_write_off', 'stock_gain', 'closing_variance'],
    limited: true,
  },
  sales: { types: [], limited: false },
  marketing: { types: [], limited: false },
  warehouse: { types: [], limited: false },
  reseller: { types: [], limited: false },
  investor: { types: [], limited: false },
};

/**
 * `period_reopen` is in nobody's list, and that is how §7's "super_admin only"
 * is expressed: `canDecideType` short-circuits for a super admin, and every
 * other role falls through an empty membership test.
 */
export const SUPER_ADMIN_ONLY_APPROVAL_TYPES: readonly string[] = ['period_reopen'];
