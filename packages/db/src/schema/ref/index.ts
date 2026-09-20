import { integer, pgSchema, text, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * Bangladesh administrative geography (architecture §5, cross-org exception 5).
 *
 * Global, not tenant-scoped: a district is the same district for every brand.
 * Delivery zones map onto these in M10, and a courier's own area list is the
 * authority for what it will actually deliver to (M12).
 *
 * Integer ids come from the source dataset rather than being generated, so a
 * re-import is idempotent and a district keeps its identity across reloads.
 */
export const ref = pgSchema('ref');

export const divisions = ref.table('divisions', {
  id: integer('id').primaryKey(),
  nameEn: text('name_en').notNull(),
  nameBn: text('name_bn').notNull(),
});

export const districts = ref.table(
  'districts',
  {
    id: integer('id').primaryKey(),
    divisionId: integer('division_id')
      .notNull()
      .references(() => divisions.id),
    nameEn: text('name_en').notNull(),
    nameBn: text('name_bn').notNull(),
  },
  (table) => [uniqueIndex('districts_division_name_idx').on(table.divisionId, table.nameEn)],
);

export const thanas = ref.table(
  'thanas',
  {
    id: integer('id').primaryKey(),
    districtId: integer('district_id')
      .notNull()
      .references(() => districts.id),
    nameEn: text('name_en').notNull(),
    nameBn: text('name_bn').notNull(),
  },
  (table) => [uniqueIndex('thanas_district_name_idx').on(table.districtId, table.nameEn)],
);
