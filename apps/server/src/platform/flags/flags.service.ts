import { Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

import {
  FEATURE_FLAGS,
  FEATURE_FLAG_KEYS,
  isFeatureFlagKey,
  type FeatureFlagKey,
  type FeatureFlagState,
} from './flag-keys.js';
import { flagOverridesFromEnv, type FlagOverrides } from './overrides.js';

/**
 * Reading feature flags (D-031, architecture §3).
 *
 * Three layers, highest first:
 *
 * 1. the environment override — deployment-wide, a restart to change, and the
 *    kill switch (see `overrides.ts` for why it wins)
 * 2. the `org.feature_flags` row for the active org
 * 3. the registry default in `flag-keys.ts`
 *
 * Two ways in, for the same reason the audit log has two:
 *
 * - `stateInTx(tx, key)` reads inside the caller's transaction, which is what a
 *   service already holding one should use. It sees the org the transaction is
 *   scoped to, because the row comes back through RLS rather than through an
 *   `org_id` the caller passed — so a caller cannot read another org's flags by
 *   handing this an id.
 * - `stateOf(orgId, key)` opens its own `withOrg` transaction, for the request
 *   pipeline and for jobs that have no transaction yet. The `orgId` must be the
 *   one the request context already authorised (`ActiveContext.orgId`); it is
 *   never a value off the wire, because `withOrg` sets `app.org_id` to whatever
 *   it is given and that is the whole of tenant isolation.
 *
 * ## The cache
 *
 * Flags are read on hot paths — potentially per order, per page, per job — and
 * they change a few times a year. A short TTL turns that into one query every
 * `FLAGS_CACHE_TTL_MS`, at the cost of a flip taking up to that long to reach
 * every process. Ten seconds is short enough that nobody notices and long
 * enough that the query disappears.
 *
 * Transactional reads never populate the cache. A transaction can roll back,
 * and a value cached from a read inside one that then rolled back is a lie that
 * outlives the transaction that told it.
 */

const DEFAULT_TTL_MS = 10_000;
const TTL_ENV = 'FLAGS_CACHE_TTL_MS';

interface CachedState {
  readonly state: FeatureFlagState;
  readonly expiresAt: number;
}

/**
 * `extends Record<string, unknown>` because Drizzle's `execute<T>` constrains
 * `T` to that, and an interface has no implicit index signature. Same shape the
 * ledger's repository rows use.
 */
interface FlagRow extends Record<string, unknown> {
  readonly enabled: boolean;
  readonly value: unknown;
}

function assertKnown(key: string): FeatureFlagKey {
  if (!isFeatureFlagKey(key)) {
    // Not a domain error with a problem+json code: an unknown flag key is a
    // programming mistake in our own code, not something a request can cause,
    // and it should reach the log as a stack trace with the key in it.
    throw new Error(
      `Unknown feature flag "${key}". Add it to FEATURE_FLAGS in flag-keys.ts. ` +
        `Known flags: ${FEATURE_FLAG_KEYS.join(', ')}.`,
    );
  }
  return key;
}

@Injectable()
export class FlagsService {
  private overrides: FlagOverrides | null = null;
  private readonly cache = new Map<string, CachedState>();

  /**
   * `0` disables caching, which is what the integration tests want: they change
   * a row and assert the next read sees it, and a 10-second window would make
   * that either flaky or slow.
   */
  private ttlMs(): number {
    const raw = process.env[TTL_ENV];
    if (raw === undefined || raw.trim() === '') return DEFAULT_TTL_MS;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`${TTL_ENV} must be a whole number of milliseconds, not "${raw}".`);
    }
    return parsed;
  }

  /**
   * Parsed once and memoised, so a malformed `FEATURE_FLAGS` throws on the first
   * read rather than on one unlucky request in a hundred.
   */
  private environmentOverrides(): FlagOverrides {
    this.overrides ??= flagOverridesFromEnv();
    return this.overrides;
  }

  /**
   * Forget everything read so far.
   *
   * Called after a write, and by tests that have just changed the environment.
   * Clearing the memoised overrides too is deliberate: `FEATURE_FLAGS` is read
   * from `process.env` at first use, so a test that sets it and calls this gets
   * the behaviour a restarted process would have.
   */
  invalidate(orgId?: string): void {
    this.overrides = null;
    if (orgId === undefined) {
      this.cache.clear();
      return;
    }
    for (const cacheKey of this.cache.keys()) {
      if (cacheKey.startsWith(`${orgId}:`)) this.cache.delete(cacheKey);
    }
  }

  /** Is this flag on for this org? */
  async isEnabled(orgId: string, key: FeatureFlagKey): Promise<boolean> {
    return (await this.stateOf(orgId, key)).enabled;
  }

  /** The flag's state for this org, and where that state came from. */
  async stateOf(orgId: string, key: FeatureFlagKey): Promise<FeatureFlagState> {
    const flag = assertKnown(key);

    // The override short-circuits before any query. That matters for the kill
    // switch: it has to work when the database is the thing that is unwell.
    const overridden = this.environmentOverrides().get(flag);
    if (overridden !== undefined) {
      return { key: flag, enabled: overridden, value: null, source: 'environment' };
    }

    const ttl = this.ttlMs();
    const cacheKey = `${orgId}:${flag}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.state;

    const row = await withOrg({ orgId }, (tx) => readRow(tx, flag));
    const state = stateFrom(flag, row);
    if (ttl > 0) this.cache.set(cacheKey, { state, expiresAt: Date.now() + ttl });
    return state;
  }

  /**
   * The flag's state inside the caller's transaction, for the org that
   * transaction is scoped to.
   *
   * Uncached, in both directions: it neither reads nor writes the cache.
   */
  async stateInTx(tx: Tx, key: FeatureFlagKey): Promise<FeatureFlagState> {
    const flag = assertKnown(key);
    const overridden = this.environmentOverrides().get(flag);
    if (overridden !== undefined) {
      return { key: flag, enabled: overridden, value: null, source: 'environment' };
    }
    return stateFrom(flag, await readRow(tx, flag));
  }

  /**
   * Every flag's state for one org, for the admin screen.
   *
   * Driven by the registry rather than by the table, so a flag with no row
   * appears with its default instead of vanishing — the screen has to be able
   * to turn on a flag that has never been set, which means it has to list it.
   */
  async all(orgId: string): Promise<readonly FeatureFlagState[]> {
    const rows = await withOrg({ orgId }, async (tx) => {
      const result = await tx.execute<{ key: string; enabled: boolean; value: unknown }>(sql`
        select key, enabled, value from org.feature_flags
      `);
      return [...result];
    });

    const byKey = new Map(rows.map((row) => [row.key, { enabled: row.enabled, value: row.value }]));
    const overrides = this.environmentOverrides();

    return FEATURE_FLAG_KEYS.map((flag) => {
      const overridden = overrides.get(flag);
      if (overridden !== undefined) {
        return { key: flag, enabled: overridden, value: null, source: 'environment' as const };
      }
      return stateFrom(flag, byKey.get(flag));
    });
  }

  /**
   * Turn a flag on or off for one org, in the caller's transaction.
   *
   * In the caller's transaction so the change lands with its audit row and its
   * outbox event, rather than committing separately and leaving a flip nobody
   * can attribute. `updated_at` is set explicitly because the upsert path never
   * touches the row's defaults.
   *
   * The cache is cleared before the transaction has committed, which is the safe
   * direction to be wrong in: the worst case is one extra query, whereas a cache
   * entry that survives a flip is a feature that stays visible after somebody
   * switched it off.
   */
  async setInTx(
    tx: Tx,
    orgId: string,
    key: FeatureFlagKey,
    options: { readonly enabled: boolean; readonly value?: unknown },
  ): Promise<void> {
    const flag = assertKnown(key);
    const value = options.value === undefined ? null : JSON.stringify(options.value);

    await tx.execute(sql`
      insert into org.feature_flags (org_id, key, enabled, value)
      values (${orgId}, ${flag}, ${options.enabled}, ${value}::jsonb)
      on conflict (org_id, key) do update
        set enabled = excluded.enabled,
            value = excluded.value,
            updated_at = now()
    `);

    this.invalidate(orgId);
  }
}

/** One flag's row, scoped by RLS rather than by an `org_id` in the predicate. */
async function readRow(tx: Tx, key: FeatureFlagKey): Promise<FlagRow | undefined> {
  const result = await tx.execute<FlagRow>(sql`
    select enabled, value from org.feature_flags where key = ${key} limit 1
  `);
  return [...result][0];
}

function stateFrom(key: FeatureFlagKey, row: FlagRow | undefined): FeatureFlagState {
  if (row === undefined) {
    return { key, enabled: FEATURE_FLAGS[key].default, value: null, source: 'default' };
  }
  return { key, enabled: row.enabled, value: row.value ?? null, source: 'org' };
}
