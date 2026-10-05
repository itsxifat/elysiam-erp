/**
 * Types for the old website's discount engine, kept only as a test oracle (M35a, D-540).
 *
 * The engine is plain JavaScript copied verbatim; these declarations describe the shapes the
 * differential test passes it, no more. Never import the engine from production code.
 */

export interface OracleItem {
  productId: string;
  categoryIds: string[];
  price: number;
  quantity: number;
}

export interface OracleTier {
  minSubtotal: number;
  type: 'percentage' | 'fixed';
  value: number;
}

export interface OracleDiscount {
  _id: string;
  title: string;
  method: 'code' | 'automatic';
  code?: string | null;
  type: 'percentage' | 'fixed' | 'free_shipping' | 'buy_x_get_y' | 'tiered';
  value: number;
  maxDiscount: number;
  buyQuantity: number;
  getQuantity: number;
  getDiscountPercent: number;
  tiers: OracleTier[];
  appliesTo: 'all' | 'products' | 'categories';
  products: string[];
  categories: string[];
  minSubtotal: number;
  minQuantity: number;
  firstOrderOnly: boolean;
  usageLimit: number;
  usedCount: number;
  startsAt: Date | null;
  endsAt: Date | null;
  allowStacking: boolean;
  priority: number;
  active: boolean;
}

export interface OracleApplied {
  discountId: string;
  code: string | null;
  title: string;
  type: string;
  method: string;
  allowStacking: boolean;
  priority: number;
  amount: number;
  freeShipping: boolean;
}

export interface OracleResult {
  applied: OracleApplied[];
  rejected: { code: string; reason: string }[];
  discountTotal: number;
  freeShipping: boolean;
}

export function computeDiscounts(args: {
  discounts?: OracleDiscount[];
  items?: OracleItem[];
  shippingFee?: number;
  codes?: string[];
  isFirstOrder?: boolean;
  now?: Date;
}): OracleResult;
