import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { databaseEnv, databaseUrls, serverEnv } from './preview-stack.mjs';

/**
 * The preview drops and recreates its database. These are the guards that keep it from
 * ever doing that to anything but a preview database.
 */

const KEYS = ['DATABASE_ADMIN_URL', 'DATABASE_OWNER_URL', 'DATABASE_URL', 'DATABASE_ANALYTICS_URL'];
const saved = {};

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  process.env.DATABASE_ADMIN_URL = 'postgres://postgres:root@localhost:5432/elysium_dev';
  process.env.DATABASE_OWNER_URL = 'postgres://erp_owner:owner@localhost:5432/elysium_dev';
  process.env.DATABASE_URL = 'postgres://erp_app:app@localhost:5432/elysium_dev';
  process.env.DATABASE_ANALYTICS_URL = 'postgres://erp_analytics:an@localhost:5432/elysium_dev';
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('databaseUrls', () => {
  it.each(['elysium_dev', 'postgres', 'template1', 'elysium', 'preview', 'elysium_preview-x'])(
    'refuses %s',
    (name) => {
      expect(() => databaseUrls(name)).toThrow(/elysium_preview/);
    },
  );

  it('points every role at the preview database, and keeps the roles and passwords', () => {
    const urls = databaseUrls('elysium_preview_e2e');
    expect(urls.database).toBe('elysium_preview_e2e');
    expect(urls.admin).toBe('postgres://postgres:root@localhost:5432/elysium_preview_e2e');
    expect(urls.owner).toBe('postgres://erp_owner:owner@localhost:5432/elysium_preview_e2e');
    expect(urls.app).toBe('postgres://erp_app:app@localhost:5432/elysium_preview_e2e');
    expect(urls.analytics).toBe('postgres://erp_analytics:an@localhost:5432/elysium_preview_e2e');
  });

  it('refuses a Postgres that is not on this machine', () => {
    process.env.DATABASE_OWNER_URL = 'postgres://erp_owner:owner@db.example.com:5432/elysium';
    expect(() => databaseUrls('elysium_preview')).toThrow(/db\.example\.com/);
  });

  it('creates and drops from the server’s maintenance database, never the developer’s', () => {
    expect(databaseUrls('elysium_preview').maintenance).toBe(
      'postgres://postgres:root@localhost:5432/postgres',
    );
  });
});

describe('serverEnv', () => {
  it('names this preview’s database, ports and origins, and nothing of the dev stack’s', () => {
    const urls = databaseUrls('elysium_preview');
    const env = serverEnv(urls, { api: 3130, console: 5193, portal: 5194, pos: 5195 });
    expect(env).toMatchObject({
      ...databaseEnv(urls),
      API_PORT: '3130',
      API_PUBLIC_URL: 'http://localhost:3130',
      TRUSTED_ORIGINS: 'http://localhost:5193,http://localhost:5194,http://localhost:5195',
      REALTIME_ADAPTER_KEY: 'preview:elysium_preview',
      PREVIEW_PORTAL_URL: 'http://localhost:5194',
    });
    for (const value of Object.values(databaseEnv(urls))) {
      expect(value).not.toContain('elysium_dev');
    }
  });
});
