/**
 * Variant prices and buying prices (M39b, D-635 to D-640).
 *
 * Its own entry point (`@elysium/domain/pricing`) because the console runs the same rules in
 * the browser for its previews (the bulk price editor, the grid's quick fills, the receipt
 * prefill, the margin column). It imports only the money module. The standard buying price
 * spreadsheet (`standard-costs.ts`) is the server's and is exported from the package root
 * only, so the console's chunks never carry the CSV code.
 */
export {
  PRICE_BOUND_POISHA,
  applyPriceRule,
  attributeKindRank,
  axisOrderFromCode,
  bpsPercentText,
  compareAtProblem,
  gridPrice,
  marginBps,
  mostCommonPrice,
  newVariantPrice,
  percentTextToBps,
  planBulkPrices,
  prefillUnitCost,
  roundToStep,
  type ExistingVariantPrice,
  type PlannedPrice,
  type PrefillSource,
  type PriceField,
  type PricePlan,
  type PriceProblem,
  type PriceRule,
  type PriceRuleOutcome,
  type PricedVariant,
} from './rules.js';
