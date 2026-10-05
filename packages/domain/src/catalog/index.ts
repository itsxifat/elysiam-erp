/**
 * Catalog domain rules (architecture §8, M06).
 *
 * Everything the catalog decides that is arithmetic or shape rather than
 * storage: how a SKU code is built, which SKUs a variant matrix is missing,
 * how a Code 128 symbol is laid out, and whether a CSV import may be applied.
 *
 * Invariant 5 in one sentence, because this is the package a future milestone
 * will be tempted to add to: **no purchase cost lives in the catalog.** Selling
 * price does. WAC, landed cost and supply line prices belong to M07 and M09,
 * and `COST_FIELDS` in @elysium/contracts is what enforces the difference.
 */

export {
  buildSkuCode,
  isSkuCode,
  skuSegment,
  SkuCodeError,
  SKU_CODE_MAX,
  SKU_SEGMENT_MAX,
  SKU_SEPARATOR,
  SKU_SEQUENCE_WIDTH,
  type SkuCodeParts,
} from './sku-code.js';

export {
  matrixPlan,
  variantCombinations,
  variantKey,
  VariantMatrixError,
  MAX_VARIANTS_PER_PRODUCT,
  type MatrixPlan,
  type VariantAxis,
  type VariantCombination,
  type VariantValue,
} from './variant-matrix.js';

export {
  code128CheckValue,
  code128Encode,
  code128Svg,
  Code128Error,
  CODE128_PATTERNS,
  CODE128_QUIET_MODULES,
  type Code128Symbol,
} from './code128.js';

export {
  missingColumns,
  parseCsv,
  CsvError,
  CSV_MAX_ROWS,
  type CsvRow,
  type CsvTable,
} from './csv.js';

export {
  allOrNothing,
  reviewPriceImport,
  takaTextToPoisha,
  MAX_PRICE_POISHA,
  PRICE_IMPORT_OPTIONAL,
  PRICE_IMPORT_REQUIRED,
  type ImportProblem,
  type KnownSku,
  type PriceImportReport,
  type PriceImportRow,
} from './price-import.js';

export { parcelWeightGrams } from './parcel-weight.js';

export {
  variantOverrides,
  variantPriceEntries,
  variantPrices,
  type VariantPriceEntry,
  type VariantPriceOverride,
} from './variant-prices.js';

export {
  productSlug,
  reviewProductImport,
  splitValueList,
  uniqueSlug,
  PRODUCT_IMPORT_MAX_ROWS,
  PRODUCT_IMPORT_MAX_SKUS,
  PRODUCT_IMPORT_OPTIONAL,
  PRODUCT_IMPORT_REQUIRED,
  PRODUCT_IMPORT_TEMPLATE,
  type KnownAxis,
  type KnownCategory,
  type ProductImportContext,
  type ProductImportReport,
  type ProductImportRow,
} from './product-import.js';
