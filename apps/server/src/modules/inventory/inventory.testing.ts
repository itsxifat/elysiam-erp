import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * Test-only setup for the inventory suites.
 *
 * Two jobs, and both exist because of how this session is split rather than because
 * of anything about inventory:
 *
 * 1. **Apply the migrations.** `packages/db/migrations/meta/_journal.json` is edited
 *    by several milestones at once, so M07's four files are handed to the integrator
 *    as INTEGRATION lines instead of appended here — and until they are appended,
 *    `startTestDatabase()`'s `migrate()` does not run them. M06's four come first,
 *    because every inventory foreign key points at `catalog.skus`.
 * 2. **Seed a product.** The catalog's create endpoints are M06's to test; these
 *    suites need SKUs to move, so the rows are written directly. A fixture, not a
 *    production path — which is why it is here and not in the service.
 */

const MIGRATIONS = [
  // M06 first: inventory's foreign keys point at catalog.skus.
  '0023_catalog_schema.sql',
  '0024_catalog_policies.sql',
  '0025_catalog_search.sql',
  '0026_catalog_integrity.sql',
  '0031_inventory_schema.sql',
  '0032_inventory_policies.sql',
  '0033_inventory_integrity.sql',
  '0034_approvals_branch_scope.sql',
] as const;

function migrationsDir(): string {
  // Resolved from this file rather than from cwd: vitest runs suites with the
  // repository root as cwd, but a suite run from `apps/server` must find the same
  // files.
  return path.resolve(import.meta.dirname, '../../../../../packages/db/migrations');
}

export async function applyInventoryMigrations(): Promise<void> {
  const already = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('inventory') is not null as present`,
    );
    return rows[0]?.present === true;
  });
  if (already) return;

  const directory = migrationsDir();
  const catalogPresent = await withSystem(async (tx) => {
    const rows = await tx.execute<{ present: boolean }>(
      sql`select to_regnamespace('catalog') is not null as present`,
    );
    return rows[0]?.present === true;
  });

  for (const name of MIGRATIONS) {
    if (catalogPresent && name.includes('catalog')) continue;
    const contents = await readFile(path.join(directory, name), 'utf8');
    // The same separator the real migrator splits on. Comment-only fragments are
    // valid no-op statements, so they need no filtering.
    for (const statement of contents.split('--> statement-breakpoint')) {
      const trimmed = statement.trim();
      if (trimmed === '') continue;
      await withSystem(async (tx) => {
        await tx.execute(sql.raw(trimmed));
      });
    }
  }
}

export interface SeededSku {
  readonly id: string;
  readonly code: string;
}

/**
 * One product with `count` SKUs, and the org's seeded warehouse.
 *
 * Written as `erp_owner` inside the org's context, so RLS applies exactly as it
 * does to the application: an uncontexted insert would fail, which is itself a
 * small check that the catalog's policies are on.
 */
export async function seedProductWithSkus(
  orgId: string,
  slug: string,
  count: number,
): Promise<{ productId: string; skus: SeededSku[] }> {
  return withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into catalog.sku_settings (org_id, org_code, last_sequence)
        values (${orgId}, 'TEST', 0)
        on conflict (org_id) do nothing
      `);

      const categoryRows = await tx.execute<{ id: string }>(sql`
        insert into catalog.categories (org_id, name, slug, code, path, depth)
        values (${orgId}, 'Test Category', ${`cat-${slug}`}, ${slug.slice(0, 8).toUpperCase()},
                ${`/cat-${slug}`}, 0)
        on conflict (org_id, code) do update set name = excluded.name
        returning id
      `);
      const categoryId = categoryRows[0]?.id;

      // Past the highest sequence already used, not merely past the counter. Other suites'
      // fixtures (courier's, for one) write products with `max(sequence) + 1` and leave the
      // counter behind, so a suite that runs both — the cost sweep runs every module's —
      // collided on `products_org_sequence_idx` with the counter alone.
      const sequenceRows = await tx.execute<{ last_sequence: number }>(sql`
        update catalog.sku_settings
        set last_sequence = greatest(
          last_sequence,
          (select coalesce(max(p.sequence), 0) from catalog.products p where p.org_id = ${orgId})
        ) + 1
        where org_id = ${orgId}
        returning last_sequence
      `);
      const sequence = sequenceRows[0]?.last_sequence ?? 1;

      const productRows = await tx.execute<{ id: string }>(sql`
        insert into catalog.products (org_id, category_id, sequence, name, slug, status)
        values (${orgId}, ${categoryId}::uuid, ${sequence}, ${`Product ${slug}`},
                ${`product-${slug}`}, 'active')
        returning id
      `);
      const productId = productRows[0]?.id;
      if (productId === undefined) throw new Error('seeding a product returned no id');

      const skus: SeededSku[] = [];
      for (let index = 0; index < count; index += 1) {
        const code = `TEST-${slug.toUpperCase()}-${String(index + 1).padStart(2, '0')}`;
        const rows = await tx.execute<{ id: string }>(sql`
          insert into catalog.skus (org_id, product_id, code, variant_key, price_poisha, status)
          values (${orgId}, ${productId}, ${code}, ${`v${String(index)}`}, 150000, 'active')
          returning id
        `);
        const id = rows[0]?.id;
        if (id === undefined) throw new Error('seeding a SKU returned no id');
        skus.push({ id, code });
      }

      return { productId, skus };
    },
    { orgId },
  );
}

/** The org's seeded main warehouse. */
export async function warehouseId(orgId: string): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.locations where org_id = ${orgId} and code = 'WH-01'
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('the seed has no WH-01 location');
      return id;
    },
    { orgId },
  );
}

/** A location of any kind, for the transfer and damaged-stock cases. */
export async function makeLocation(
  orgId: string,
  input: { code: string; name: string; kind: string; branchId?: string | null },
): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into org.locations (org_id, branch_id, code, name, kind)
        values (${orgId}, ${input.branchId ?? null}::uuid, ${input.code}, ${input.name},
                ${input.kind}::org.location_kind)
        on conflict (org_id, code) do update set name = excluded.name
        returning id
      `);
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('inserting a location returned no id');
      return id;
    },
    { orgId },
  );
}
