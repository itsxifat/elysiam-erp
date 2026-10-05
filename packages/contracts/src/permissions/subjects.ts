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
  /**
   * The brand's website, run from its ERP (M33, D-508): its settings, hero slides, menu,
   * size charts, the products' and categories' website fields, and the site keys the
   * website reads the catalog with. org_admin and marketing manage it; sales reads it, to
   * answer a shopper about what the site shows. Not a row in §6's grid, which predates the
   * website moving into the ERP (D-469).
   */
  'Storefront',
  /**
   * The website's payment gateway and email server credentials (M34, D-528): where shoppers'
   * money goes and where password-reset links are sent from. org_admin only: a marketing
   * user who could point SSLCommerz at another store, or the email server at their own,
   * could take shoppers' money or their accounts. Showing that they are set up is
   * `read Storefront`; the secrets are never shown to anyone.
   */
  'WebsiteCredentials',
  /**
   * A branch's own record (M39a, D-633): renaming it and switching it off once nothing runs
   * there any more. §6's "users, roles, settings" cell, so org_admin only. Branches are never
   * deleted: from the first day ledger lines, wallets and staff name them. Reading the branch
   * dashboards stays `read LedgerReport`.
   */
  'Branch',
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

/**
 * Every field the storefront API may send to the brand's website (M33, D-506).
 *
 * The website is outside the ERP: its server holds a site key, and whatever reaches it can
 * reach a shopper's browser. So its responses go through an allow-list stricter than the
 * reseller's: **every key at every depth** must be named here (`serializeForStorefront`),
 * not only the top-level ones. A field added to a payload and forgotten here disappears from
 * the response (a test notices) rather than reaching the internet. The cost deny-list runs
 * after it as well, so a cost field could not pass even if somebody listed it.
 */
export const STOREFRONT_VISIBLE_FIELDS = [
  // envelopes and paging
  'items',
  'nextCursor',
  'total',
  'page',
  'limit',
  'product',
  'redirect',
  'sizeChart',
  'site',
  // identity and words
  'id',
  'slug',
  'name',
  'label',
  'kind',
  'description',
  'text',
  'alt',
  'position',
  // the product card and page
  'category',
  'gender',
  'tags',
  'featured',
  'newArrival',
  'price',
  'min',
  'max',
  'compareAt',
  'onSale',
  'image',
  'images',
  'sizes',
  'inStock',
  'material',
  'careInstructions',
  'seoTitle',
  'seoDescription',
  'breadcrumb',
  'variants',
  'skuId',
  'sku',
  'size',
  'colour',
  'attributes',
  'value',
  'availableQty',
  'related',
  'children',
  'subcategories',
  // money, as poisha and taka strings
  'poisha',
  'taka',
  // images
  'width',
  'height',
  'urls',
  'thumb',
  'card',
  'full',
  // size charts
  'columns',
  'rows',
  // the site: info, social, announcement, promo, testimonials, hero, menu
  'logo',
  'whatsapp',
  'phone',
  'email',
  'address',
  'social',
  'facebook',
  'instagram',
  'tiktok',
  'youtube',
  'announcement',
  'enabled',
  'link',
  'promoBanner',
  'headline',
  'subtext',
  'note',
  'decorativeText',
  'primaryLabel',
  'primaryHref',
  'secondaryLabel',
  'secondaryHref',
  'testimonials',
  'location',
  'rating',
  'hero',
  'desktop',
  'mobile',
  'menu',
  'href',
  'highlighted',
  // shipping and payment
  'shipping',
  'freeShippingEnabled',
  'freeShippingThreshold',
  'zones',
  'inside_dhaka',
  'suburbs',
  'outside_dhaka',
  'fee',
  'payments',
  'cod',
  'sslcommerz',
  // geography for the checkout's address pickers
  'nameEn',
  'nameBn',
  'districtId',
  'divisionId',
  // M34: the cart quote and the checkout (D-520, D-521)
  'quote',
  'lines',
  'qty',
  'unitPrice',
  'lineTotal',
  'flashSale',
  'unavailable',
  'variantId',
  'reason',
  'discounts',
  'code',
  'title',
  'automatic',
  'amount',
  'deliveryAmount',
  'codes',
  'applied',
  'discount',
  'delivery',
  'deliveryDiscount',
  'deliverable',
  'zone',
  'freeShipping',
  'order',
  'orderNo',
  'status',
  'viewToken',
  'payment',
  'method',
  'required',
  // M34: shopper accounts (D-522)
  'account',
  'accountId',
  'requiresVerification',
  'emailVerified',
  'locale',
  'hasPassword',
  'googleLinked',
  'addresses',
  'createdAt',
  'thanaId',
  'area',
  'addressLine',
  'isDefault',
  'created',
  'ok',
  // M34: the shopper's view of an order (D-524)
  'placedAt',
  'statusLabel',
  'en',
  'bn',
  'itemCount',
  'paymentMethod',
  'confirmedAt',
  'shippedAt',
  'deliveredAt',
  'cancelledAt',
  'paid',
  'dueOnDelivery',
  'paidOnline',
  'shipTo',
  'district',
  'thana',
  'tracking',
  'courier',
  'trackingCode',
  // M34: SSLCommerz (D-525)
  'gatewayUrl',
  'tranId',
  'expiresAt',
  // M34: flash sales (D-548)
  'subtitle',
  'startsAt',
  'endsAt',
  'showOnHome',
  'banner',
  'unitsLeft',
  // M35b: campaign links (D-551)
  'customLink',
  'basePath',
  'bgColor',
  'textColor',
  'modal',
  'type',
  'ctaText',
  'ctaLink',
  'highlightProducts',
  // M35b: tracking (D-552): the client-safe config and the events' answers
  'meta',
  'pixelEnabled',
  'pixelId',
  'ga4',
  'clientEnabled',
  'measurementId',
  'proxy',
  'metaScriptPath',
  'metaCollectPath',
  'ga4ScriptPath',
  'ga4CollectPath',
  'testMode',
  'events',
  'client',
  'results',
  'eventId',
] as const;

export type CostField = (typeof COST_FIELDS)[number];
