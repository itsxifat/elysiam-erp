import { z } from 'zod';

/**
 * What uses a row, as every delete-or-archive screen asks it (M39a, D-621).
 *
 * `GET /v1/<area>/<kind>/:id/usage` answers with one `UsageReport`. The server asked every
 * module that may point at the row (the catalog's `CatalogReferences` port and its siblings
 * for locations and discounts); each module counted only its own tables (invariant 12). The
 * console reads the answer to decide what to offer, never to enforce it: the delete itself
 * asks again, inside its transaction, after it has locked the row.
 *
 * - `canDelete`: nothing uses it, so it can really be deleted.
 * - `canEmptyAndDelete`: everything that uses it can be moved first (a category's products,
 *   subcategories and menu entries; a size chart's products), so "Empty and delete" works.
 * - `canArchive`: the row has an archive state and is not already archived.
 *
 * A reason's `movable` says whether "Empty and delete" deals with it; anything else that
 * answers keeps the row (archive it instead). `examples` are a few names the caller may
 * already read (product names, menu labels, discount titles), never a buyer or a cost.
 */

export const USAGE_REASONS = [
  // The catalog's own rows.
  'products',
  'subcategories',
  'variants',
  // Inventory (invariant 3: a row with stock history keeps its history).
  'stock_movements',
  'stock_on_hand',
  'stock_reserved',
  'stock_documents',
  // Orders, the till, supply, couriers.
  'order_lines',
  'orders',
  'pos_lines',
  'pos_registers',
  'supply_lines',
  'supply_entries',
  'supplier_payments',
  'supplier_notes',
  'courier_returns',
  // Promotions.
  'discounts',
  'flash_sale_items',
  'redemptions',
  'flash_claims',
  // The website.
  'menu_entries',
  'web_locations',
  // Marketing and messages.
  'leads',
  'campaigns',
  'ad_spend',
  'messages_sent',
  'system_template',
] as const;

export type UsageReason = (typeof USAGE_REASONS)[number];

export const USAGE_KINDS = [
  'category',
  'attribute',
  'attribute_value',
  'product',
  'sku',
  'size_chart',
  'location',
  'supplier',
  'discount',
  'flash_sale',
  'sms_template',
  'ad_campaign',
] as const;

export type UsageKind = (typeof USAGE_KINDS)[number];

export interface UsageExample {
  readonly id: string;
  readonly label: string;
}

export interface UsageEntry {
  readonly reason: UsageReason;
  readonly count: number;
  readonly examples: readonly UsageExample[];
  /** "Empty and delete" moves it (a category's products); otherwise it keeps the row. */
  readonly movable: boolean;
}

export interface UsageReport {
  readonly kind: UsageKind;
  readonly id: string;
  readonly label: string;
  readonly archived: boolean;
  readonly canDelete: boolean;
  readonly canEmptyAndDelete: boolean;
  readonly canArchive: boolean;
  readonly uses: readonly UsageEntry[];
  /**
   * A size, colour or list: how many variants carrying it are still active, for "also
   * archive the N variants with this value" (D-624). Absent for every other kind.
   */
  readonly activeVariants?: number;
}

/** A category's "Empty and delete": where its products go (null: no category). */
export const emptyCategorySchema = z
  .object({ targetCategoryId: z.string().uuid().nullable() })
  .strict();
export type EmptyCategoryInput = z.infer<typeof emptyCategorySchema>;

/** A size chart's "Empty and delete": the chart its products take instead (null: none). */
export const emptySizeChartSchema = z
  .object({ replacementId: z.string().uuid().nullable() })
  .strict();
export type EmptySizeChartInput = z.infer<typeof emptySizeChartSchema>;
