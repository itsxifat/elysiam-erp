import { seedOrganizations, seedTrainingOrg, TRAINING_ORG_SLUG, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  auditRowsFor,
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { fingerprint, orgIdOf } from './signature.js';
import { signedGet } from './storefront.testing.js';
import {
  WEBSITE_CLI_ACTOR,
  WebsiteAdminRefused,
  websiteKeyCommand,
  websiteSiteUrlCommand,
  type CommandOutput,
} from './website-admin.js';

/**
 * The brand's website connected from the server (D-582): `main.admin.ts`'s `website-key` and
 * `website-site-url`, on real PostgreSQL holding one brand beside the training org, the way a
 * brand's own ERP does (D-470).
 *
 * The commands are called in this process, as `main.admin.ts` calls them, with their output
 * captured. Their key is then used the way the website uses it: a signed read through the
 * real application and its signature guard.
 */

let harness: HttpHarness;
let admin: RoleClient;
const saved = {
  slug: process.env.ERP_BRAND_SLUG,
  master: process.env.INTAKE_KEY_SECRET,
};

function captured(): CommandOutput & { stdout: () => string; stderr: () => string } {
  let out = '';
  let err = '';
  return {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
    stdout: () => out,
    stderr: () => err,
  };
}

/** A command's stdout as the two env lines it must be, or the test fails. */
function envLines(stdout: string): { keyId: string; secret: string } {
  expect(stdout.endsWith('\n')).toBe(true);
  const lines = stdout.slice(0, -1).split('\n');
  expect(lines).toHaveLength(2);
  const match = /^ERP_SITE_KEY_ID=(pk_\S+)\nERP_SITE_SECRET=(sk_[A-Za-z0-9_-]+)\n$/.exec(stdout);
  expect(match, stdout).not.toBeNull();
  return { keyId: match?.[1] ?? '', secret: match?.[2] ?? '' };
}

async function siteKeys(): Promise<
  { key_id: string; label: string; created_by: string; secret_sha256: string }[]
> {
  const rows = await withSystem(
    async (tx) =>
      tx.execute<{ key_id: string; label: string; created_by: string; secret_sha256: string }>(sql`
        select key_id, label, created_by, secret_sha256 from storefront.site_keys
        where org_id = ${ORG_A} order by created_at
      `),
    { orgId: ORG_A },
  );
  return [...rows];
}

async function settingsAudit() {
  return (await auditRowsFor(ORG_A, ORG_A)).filter(
    (row) => row.action === 'storefront.settings_updated',
  );
}

/** Transactions in this test database waiting for an advisory lock. */
async function advisoryWaiters(): Promise<number> {
  const rows = await withSystem(async (tx) =>
    tx.execute<{ n: number }>(sql`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted
        and database = (select oid from pg_database where datname = current_database())
    `),
  );
  return rows[0]?.n ?? 0;
}

async function setActive(active: boolean): Promise<void> {
  await withSystem(async (tx) => {
    await tx.execute(sql`update org.organizations set is_active = ${active} where id = ${ORG_A}`);
  });
}

async function refusal(run: Promise<unknown>): Promise<Error> {
  const error = await run.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(WebsiteAdminRefused);
  return error as Error;
}

beforeAll(async () => {
  delete process.env.ERP_BRAND_SLUG;
  harness = await startHttpHarness('website_admin', { brands: ['elysium-lifestyle-bd'] });
  await seedTrainingOrg();
  admin = await harness.asRole('org_admin', ORG_A);
}, 300_000);

afterAll(async () => {
  if (saved.slug === undefined) delete process.env.ERP_BRAND_SLUG;
  else process.env.ERP_BRAND_SLUG = saved.slug;
  if (saved.master === undefined) delete process.env.INTAKE_KEY_SECRET;
  else process.env.INTAKE_KEY_SECRET = saved.master;
  await harness.close();
}, 60_000);

describe('website-key', () => {
  it('prints exactly the two env lines, and the key signs a read of the website API', async () => {
    const io = captured();
    await websiteKeyCommand('Demo website', io);

    const key = envLines(io.stdout());
    expect(orgIdOf(key.keyId)).toBe(ORG_A);

    // The operator sees the key id, never the secret.
    expect(io.stderr()).toContain(key.keyId);
    expect(io.stderr()).not.toContain(key.secret);

    // Through the real application: the storefront signature guard accepts it.
    const site = await signedGet(harness.server, key, '/storefront/v1/site');
    expect(site.statusCode, site.body).toBe(200);
    const wrong = await signedGet(
      harness.server,
      { keyId: key.keyId, secret: `${key.secret}x` },
      '/storefront/v1/site',
    );
    expect(wrong.statusCode).toBe(401);

    // The row the console's Website → Connection writes, with a system actor.
    const row = (await siteKeys()).find((candidate) => candidate.key_id === key.keyId);
    expect(row).toMatchObject({
      label: 'Demo website',
      created_by: WEBSITE_CLI_ACTOR,
      secret_sha256: fingerprint(key.secret),
    });

    // And it is listed there like any other key, without a secret.
    const listed = await admin.client.request('GET', '/v1/storefront/site-keys');
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.body).toContain(key.keyId);
    expect(listed.body).not.toContain(key.secret);
  });

  it('audits the key inside the write with a system actor, via the CLI, and no secret', async () => {
    const io = captured();
    await websiteKeyCommand('Audited from the server', io);
    const key = envLines(io.stdout());

    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ actor_user_id: string | null; operation: string; after: unknown }>(sql`
          select actor_user_id, operation::text as operation, after from audit.audit_log
          where org_id = ${ORG_A} and action = 'storefront.site_key_issued'
            and after->>'keyId' = ${key.keyId}
        `),
      { orgId: ORG_A },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: WEBSITE_CLI_ACTOR,
      operation: 'create',
      after: { label: 'Audited from the server', keyId: key.keyId, via: 'cli' },
    });
    expect(JSON.stringify(rows)).not.toContain(key.secret);
    expect(JSON.stringify(rows)).not.toContain(key.secret.slice(3));
  });

  it('works with ERP_BRAND_SLUG naming the brand, as a brand deployment sets it', async () => {
    process.env.ERP_BRAND_SLUG = 'elysium-lifestyle-bd';
    try {
      const io = captured();
      await websiteKeyCommand('Named brand', io);
      expect(orgIdOf(envLines(io.stdout()).keyId)).toBe(ORG_A);
    } finally {
      delete process.env.ERP_BRAND_SLUG;
    }
  });

  it('refuses without INTAKE_KEY_SECRET, issuing nothing and printing nothing', async () => {
    const before = (await siteKeys()).length;
    const master = process.env.INTAKE_KEY_SECRET;
    delete process.env.INTAKE_KEY_SECRET;
    try {
      const io = captured();
      const error = await refusal(websiteKeyCommand('No master key', io));
      expect(error.message).toContain('INTAKE_KEY_SECRET is not set');
      expect(io.stdout()).toBe('');
    } finally {
      if (master !== undefined) process.env.INTAKE_KEY_SECRET = master;
    }
    expect(await siteKeys()).toHaveLength(before);
  });

  it('refuses a missing or empty label', async () => {
    const io = captured();
    await refusal(websiteKeyCommand(undefined, io));
    await refusal(websiteKeyCommand('   ', io));
    expect(io.stdout()).toBe('');
  });
});

describe('website-site-url', () => {
  it('saves the Site URL as a console save does, keeping the other site details', async () => {
    // Somebody filled in the site details on Website → Settings first.
    const current = await admin.client.request('GET', '/v1/storefront/settings');
    expect(current.statusCode, current.body).toBe(200);
    const siteInfo = (JSON.parse(current.body) as { siteInfo: Record<string, unknown> }).siteInfo;
    const typed = await admin.client.request('PATCH', '/v1/storefront/settings', {
      body: { siteInfo: { ...siteInfo, phone: '09678-000000', address: 'Dhanmondi, Dhaka' } },
    });
    expect(typed.statusCode, typed.body).toBe(200);

    const io = captured();
    await websiteSiteUrlCommand('https://demo.example.com/', io);
    expect(io.stdout()).toBe('https://demo.example.com\n');

    const after = await admin.client.request('GET', '/v1/storefront/settings');
    expect(JSON.parse(after.body)).toMatchObject({
      siteInfo: {
        siteUrl: 'https://demo.example.com',
        phone: '09678-000000',
        address: 'Dhanmondi, Dhaka',
      },
    });

    const last = (await settingsAudit()).at(-1);
    expect(last).toMatchObject({
      actor_user_id: WEBSITE_CLI_ACTOR,
      operation: 'update',
      after: { sections: ['siteInfo'], siteUrl: 'https://demo.example.com', via: 'cli' },
      before: { siteUrl: '' },
    });
  });

  it('refuses anything but an https address, saving nothing', async () => {
    const before = (await settingsAudit()).length;
    for (const url of [
      'http://demo.example.com',
      'http://localhost:3000',
      'demo.example.com',
      'javascript:alert(1)',
      'https://demo.example.com/?ref=1',
      'https://demo.example.com/#top',
      'https://user:pass@demo.example.com',
      '',
    ]) {
      const io = captured();
      await refusal(websiteSiteUrlCommand(url, io));
      expect(io.stdout()).toBe('');
    }
    await refusal(websiteSiteUrlCommand(undefined, captured()));
    expect(await settingsAudit()).toHaveLength(before);
    const after = await admin.client.request('GET', '/v1/storefront/settings');
    expect(JSON.parse(after.body)).toMatchObject({
      siteInfo: { siteUrl: 'https://demo.example.com' },
    });
  });

  it('reads the other site details inside the save lock, so a save it waited for is kept', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let taken: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      taken = resolve;
    });

    // A console save in flight: it holds the brand's settings lock (`lockSettings`) and is
    // about to change the phone.
    const consoleSave = withSystem(
      async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`storefront.settings:${ORG_A}`}, 0))`,
        );
        taken();
        await held;
        await tx.execute(sql`
          update storefront.settings
          set site_info = site_info || ${JSON.stringify({ phone: '09678-222222' })}::jsonb
          where org_id = ${ORG_A}
        `);
      },
      { orgId: ORG_A },
    );
    await lockTaken;

    const io = captured();
    const command = websiteSiteUrlCommand('https://race.example.com', io);
    // Only once the command is queued behind the lock does the console save finish.
    await expect.poll(advisoryWaiters, { timeout: 20_000, interval: 100 }).toBeGreaterThan(0);
    release();
    await consoleSave;
    await command;

    expect(io.stdout()).toBe('https://race.example.com\n');
    const after = await admin.client.request('GET', '/v1/storefront/settings');
    expect(JSON.parse(after.body)).toMatchObject({
      siteInfo: { siteUrl: 'https://race.example.com', phone: '09678-222222' },
    });
  });
});

describe('which brand', () => {
  it('refuses a switched-off brand, and the training org named as the brand', async () => {
    const io = captured();
    await setActive(false);
    try {
      const off = await refusal(websiteKeyCommand('Switched off', io));
      expect(off.message).toContain('switched off');
    } finally {
      await setActive(true);
    }

    process.env.ERP_BRAND_SLUG = TRAINING_ORG_SLUG;
    try {
      const training = await refusal(websiteSiteUrlCommand('https://training.example.com', io));
      expect(training.message).toContain('training organization');
    } finally {
      delete process.env.ERP_BRAND_SLUG;
    }
    expect(io.stdout()).toBe('');
  });

  it('refuses when the database holds a second brand, named or not', async () => {
    await seedOrganizations({ brands: ['oura-lifestyle'] });
    const before = (await siteKeys()).length;

    const io = captured();
    const unnamed = await refusal(websiteKeyCommand('Ambiguous', io));
    expect(unnamed.message).toContain('2 brands');
    expect(unnamed.message).toContain('ERP_BRAND_SLUG');

    process.env.ERP_BRAND_SLUG = 'elysium-lifestyle-bd';
    try {
      const named = await refusal(websiteSiteUrlCommand('https://other.example.com', io));
      expect(named.message).toContain('1 other brand (oura-lifestyle)');
    } finally {
      delete process.env.ERP_BRAND_SLUG;
    }

    expect(io.stdout()).toBe('');
    expect(await siteKeys()).toHaveLength(before);
  });
});
