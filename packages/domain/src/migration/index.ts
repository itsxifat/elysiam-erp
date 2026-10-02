/**
 * Data migration and opening balances (M14a; architecture §7, §8).
 *
 * Six importers, each a pure review of a parsed CSV against what the database already
 * holds, plus the opening trial balance computed from the staged rows and the anonymiser
 * that seeds the training org. Nothing here touches a database: the server resolves the
 * references, calls these, and applies the result inside one transaction or not at all.
 */

export {
  canCommit,
  isMigrationKind,
  isStagedKind,
  MAX_OPENING_AMOUNT_POISHA,
  MIGRATION_KINDS,
  STAGED_KINDS,
  type ImportProblem,
  type MigrationKind,
  type Review,
} from './common.js';

export {
  MAX_OPENING_QTY,
  MAX_UNIT_COST_POISHA,
  OPENING_STOCK_OPTIONAL,
  OPENING_STOCK_REQUIRED,
  openingStockTotals,
  reviewOpeningStock,
  type OpeningStockRefs,
  type OpeningStockRow,
  type OpeningStockTotals,
} from './opening-stock.js';

export {
  COURIER_COD_OPTIONAL,
  COURIER_COD_REQUIRED,
  courierCodTotals,
  reviewCourierCod,
  reviewSupplierBalances,
  reviewWalletBalances,
  SUPPLIER_BALANCE_OPTIONAL,
  SUPPLIER_BALANCE_REQUIRED,
  supplierBalanceTotals,
  WALLET_BALANCE_OPTIONAL,
  WALLET_BALANCE_REQUIRED,
  walletBalanceTotals,
  type CourierCodRefs,
  type CourierCodRow,
  type CourierCodTotals,
  type SupplierBalanceKind,
  type SupplierBalanceRefs,
  type SupplierBalanceRow,
  type SupplierBalanceTotals,
  type WalletBalanceRefs,
  type WalletBalanceRow,
  type WalletBalanceTotals,
} from './balances.js';

export {
  openingPosition,
  type OpeningPosition,
  type OpeningPositionInput,
  type OpeningPositionLine,
  type OpeningSection,
} from './opening-position.js';

export {
  CUSTOMERS_OPTIONAL,
  CUSTOMERS_REQUIRED,
  MAX_HISTORY_COUNT,
  reviewCustomers,
  type CustomerImportRow,
  type CustomersRefs,
  type CustomersReview,
} from './customers.js';

export {
  reviewSkus,
  SKUS_OPTIONAL,
  SKUS_REQUIRED,
  type ImportProduct,
  type ImportSku,
  type SkusRefs,
  type SkusReview,
  type VariantAttributeRef,
} from './skus.js';

export {
  anonymizeTable,
  DEMO_MONEY_SCALE,
  DEMO_NAMES,
  demoName,
  demoPhone,
  scaleTaka,
  toCsv,
} from './anonymize.js';
