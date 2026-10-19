import { randomUUID } from 'node:crypto';

import { withGlobal, withOrg, withSystem } from '@elysium/db';
import { createTestUser, grantMembership } from '@elysium/db/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { IamApiService } from './iam.api.js';

/**
 * The names behind staff ids (D-898) against real Postgres: a super admin with no role, a
 * leaver whose role and account are switched off and an owner are all named, the owner only to
 * another owner; a person of another brand alone is not, and a partner is handed no names.
 */

let harness: HttpHarness;
let sales: RoleClient;
const people = { superAdmin: '', leaver: '', owner: '', otherBrand: '' };

interface Named {
  readonly userId: string;
  readonly name: string | null;
  readonly owner: boolean;
}

beforeAll(async () => {
  harness = await startHttpHarness('staff-names');
  sales = await harness.asRole('sales', ORG_A);

  people.superAdmin = (await createTestUser({ name: 'Rafi Super', isSuperAdmin: true })).id;

  const leaver = await createTestUser({ name: 'Mina Leaver' });
  await grantMembership({ userId: leaver.id, orgId: ORG_A, role: 'sales' });
  await withOrg({ orgId: ORG_A, userId: leaver.id }, (tx) =>
    tx.execute(sql`update iam.memberships set is_active = false where user_id = ${leaver.id}`),
  );
  await withGlobal((tx) =>
    tx.execute(sql`update iam.users set is_active = false where id = ${leaver.id}`),
  );
  people.leaver = leaver.id;

  // Only the owner role makes an owner (0106).
  people.owner = `usr_${randomUUID()}`;
  await withSystem((tx) =>
    tx.execute(sql`
      insert into iam.users (id, email, name, email_verified, is_super_admin, is_owner)
      values (${people.owner}, ${`${people.owner}@example.invalid`}, 'Olivia Owner', true, true, true)
    `),
  );

  const other = await createTestUser({ name: 'Bina Other' });
  await grantMembership({ userId: other.id, orgId: ORG_B, role: 'sales' });
  people.otherBrand = other.id;
}, 300_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('GET /v1/staff-names', () => {
  it('names a super admin, a leaver and the caller; an owner is "Owner"; another brand is not', async () => {
    const ids = [
      people.superAdmin,
      people.leaver,
      people.owner,
      people.otherBrand,
      sales.userId,
      'intake:site-key',
    ];
    const response = await sales.client.request(
      'GET',
      `/v1/staff-names?ids=${encodeURIComponent(ids.join(','))}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    const { people: named } = JSON.parse(response.body) as { people: Named[] };
    const byId = new Map(named.map((person) => [person.userId, person]));

    expect(byId.get(people.superAdmin)).toEqual({
      userId: people.superAdmin,
      name: 'Rafi Super',
      owner: false,
    });
    expect(byId.get(people.leaver)?.name).toBe('Mina Leaver');
    expect(byId.get(people.owner)).toEqual({ userId: people.owner, name: null, owner: true });
    expect(byId.has(sales.userId)).toBe(true);
    expect(byId.has(people.otherBrand)).toBe(false);
    expect(named).toHaveLength(4);
  });

  it('hands a partner outside the company no names', async () => {
    const investor = await harness.asRole('investor', ORG_A);
    const response = await investor.client.request(
      'GET',
      `/v1/staff-names?ids=${encodeURIComponent(people.superAdmin)}`,
    );
    expect(response.statusCode, response.body).toBe(200);
    expect(JSON.parse(response.body)).toEqual({ people: [] });
  });
});

describe('the name book other modules name people from', () => {
  it('holds everyone of record in the brand, an owner as "Owner", nobody of another brand', async () => {
    const book = await withOrg({ orgId: ORG_A, userId: sales.userId }, (tx) =>
      new IamApiService().nameBook(tx, ORG_A),
    );
    expect(book.get(people.superAdmin)).toBe('Rafi Super');
    expect(book.get(people.leaver)).toBe('Mina Leaver');
    expect(book.get(people.owner)).toBe('Owner');
    expect(book.has(people.otherBrand)).toBe(false);
  });
});
