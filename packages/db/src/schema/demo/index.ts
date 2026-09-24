import {
  bigint,
  foreignKey,
  index,
  integer,
  pgSchema,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

import { branches, organizations } from '../org/index.js';
import { primaryId, timestamps } from '../columns.js';

/**
 * A resource that carries cost, so the permission matrix has something real to
 * be tested against (M02b).
 *
 * The matrix's whole job is that `unit_cost_poisha` reaches `accounts` and
 * never reaches `sales`, `marketing`, `warehouse` or `reseller`. Asserting that
 * against a mock proves the mock; asserting it against a table that goes
 * through the same RLS, the same serializer and the same guard as everything
 * else proves the mechanism.
 *
 * **This is temporary.** M06 brings the real catalog, which carries cost for
 * genuine reasons, and the matrix suite moves onto it. The migration that
 * drops this schema is part of M06 — it is listed as a follow-up so the
 * deletion is somebody's job rather than an intention.
 */
export const demo = pgSchema('demo');

export const costedItems = demo.table(
  'costed_items',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    sku: text('sku').notNull(),
    name: text('name').notNull(),

    /** Readable only with `read:cost` (§6). The point of the whole exercise. */
    unitCostPoisha: bigint('unit_cost_poisha', { mode: 'bigint' }).notNull(),
    /** Readable by everyone, including resellers. */
    sellPricePoisha: bigint('sell_price_poisha', { mode: 'bigint' }).notNull(),
    availableQty: integer('available_qty').notNull().default(0),
    /**
     * Which branch holds it, so `branch`-scoped reads have something to be
     * scoped by. branch_manager reads CostedItem at `branch` scope (§6), and a
     * scope asserted against a table with no branch column proves nothing.
     */
    branchId: uuid('branch_id'),

    ...timestamps,
  },
  (table) => [
    unique('costed_items_org_sku_key').on(table.orgId, table.sku),
    index('costed_items_org_idx').on(table.orgId),
    // Composite, per D-047: a single-column FK is satisfiable across orgs.
    foreignKey({
      name: 'costed_items_org_id_branch_id_fk',
      columns: [table.orgId, table.branchId],
      foreignColumns: [branches.orgId, branches.id],
    }).onDelete('restrict'),
  ],
);
