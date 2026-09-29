#!/usr/bin/env node
/**
 * M06 acceptance check 2: SKU search under 200 ms p95 on 20k seeded SKUs.
 *
 * Measured through `scripts/bench.mjs`, not with a stopwatch in a comment, so the
 * method matches every other latency check in the project: fixed warmup, fixed
 * sample count, nearest-rank percentiles, and the machine and commit recorded
 * beside the numbers.
 *
 * Usage (the dev stack must be up):
 *   pnpm bench catalog            (or `pnpm --filter @elysium/server bench:catalog`)
 *
 * Not `node <this file>`: it imports the module's TypeScript directly, so it runs under
 * tsx, and `scripts/bench.mjs` is what starts it that way and points it at the dev
 * stack's PostgreSQL.
 *
 * It seeds into a throwaway database of its own and drops it afterwards, so it
 * never leaves 20,000 rows in anybody's development catalogue.
 *
 * ## What is being measured, and what is deliberately not
 *
 * The **query**, through the real repository, against real PostgreSQL with the real
 * indexes — which is where the 200 ms lives. Not the HTTP round trip: that adds
 * Fastify, the guard, the serializer and a loopback socket, all of which are
 * measured by their own suites and none of which is what an index change would
 * regress. A benchmark that includes them turns a 12 ms index regression into
 * noise inside a 40 ms total.
 *
 * Three shapes are measured because they use the indexes differently:
 *
 * 1. a substring of a SKU code — the trigram index on `skus.code`;
 * 2. a product-name fragment — the trigram index on `products.search_text`;
 * 3. an exact code, as a barcode scanner produces — the unique btree.
 */

import { withOrg, withSystem } from '@elysium/db';
import { startTestDatabase, stopSharedContainer } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';

import { bench, formatResult, writeResult } from '../../../../../scripts/bench.mjs';
import { searchProducts, searchSkus } from './catalog.repository.js';
import { applyCatalogMigrations } from './catalog.testing.js';

const TARGET_SKUS = 20_000;
const PRODUCTS = 2_000;
const BUDGET_MS = 200;

/**
 * Seed 2,000 products of 10 SKUs each, in one statement per table.
 *
 * `generate_series` rather than 20,000 round trips: the point of the benchmark is
 * the read, and a seed that takes four minutes is a benchmark nobody re-runs.
 *
 * The names and codes are varied on purpose. A seed where every product is called
 * "Product 1", "Product 2" produces trigrams that are almost all shared, and a GIN
 * index on near-identical text answers a different question from the real one —
 * it would report a number that gets worse the day real data arrives.
 */
async function seed(orgId) {
  const words = ['panjabi', 'kurta', 'saree', 'shirt', 'tshirt', 'jeans', 'kameez', 'hijab'];
  const colours = ['RED', 'BLUE', 'GREEN', 'BLACK', 'WHITE'];
  const sizes = ['S', 'M'];

  // `withOrg`, not `withSystem`: RLS is FORCEd on every catalog table, so even
  // `erp_owner` — the table owner — is subject to the org policy and an insert
  // with no `app.org_id` is refused. That is D-042 and invariant 4 working, and it
  // is worth knowing that a seed script is not exempt from it.
  await withOrg({ orgId, userId: 'bench' }, async (tx) => {
    await tx.execute(sql`
      insert into catalog.sku_settings (org_id, org_code, last_sequence)
      values (${orgId}, 'ELY', ${PRODUCTS})
      on conflict (org_id) do update set last_sequence = ${PRODUCTS}
    `);

    await tx.execute(sql`
      insert into catalog.products (org_id, sequence, name, slug, status)
      select
        ${orgId},
        n,
        (array[${sql.join(
          words.map((w) => sql`${w}`),
          sql`, `,
        )}])[1 + (n % ${words.length})]
          || ' ' || (array['embroidered','printed','cotton','silk','linen'])[1 + (n % 5)]
          || ' ' || n::text,
        'bench-' || n::text,
        'active'
      from generate_series(1, ${PRODUCTS}) as n
    `);

    await tx.execute(sql`
      insert into catalog.skus (org_id, product_id, code, variant_key, price_poisha, position)
      select
        ${orgId},
        p.id,
        'ELY-BNC-' || lpad(p.sequence::text, 4, '0') || '-' || v.colour || '-' || v.size,
        v.colour || '/' || v.size,
        100000 + (p.sequence % 500) * 100,
        v.ord
      from catalog.products p
      cross join (
        select colour, size, row_number() over () as ord
        from unnest(array[${sql.join(
          colours.map((c) => sql`${c}`),
          sql`, `,
        )}]) as colour
        cross join unnest(array[${sql.join(
          sizes.map((s) => sql`${s}`),
          sql`, `,
        )}]) as size
      ) v
      where p.org_id = ${orgId} and p.slug like 'bench-%'
    `);

    // The planner needs statistics before it will choose a GIN index over a scan.
    // Without this the first run reports a sequential scan's latency and the
    // benchmark looks like a schema problem.
  });

  // ANALYZE is a maintenance command and belongs to the table's owner, so it runs
  // outside the app-role transaction above. Without it the planner has no
  // statistics for these tables and picks a sequential scan, which would make the
  // first run report a schema problem that is really a cold catalogue.
  await withSystem(async (tx) => {
    await tx.execute(sql`analyze catalog.products`);
    await tx.execute(sql`analyze catalog.skus`);
  });
}

async function main() {
  const database = await startTestDatabase('catalog-bench');
  let exitCode = 0;

  try {
    await applyCatalogMigrations();

    const [{ id: orgId }] = await withSystem(async (tx) => [
      // `org.organizations` is a global table (§5 exception 5), so this one read
      // needs no org context.
      ...(await tx.execute(sql`select id from org.organizations order by slug limit 1`)),
    ]);

    process.stdout.write(`seeding ${String(PRODUCTS)} products …\n`);
    await seed(orgId);

    const counted = await withOrg({ orgId, userId: 'bench' }, async (tx) => {
      const rows = await tx.execute(sql`select count(*)::int as n from catalog.skus`);
      return rows[0].n;
    });
    process.stdout.write(`seeded ${String(counted)} SKUs\n\n`);
    if (counted < TARGET_SKUS) {
      throw new Error(
        `the seed produced ${String(counted)} SKUs; check 2 asks for ${String(TARGET_SKUS)}`,
      );
    }

    const run = (fn) => withOrg({ orgId, userId: 'bench' }, fn);

    const results = [
      await bench({
        name: 'catalog: SKU code substring (20k SKUs)',
        budgetMs: BUDGET_MS,
        fn: () => run((tx) => searchSkus(tx, orgId, { q: 'BNC-1234', limit: 50 })),
      }),
      await bench({
        name: 'catalog: product name fragment (2k products, 20k SKUs)',
        budgetMs: BUDGET_MS,
        fn: () => run((tx) => searchProducts(tx, orgId, { q: 'embroidered', limit: 25 })),
      }),
      await bench({
        name: 'catalog: exact code, as a scanner sends it',
        budgetMs: BUDGET_MS,
        fn: () => run((tx) => searchSkus(tx, orgId, { code: 'ELY-BNC-1234-RED-S', limit: 1 })),
      }),
    ];

    for (const result of results) {
      process.stdout.write(`${formatResult(result)}\n`);
      writeResult(result);
      if (result.p95 > BUDGET_MS) exitCode = 1;
    }
  } finally {
    await database.stop();
    await stopSharedContainer();
  }

  process.exit(exitCode);
}

await main();
