#!/usr/bin/env node
/**
 * M13 acceptance check 4: a cached fraud lookup stays under 300 ms p95.
 *
 * Measured through `scripts/bench.mjs`, like every other latency check in this project, so
 * the numbers can be compared across sessions: fixed warmup, fixed sample count,
 * nearest-rank percentiles, and the machine and commit recorded beside the result. The
 * sample count is printed in the report, which is the half of check 4 that is usually left
 * out.
 *
 * Usage (the dev stack must be up, and `pnpm db:migrate` must have run):
 *   node apps/server/src/modules/fraud/fraud-lookup.bench.mjs
 *
 * It seeds into a throwaway database of its own and drops it afterwards.
 *
 * ## What "cached" means here, and why it is the honest measurement
 *
 * §10 says the desk "shows the badge within 300 ms from cache and refreshes stale data in
 * the background". The cache is `fraud.provider_checks.fetched_at` in PostgreSQL — not an
 * in-process map — and the reason is in `provider-gateway.ts`: several API instances serve
 * the desk, so a per-process cache would mean one TTL per replica and a badge that changes
 * when you reload. So a cache *hit* is still two indexed reads and a pure function, and
 * that is what is timed.
 *
 * The provider is deliberately absent from the measurement, and that is not a way of making
 * the number look good — it is the design. A lookup never calls a provider on the request
 * path (invariant 6: no external call inside a transaction), it enqueues a refresh. If the
 * benchmark included a network hop it would be measuring a third party's afternoon.
 *
 * Four shapes are measured because they do different amounts of work:
 *
 * 1. **a cold number** — nothing in either table. The fastest case and the commonest one in
 *    a COD business, so it must not be the only one measured;
 * 2. **a warm number with provider rows** — the full path: counters, the TTL-filtered
 *    provider read, the org's bands, the score;
 * 3. **a warm number with a manual flag** — adds `jsonb_array_length` over the flag array;
 * 4. **the whole guard, `assertConfirmAllowed`** — what the confirm path actually pays,
 *    including the `order_phones` write. It is the number that decides whether the desk
 *    feels fast, so leaving it out would be measuring the easy half.
 *
 * The table is filled with 50,000 other numbers first. A benchmark against a table holding
 * one row measures an index that has not been built yet — the primary key on a hash is a
 * btree over random 64-character strings, and its depth is exactly what grows with the
 * business.
 */

import { withOrg, withSystem } from '@elysium/db';
import { startTestDatabase, stopSharedContainer } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';

import { bench, formatResult, writeResult } from '../../../../../scripts/bench.mjs';
import { applyFraudMigrations, TEST_HASH_KEY } from './fraud.testing.js';
import { PhoneHashService } from './phone-hash.js';
import { FraudService } from './fraud.service.js';
import { ProviderGateway } from './providers/provider-gateway.js';
import { fraudConfig } from './fraud.config.js';

/** §10's budget for the badge. */
const BUDGET_MS = 300;

/** Other people's numbers, so the primary key is a real index rather than one page. */
const BACKGROUND_ROWS = 50_000;

/** An org_admin id for the override the guard writes. A fixture, not a real user. */
const ACTOR = {
  roles: ['org_admin'],
  isSuperAdmin: false,
  userId: 'usr_bench',
  branchIds: [],
  branchIdsByRole: { org_admin: [] },
};

/**
 * Fill `phone_signals` and `provider_checks` with background rows.
 *
 * `generate_series` and `md5`, in two statements. The hashes have to satisfy 0045's
 * `^[0-9a-f]{64}$` check, and two concatenated md5 digests are 64 hex characters — which is
 * also usefully realistic, because they are as evenly spread through the keyspace as real
 * HMACs are. A seed of sequential strings would build a one-sided btree and report a depth
 * the real table never has.
 *
 * Written as `erp_owner` with no org context, which is itself worth noticing: these two
 * tables have no policy (§5 exception 1), so unlike M06's catalog seed this one does not
 * need `withOrg` to be allowed to insert.
 */
async function seed() {
  await withSystem(async (tx) => {
    await tx.execute(sql`
      insert into fraud.phone_signals (
        phone_hash, orders_total, delivered, returned, cancelled, last_incident_at
      )
      select
        md5(n::text) || md5((n + 1)::text),
        (n % 17),
        (n % 11),
        (n % 4),
        (n % 3),
        case when n % 5 = 0 then now() - make_interval(days => (n % 60)) else null end
      from generate_series(1, ${BACKGROUND_ROWS}) as n
      on conflict (phone_hash) do nothing
    `);

    // A provider row for one number in five, which is roughly what an org that has just
    // switched providers on will have: the cache fills as the desk meets buyers.
    await tx.execute(sql`
      insert into fraud.provider_checks (
        phone_hash, provider, total, delivered, returned_or_cancelled, ratio, fetched_at
      )
      select
        md5(n::text) || md5((n + 1)::text),
        'steadfast',
        (n % 40),
        (n % 31),
        (n % 9),
        least(1.0, ((n % 31)::numeric / greatest(1, (n % 40))))::numeric(5, 4),
        now() - make_interval(hours => (n % 70))
      from generate_series(1, ${BACKGROUND_ROWS}, 5) as n
      on conflict (phone_hash, provider) do nothing
    `);

    // The planner needs statistics before it will use the primary key rather than scan
    // 50,000 rows. Without this the first run reports a sequential scan and looks like a
    // schema problem that is really a cold table.
    await tx.execute(sql`analyze fraud.phone_signals`);
    await tx.execute(sql`analyze fraud.provider_checks`);
  });
}

/** The three fixture numbers, each in a different state. Not real numbers (invariant 10). */
const COLD_PHONE = '01712000001';
const WARM_PHONE = '01712000002';
const FLAGGED_PHONE = '01712000003';

async function main() {
  process.env.FRAUD_PHONE_HASH_KEY ??= TEST_HASH_KEY;

  const database = await startTestDatabase('fraud-bench');
  let exitCode = 0;

  try {
    await applyFraudMigrations();

    const [{ id: orgId }] = await withSystem(async (tx) => [
      // `org.organizations` is a global table (§5 exception 5), so this read needs no org
      // context.
      ...(await tx.execute(sql`select id from org.organizations order by slug limit 1`)),
    ]);

    process.stdout.write(`seeding ${String(BACKGROUND_ROWS)} phone signal rows …\n`);
    await seed();

    const counted = await withSystem(async (tx) => {
      const rows = await tx.execute(sql`select count(*)::int as n from fraud.phone_signals`);
      return rows[0].n;
    });
    process.stdout.write(`seeded ${String(counted)} rows\n\n`);

    /*
     * The real services, constructed by hand rather than through Nest.
     *
     * Booting the application would drag in Better Auth, Valkey and the HTTP pipeline, none
     * of which is on the path being measured — and §10's budget is about the badge, not about
     * a loopback socket. The classes are the ones production uses; only the container is
     * missing. `ProviderGateway` is given no providers, which is exactly the cached path: a
     * lookup never calls out on the request path.
     */
    const config = fraudConfig();
    const hasher = new PhoneHashService(config);
    const gateway = new ProviderGateway(config, []);
    const audit = { record: async () => undefined };
    const fraud = new FraudService(hasher, gateway, audit);

    // The warm number gets counters and a fresh provider row; the flagged one gets a flag.
    await withSystem(async (tx) => {
      await tx.execute(sql`
        insert into fraud.phone_signals (phone_hash, orders_total, delivered, returned, last_incident_at)
        values (${hasher.hash(WARM_PHONE)}, 14, 11, 3, now() - make_interval(days => 9))
        on conflict (phone_hash) do nothing
      `);
      await tx.execute(sql`
        insert into fraud.provider_checks (phone_hash, provider, total, delivered, returned_or_cancelled, ratio)
        values (${hasher.hash(WARM_PHONE)}, 'steadfast', 31, 24, 7, 0.7742)
        on conflict (phone_hash, provider) do nothing
      `);
      await tx.execute(sql`
        insert into fraud.phone_signals (phone_hash, manual_flags)
        values (${hasher.hash(FLAGGED_PHONE)}, jsonb_build_array(jsonb_build_object('at', now(), 'severity', 1)))
        on conflict (phone_hash) do nothing
      `);
      await tx.execute(sql`analyze fraud.phone_signals`);
      await tx.execute(sql`analyze fraud.provider_checks`);
    });

    /*
     * Providers on for this org, so the warm case actually reads `provider_checks` rather
     * than skipping it.
     *
     * In its own transaction *with an org context*, unlike everything above. `fraud.rules`
     * is a tenant table with FORCE RLS, so even `erp_owner` — which owns it — is refused an
     * insert with no `app.org_id`. That is D-042 and invariant 4 working, and it is worth
     * knowing that a benchmark is not exempt: the first version of this file did the insert
     * in the same uncontexted transaction as the cross-org seed and was refused with
     * `new row violates row-level security policy`.
     */
    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          insert into fraud.rules (org_id, provider_enabled) values (${orgId}, true)
          on conflict (org_id) do update set provider_enabled = true
        `);
      },
      { orgId },
    );

    const run = (fn) => withOrg({ orgId, userId: 'usr_bench' }, fn);

    const results = [
      await bench({
        name: 'fraud: cached badge, number with no history (50k rows)',
        budgetMs: BUDGET_MS,
        fn: () => run((tx) => fraud.assess(tx, { orgId, phone: COLD_PHONE })),
      }),
      await bench({
        name: 'fraud: cached badge, counters plus a fresh provider row (50k rows)',
        budgetMs: BUDGET_MS,
        fn: () => run((tx) => fraud.assess(tx, { orgId, phone: WARM_PHONE })),
      }),
      await bench({
        name: 'fraud: cached badge, number carrying a manual flag (50k rows)',
        budgetMs: BUDGET_MS,
        fn: () => run((tx) => fraud.assess(tx, { orgId, phone: FLAGGED_PHONE })),
      }),
      await bench({
        name: 'fraud: the confirm guard end to end, including the order_phones write',
        budgetMs: BUDGET_MS,
        fn: () =>
          run((tx) =>
            fraud.assertConfirmAllowed(tx, {
              orgId,
              // A fresh id per sample, so every run pays for a real insert rather than an
              // `on conflict do nothing` that touches no page.
              orderId: crypto.randomUUID(),
              phone: WARM_PHONE,
              actor: ACTOR,
            }),
          ),
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
