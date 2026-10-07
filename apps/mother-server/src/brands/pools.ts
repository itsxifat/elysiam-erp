import type { Sql } from 'postgres';

import type { SecretsKey } from '../crypto/secrets.js';
import { connectBrand, type BrandConnectionOptions } from './reader.js';
import { readConnectionOf, type BrandRow } from './registry.js';

/**
 * One small pool per brand, opened on first use and replaced when the brand's connection
 * changes (its fingerprint moves). Each process (the API for live lists, the worker for
 * pulls) keeps its own.
 */
export class BrandPools {
  private readonly pools = new Map<string, { readonly fingerprint: string; readonly sql: Sql }>();

  constructor(
    private readonly secrets: () => SecretsKey,
    private readonly options: BrandConnectionOptions,
  ) {}

  for(brand: BrandRow): Sql {
    const existing = this.pools.get(brand.id);
    if (existing?.fingerprint === brand.read_connection_fingerprint) return existing.sql;
    if (existing !== undefined) {
      this.pools.delete(brand.id);
      void existing.sql.end({ timeout: 2 });
    }
    const sql = connectBrand(readConnectionOf(this.secrets(), brand), this.options);
    this.pools.set(brand.id, { fingerprint: brand.read_connection_fingerprint, sql });
    return sql;
  }

  /** A one-off connection for a test, closed by the caller. */
  open(url: string): Sql {
    return connectBrand(url, this.options);
  }

  async closeAll(): Promise<void> {
    const open = [...this.pools.values()];
    this.pools.clear();
    await Promise.all(open.map(async (pool) => pool.sql.end({ timeout: 2 })));
  }
}
