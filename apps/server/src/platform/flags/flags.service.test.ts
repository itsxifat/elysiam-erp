import { withOrg, SEED_ORG_IDS, type Tx } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FEATURE_FLAG_KEYS, type FeatureFlagKey } from './flag-keys.js';
import { FlagsService } from './flags.service.js';
import { FLAG_OVERRIDES_ENV } from './overrides.js';

/**
 * Feature flags against a real database (D-031).
 *
 * Real Postgres rather than a fake, for the usual reason: the claim that org A
 * turning a flag on leaves org B alone is a claim about a row-level security
 * policy, and a mock has no policies to be wrong about (invariant 4).
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';
const FLAG: FeatureFlagKey = 'courier.auto_book';

let database: TestDatabase;
let flags: FlagsService;
let previousTtl: string | undefined;
let previousOverrides: string | undefined;

beforeAll(async () => {
  database = await startTestDatabase('flags');
  previousTtl = process.env.FLAGS_CACHE_TTL_MS;
  previousOverrides = process.env[FLAG_OVERRIDES_ENV];
}, 180_000);

afterAll(async () => {
  if (previousTtl === undefined) delete process.env.FLAGS_CACHE_TTL_MS;
  else process.env.FLAGS_CACHE_TTL_MS = previousTtl;
  if (previousOverrides === undefined) delete process.env[FLAG_OVERRIDES_ENV];
  else process.env[FLAG_OVERRIDES_ENV] = previousOverrides;

  await database?.stop();
  await stopSharedContainer();
}, 60_000);

beforeEach(async () => {
  // Caching off by default here: every test below is about what the database
  // says, and a ten-second window would make those assertions race the clock.
  // The one test that is about the cache sets its own TTL.
  process.env.FLAGS_CACHE_TTL_MS = '0';
  delete process.env[FLAG_OVERRIDES_ENV];
  flags = new FlagsService();
  await clearFlags(ORG_A);
  await clearFlags(ORG_B);
});

afterEach(() => {
  flags.invalidate();
});

const asOrg = <T>(orgId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withOrg({ orgId, userId: 'usr_flags_test' }, fn);

async function clearFlags(orgId: string): Promise<void> {
  await asOrg(orgId, (tx) => tx.execute(sql`delete from org.feature_flags`));
}

/** A write that goes around the service, so no cache invalidation happens. */
async function writeRowDirectly(orgId: string, enabled: boolean): Promise<void> {
  await asOrg(orgId, (tx) =>
    tx.execute(sql`
      insert into org.feature_flags (org_id, key, enabled)
      values (${orgId}, ${FLAG}, ${enabled})
      on conflict (org_id, key) do update set enabled = excluded.enabled
    `),
  );
}

describe('an unset flag', () => {
  it('reads as its registry default, and says the default is where that came from', async () => {
    const state = await flags.stateOf(ORG_A, FLAG);
    expect(state).toEqual({ key: FLAG, enabled: false, value: null, source: 'default' });
    expect(await flags.isEnabled(ORG_A, FLAG)).toBe(false);
  });

  /*
   * A typo must not read as "off". That is the whole argument for a closed
   * registry: a silently-disabled feature looks exactly like a correctly
   * configured one.
   */
  it('throws for a key nobody declared rather than answering false', async () => {
    await expect(flags.stateOf(ORG_A, 'courier.autobook' as FeatureFlagKey)).rejects.toThrow(
      /Unknown feature flag/,
    );
  });
});

describe('a flag set for one org', () => {
  it('is on for that org and carries its configuration', async () => {
    await asOrg(ORG_A, (tx) =>
      flags.setInTx(tx, ORG_A, FLAG, { enabled: true, value: { cutoffHour: 18 } }),
    );

    const state = await flags.stateOf(ORG_A, FLAG);
    expect(state.enabled).toBe(true);
    expect(state.source).toBe('org');
    expect(state.value).toEqual({ cutoffHour: 18 });
  });

  it('leaves every other org on its default — the policy, not the query, is what does that', async () => {
    await asOrg(ORG_A, (tx) => flags.setInTx(tx, ORG_A, FLAG, { enabled: true }));

    expect(await flags.isEnabled(ORG_A, FLAG)).toBe(true);
    expect(await flags.isEnabled(ORG_B, FLAG)).toBe(false);
    expect((await flags.stateOf(ORG_B, FLAG)).source).toBe('default');
  });

  it('can be turned back off, and the second write updates rather than duplicates', async () => {
    await asOrg(ORG_A, (tx) => flags.setInTx(tx, ORG_A, FLAG, { enabled: true }));
    await asOrg(ORG_A, (tx) => flags.setInTx(tx, ORG_A, FLAG, { enabled: false }));

    expect(await flags.isEnabled(ORG_A, FLAG)).toBe(false);
    const rows = await asOrg(ORG_A, async (tx) => [
      ...(await tx.execute<{ count: string }>(
        sql`select count(*)::text as count from org.feature_flags where key = ${FLAG}`,
      )),
    ]);
    expect(rows[0]?.count).toBe('1');
  });
});

describe('the environment override', () => {
  it('beats the row, and says so, because it is the kill switch', async () => {
    await asOrg(ORG_A, (tx) => flags.setInTx(tx, ORG_A, FLAG, { enabled: true }));
    expect(await flags.isEnabled(ORG_A, FLAG)).toBe(true);

    process.env[FLAG_OVERRIDES_ENV] = `${FLAG}=off`;
    flags.invalidate();

    const state = await flags.stateOf(ORG_A, FLAG);
    expect(state.enabled).toBe(false);
    expect(state.source).toBe('environment');
  });

  it('can switch a dark feature on for every org without a single row', async () => {
    process.env[FLAG_OVERRIDES_ENV] = `${FLAG}=on`;
    flags.invalidate();

    expect(await flags.isEnabled(ORG_A, FLAG)).toBe(true);
    expect(await flags.isEnabled(ORG_B, FLAG)).toBe(true);
  });
});

describe('stateInTx', () => {
  it('sees the caller’s uncommitted write, which is what makes it the caller’s transaction', async () => {
    const seen = await asOrg(ORG_A, async (tx) => {
      await flags.setInTx(tx, ORG_A, FLAG, { enabled: true });
      return flags.stateInTx(tx, FLAG);
    });
    expect(seen.enabled).toBe(true);
  });

  /*
   * And caches nothing. A value read inside a transaction that then rolled back
   * never happened; caching it would keep a feature on because of a write the
   * database threw away.
   */
  it('caches nothing, so a rolled-back write leaves no trace', async () => {
    process.env.FLAGS_CACHE_TTL_MS = '60000';
    flags = new FlagsService();

    await expect(
      asOrg(ORG_A, async (tx) => {
        await flags.setInTx(tx, ORG_A, FLAG, { enabled: true });
        expect((await flags.stateInTx(tx, FLAG)).enabled).toBe(true);
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await flags.isEnabled(ORG_A, FLAG)).toBe(false);
  });
});

describe('the cache', () => {
  it('holds a read for its TTL, and lets go when told to', async () => {
    process.env.FLAGS_CACHE_TTL_MS = '60000';
    flags = new FlagsService();

    expect(await flags.isEnabled(ORG_A, FLAG)).toBe(false);
    await writeRowDirectly(ORG_A, true);

    // Still false: the TTL is the documented cost of not querying per call.
    expect(await flags.isEnabled(ORG_A, FLAG)).toBe(false);

    flags.invalidate(ORG_A);
    expect(await flags.isEnabled(ORG_A, FLAG)).toBe(true);
  });

  it('is scoped per org, so invalidating one org does not reread the other', async () => {
    process.env.FLAGS_CACHE_TTL_MS = '60000';
    flags = new FlagsService();

    expect(await flags.isEnabled(ORG_A, FLAG)).toBe(false);
    expect(await flags.isEnabled(ORG_B, FLAG)).toBe(false);

    await writeRowDirectly(ORG_A, true);
    await writeRowDirectly(ORG_B, true);
    flags.invalidate(ORG_A);

    expect(await flags.isEnabled(ORG_A, FLAG)).toBe(true);
    expect(await flags.isEnabled(ORG_B, FLAG)).toBe(false);
  });
});

describe('all()', () => {
  it('lists every declared flag, including the ones with no row', async () => {
    await asOrg(ORG_A, (tx) => flags.setInTx(tx, ORG_A, FLAG, { enabled: true }));

    const states = await flags.all(ORG_A);
    expect(states.map((state) => state.key)).toEqual([...FEATURE_FLAG_KEYS]);
    expect(states.find((state) => state.key === FLAG)?.source).toBe('org');
    expect(states.filter((state) => state.source === 'default').length).toBe(
      FEATURE_FLAG_KEYS.length - 1,
    );
  });

  it('shows an overridden flag as overridden, so nobody debugs the database for nothing', async () => {
    process.env[FLAG_OVERRIDES_ENV] = `${FLAG}=on`;
    flags.invalidate();

    const state = (await flags.all(ORG_A)).find((candidate) => candidate.key === FLAG);
    expect(state?.enabled).toBe(true);
    expect(state?.source).toBe('environment');
  });
});
