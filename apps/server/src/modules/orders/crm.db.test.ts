import { withSystem } from '@elysium/db';
import { toIsoDate } from '@elysium/domain';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { ORG_A, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { NOTIFY_QUEUES } from '../notify/notify.queues.js';
import { CRM_QUEUE_DEFINITIONS, CRM_QUEUES } from './crm.queues.js';
import { CrmService, OCCASION_TEMPLATES } from './crm.service.js';
import { seedCustomer } from './orders.testing.js';

/**
 * The CRM's jobs against real Postgres (M16 checks 1 and 2).
 *
 * Every date is fixed, so nothing here depends on the day it runs. The phones are test
 * values for this suite, not anybody's.
 */

const TODAY = toIsoDate('2026-10-02');
const NOON = new Date('2026-10-02T06:00:00.000Z');

let harness: HttpHarness;
let jobs: JobsRuntime;
let crm: CrmService;

async function setDates(customerId: string, birthday: string | null, anniversary: string | null) {
  await withSystem(
    (tx) =>
      tx.execute(sql`
        update sales.customers set birthday = ${birthday}, anniversary = ${anniversary}
        where org_id = ${ORG_A} and id = ${customerId}
      `),
    { orgId: ORG_A },
  );
}

/** What check 2 counts: codes, messages and greeting rows for one buyer and occasion. */
async function issuedFor(customerId: string, occasion: string) {
  return withSystem(
    async (tx) => {
      const [codes] = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from promo.codes
        where org_id = ${ORG_A} and customer_id = ${customerId} and origin = 'occasion'
      `);
      const [messages] = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from notify.messages m
        where m.org_id = ${ORG_A} and m.ref_type = 'occasion'
          and m.ref_id in (select id from promo.codes
                           where org_id = ${ORG_A} and customer_id = ${customerId})
      `);
      const [issues] = await tx.execute<{ n: number }>(sql`
        select count(*)::int as n from sales.occasion_issues
        where org_id = ${ORG_A} and customer_id = ${customerId} and occasion = ${occasion}
      `);
      return { codes: codes?.n ?? -1, messages: messages?.n ?? -1, issues: issues?.n ?? -1 };
    },
    { orgId: ORG_A },
  );
}

beforeAll(async () => {
  harness = await startHttpHarness('crm-db');
  // `notify.queue` enqueues in the greeting's transaction. The worker role installs
  // pg-boss's schema; no handler is attached, so nothing is sent behind the test's back.
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [...NOTIFY_QUEUES, ...CRM_QUEUE_DEFINITIONS],
    logger: pino({ level: 'silent' }),
  });
  crm = harness.app.get(CrmService);

  // The templates a brand needs before it can greet anybody.
  await withSystem(
    async (tx) => {
      for (const [occasion, key] of Object.entries(OCCASION_TEMPLATES)) {
        await tx.execute(sql`
          insert into notify.templates (org_id, key, channel, category, body_bn, body_en, updated_by)
          values (${ORG_A}, ${key}, 'sms', 'marketing',
                  ${`শুভ ${occasion}, {name}! আপনার কোড {code}`},
                  ${`Happy ${occasion}, {name}! Your code is {code}`}, 'usr_crm_test')
          on conflict (org_id, key, channel) do nothing
        `);
      }
    },
    { orgId: ORG_A },
  );
}, 600_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 120_000);

describe('occasions (check 2): one code and one message per buyer per occasion per year', () => {
  it('greets a birthday once, however often the job runs that day', async () => {
    const buyer = await seedCustomer(ORG_A, { phoneE164: '+8801700000201', name: 'Rina' });
    await setDates(buyer, '1990-10-02', null);

    const first = await crm.runOccasions(ORG_A, TODAY, NOON);
    expect(first.failed).toEqual([]);
    expect(first.greeted).toBeGreaterThanOrEqual(1);
    expect(await issuedFor(buyer, 'birthday')).toEqual({ codes: 1, messages: 1, issues: 1 });

    const second = await crm.runOccasions(ORG_A, TODAY, NOON);
    expect(second.greeted).toBe(0);
    expect(second.alreadyGreeted).toBeGreaterThanOrEqual(1);
    expect(await issuedFor(buyer, 'birthday')).toEqual({ codes: 1, messages: 1, issues: 1 });
  });

  it('leaves nothing behind when two runs race: the loser rolls back its code and its message', async () => {
    const buyer = await seedCustomer(ORG_A, { phoneE164: '+8801700000202', name: 'Karim' });
    await setDates(buyer, null, '2015-10-02');

    // Both start before either has written, so both pass the fast path; the unique index
    // on (org, customer, occasion, year) decides, and the loser's transaction — code,
    // message and greeting row together — is the one that never happened.
    const [a, b] = await Promise.all([
      crm.runOccasions(ORG_A, TODAY, NOON),
      crm.runOccasions(ORG_A, TODAY, NOON),
    ]);
    expect([...a.failed, ...b.failed]).toEqual([]);
    expect(await issuedFor(buyer, 'anniversary')).toEqual({ codes: 1, messages: 1, issues: 1 });
  });

  it('greets a buyer with both occasions today once for each', async () => {
    const buyer = await seedCustomer(ORG_A, { phoneE164: '+8801700000203', name: 'Mitu' });
    await setDates(buyer, '1988-10-02', '2012-10-02');

    await crm.runOccasions(ORG_A, TODAY, NOON);

    expect(await issuedFor(buyer, 'birthday')).toMatchObject({ issues: 1 });
    expect(await issuedFor(buyer, 'anniversary')).toMatchObject({ issues: 1 });
    // Two occasions, so two codes and two messages for this buyer in all.
    const all = await issuedFor(buyer, 'birthday');
    expect(all.codes).toBe(2);
    expect(all.messages).toBe(2);
  });

  it('greets again next year, and not a buyer whose day is not today', async () => {
    const buyer = await seedCustomer(ORG_A, { phoneE164: '+8801700000204', name: 'Shila' });
    await setDates(buyer, '1995-10-02', null);
    const notToday = await seedCustomer(ORG_A, { phoneE164: '+8801700000205', name: 'Babu' });
    await setDates(notToday, '1995-11-02', null);

    await crm.runOccasions(ORG_A, TODAY, NOON);
    await crm.runOccasions(ORG_A, toIsoDate('2027-10-02'), new Date('2027-10-02T06:00:00Z'));

    expect(await issuedFor(buyer, 'birthday')).toEqual({ codes: 2, messages: 2, issues: 2 });
    expect(await issuedFor(notToday, 'birthday')).toEqual({ codes: 0, messages: 0, issues: 0 });
  });

  it('issues a personal single-use code that only that buyer can spend', async () => {
    const buyer = await seedCustomer(ORG_A, { phoneE164: '+8801700000206', name: 'Nila' });
    await setDates(buyer, '2000-10-02', null);

    await crm.runOccasions(ORG_A, TODAY, NOON);

    const [code] = await withSystem(
      (tx) =>
        tx.execute<{
          customer_id: string;
          total_limit: number;
          per_customer_limit: number;
          valid_from: string;
          valid_to: string;
        }>(sql`
          select customer_id, total_limit, per_customer_limit,
                 valid_from::text as valid_from, valid_to::text as valid_to
          from promo.codes where org_id = ${ORG_A} and customer_id = ${buyer}
        `),
      { orgId: ORG_A },
    );
    expect(code).toMatchObject({
      customer_id: buyer,
      total_limit: 1,
      per_customer_limit: 1,
      valid_from: '2026-10-02',
      valid_to: '2026-10-08',
    });
  });
});

describe('RFM (check 1, through the job): every buyer gets exactly one segment', () => {
  it('scores every buyer in the brand and replaces the segment on a rerun', async () => {
    const first = await crm.runRfm(ORG_A, TODAY);
    expect(first.scored).toBeGreaterThan(0);

    const [counts] = await withSystem(
      (tx) =>
        tx.execute<{ buyers: number; segments: number }>(sql`
          select (select count(*)::int from sales.customers where org_id = ${ORG_A}) as buyers,
                 (select count(*)::int from sales.customer_segments where org_id = ${ORG_A}) as segments
        `),
      { orgId: ORG_A },
    );
    expect(counts?.segments).toBe(counts?.buyers);

    // A second run replaces rather than adds.
    await crm.runRfm(ORG_A, TODAY);
    const [after] = await withSystem(
      (tx) =>
        tx.execute<{ segments: number }>(sql`
          select count(*)::int as segments from sales.customer_segments where org_id = ${ORG_A}
        `),
      { orgId: ORG_A },
    );
    expect(after?.segments).toBe(counts?.buyers);
  });
});

describe('the schedule: one job per brand, once a day', () => {
  it('enqueues one occasions job per active brand, and nothing more on a rerun the same day', async () => {
    const at = new Date('2026-10-02T03:00:00.000Z');
    const brands = await crm.fanOut('occasions', at);
    expect(brands).toBeGreaterThanOrEqual(5);

    const queued = async () =>
      withSystem(
        async (tx) =>
          (
            await tx.execute<{ n: number }>(sql`
              select count(*)::int as n from pgboss.job
              where name = ${CRM_QUEUES.occasions}
                and data->'payload'->>'today' = '2026-10-02'
            `)
          )[0]?.n ?? -1,
        { orgId: ORG_A },
      );
    expect(await queued()).toBe(brands);

    // The fan-out's own retry, or a second worker, collapses on the singleton key.
    await crm.fanOut('occasions', at);
    expect(await queued()).toBe(brands);
  });
});
