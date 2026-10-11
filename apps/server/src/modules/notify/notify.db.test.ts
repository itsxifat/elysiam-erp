import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { banglaCharactersIn } from '@elysium/domain';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { ORG_A, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { NOTIFY_QUEUES } from './notify.queues.js';
import { NotifyService } from './notify.service.js';
import { FakeSmsGateway, SMS_GATEWAY } from './providers/sms-gateway.js';

/**
 * The notify module against real Postgres (M16 check 4, and what the module promises).
 *
 * Every instant below is a fixed UTC moment, so the tests do not depend on the hour they
 * run at. Asia/Dhaka is UTC+6 with no daylight saving, which is what makes these exact:
 *
 *   2026-10-02T06:00Z = 12:00 Dhaka  (open)
 *   2026-10-02T16:00Z = 22:00 Dhaka  (quiet, evening)
 *   2026-10-02T20:00Z = 02:00 Dhaka on the 3rd  (quiet, small hours)
 *   2026-10-03T03:00Z = 09:00 Dhaka on the 3rd  (quiet hours end)
 *
 * The phone numbers are test values for this suite, not anybody's.
 */

const NOON = new Date('2026-10-02T06:00:00.000Z');
const EVENING = new Date('2026-10-02T16:00:00.000Z');
const SMALL_HOURS = new Date('2026-10-02T20:00:00.000Z');
const NINE_NEXT_DAY = new Date('2026-10-03T03:00:00.000Z');

const PHONE = '01700000001';
const OPTED_OUT = '01700000002';

let harness: HttpHarness;
let jobs: JobsRuntime;
let notify: NotifyService;
let gateway: FakeSmsGateway;

async function template(key: string, category: 'otp' | 'transactional' | 'marketing') {
  await withSystem(
    (tx) =>
      tx.execute(sql`
        insert into notify.templates (org_id, key, channel, category, body_bn, body_en, updated_by)
        values (${ORG_A}, ${key}, 'sms', ${category},
                ${'আপনার কোড {code}'}, ${'Your code is {code}'}, 'usr_notify_test')
        on conflict (org_id, channel, key) do update set category = excluded.category
      `),
    { orgId: ORG_A },
  );
}

async function queueAt(templateKey: string, phone: string, now: Date) {
  return withOrg({ orgId: ORG_A, userId: 'usr_notify_test' }, (tx) =>
    notify.queue(tx, ORG_A, {
      templateKey,
      phone,
      values: { code: 'EID25' },
      now,
    }),
  );
}

async function stateOf(messageId: string): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ state: string }>(
          sql`select state from notify.messages where org_id = ${ORG_A} and id = ${messageId}`,
        )
      )[0]?.state ?? 'missing',
    { orgId: ORG_A },
  );
}

beforeAll(async () => {
  harness = await startHttpHarness('notify-db');
  // `queue` enqueues in the caller's transaction, so a runtime must exist. The worker role
  // is what installs pg-boss's schema in this throwaway database, and it processes a queue
  // only once `work()` attaches a handler — which this suite never does. So nothing sends
  // behind the test's back: every `deliver` below is called explicitly, at an instant the
  // test chooses.
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: NOTIFY_QUEUES,
    logger: pino({ level: 'silent' }),
  });
  notify = harness.app.get(NotifyService);
  const bound: unknown = harness.app.get(SMS_GATEWAY, { strict: false });
  if (!(bound instanceof FakeSmsGateway)) throw new Error('the suite expects the fake gateway');
  gateway = bound;

  await template('offer.weekend', 'marketing');
  await template('auth.code', 'otp');
  await withSystem(
    (tx) =>
      tx.execute(sql`
        insert into notify.opt_outs (org_id, phone, channel, created_by)
        values (${ORG_A}, ${OPTED_OUT}, 'sms', 'usr_notify_test')
        on conflict do nothing
      `),
    { orgId: ORG_A },
  );
}, 600_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 120_000);

beforeEach(() => {
  gateway.clear();
});

describe('quiet hours (check 4)', () => {
  it('holds an offer due at 22:00 Dhaka until 09:00 the next morning', async () => {
    const queued = await queueAt('offer.weekend', PHONE, EVENING);
    expect(queued.state).toBe('queued');
    expect(queued.sendAfter.toISOString()).toBe(NINE_NEXT_DAY.toISOString());
  });

  it('holds one due at 02:00 until 09:00 the same morning, not the next', async () => {
    const queued = await queueAt('offer.weekend', PHONE, SMALL_HOURS);
    expect(queued.sendAfter.toISOString()).toBe(NINE_NEXT_DAY.toISOString());
  });

  it('sends an offer due at noon at noon', async () => {
    const queued = await queueAt('offer.weekend', PHONE, NOON);
    expect(queued.sendAfter.toISOString()).toBe(NOON.toISOString());
  });

  it('never holds a sign-in code: a person locked out at 22:00 is locked out', async () => {
    const queued = await queueAt('auth.code', PHONE, EVENING);
    expect(queued.state).toBe('queued');
    expect(queued.sendAfter.toISOString()).toBe(EVENING.toISOString());
  });

  it('checks again at send time: a job that runs late into the night defers, and sends nothing', async () => {
    // Queued at noon, so due at once — but the worker only reaches it at 22:00.
    const queued = await queueAt('offer.weekend', PHONE, NOON);

    const outcome = await notify.deliver(ORG_A, queued.messageId, EVENING);

    expect(outcome).toBe('deferred');
    expect(gateway.sent).toEqual([]);
    expect(await stateOf(queued.messageId)).toBe('queued');
    const sendAfter = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ send_after: Date }>(
            sql`select send_after from notify.messages where org_id = ${ORG_A} and id = ${queued.messageId}`,
          )
        )[0]?.send_after,
      { orgId: ORG_A },
    );
    expect(new Date(sendAfter ?? 0).toISOString()).toBe(NINE_NEXT_DAY.toISOString());
  });

  it('sends a sign-in code at 22:00 when the worker reaches it then', async () => {
    const queued = await queueAt('auth.code', PHONE, EVENING);
    expect(await notify.deliver(ORG_A, queued.messageId, EVENING)).toBe('sent');
    expect(gateway.sent).toHaveLength(1);
  });
});

describe('sending', () => {
  it('sends in the open hours, records the provider id, and does it once', async () => {
    const queued = await queueAt('offer.weekend', PHONE, NOON);

    expect(await notify.deliver(ORG_A, queued.messageId, NOON)).toBe('sent');
    expect(gateway.sent).toEqual([{ phone: PHONE, body: 'Your code is EID25' }]);
    expect(await stateOf(queued.messageId)).toBe('sent');

    // A redelivered job after a crash finds it sent and leaves it alone.
    expect(await notify.deliver(ORG_A, queued.messageId, NOON)).toBe('skipped');
    expect(gateway.sent).toHaveLength(1);
  });

  it('suppresses an offer to a number that opted out, but never a sign-in code', async () => {
    const offer = await queueAt('offer.weekend', OPTED_OUT, NOON);
    expect(offer.state).toBe('suppressed');
    expect(await notify.deliver(ORG_A, offer.messageId, NOON)).toBe('skipped');
    expect(gateway.sent).toEqual([]);

    const code = await queueAt('auth.code', OPTED_OUT, NOON);
    expect(code.state).toBe('queued');
    expect(await notify.deliver(ORG_A, code.messageId, NOON)).toBe('sent');
  });

  it('throws on a failure worth retrying, so the queue tries again, and then sends', async () => {
    const queued = await queueAt('offer.weekend', PHONE, NOON);
    gateway.failNext.push({ ok: false, error: 'TIMEOUT', retryable: true });

    await expect(notify.deliver(ORG_A, queued.messageId, NOON)).rejects.toThrow(/will retry/);
    expect(await stateOf(queued.messageId)).toBe('failed');

    // The retry: a failed message is still deliverable.
    expect(await notify.deliver(ORG_A, queued.messageId, NOON)).toBe('sent');
    expect(await stateOf(queued.messageId)).toBe('sent');
  });

  it('records a refusal the gateway names, and does not retry it', async () => {
    const queued = await queueAt('offer.weekend', PHONE, NOON);
    gateway.failNext.push({ ok: false, error: 'INVALID_NUMBER', retryable: false });

    expect(await notify.deliver(ORG_A, queued.messageId, NOON)).toBe('failed');
    expect(await stateOf(queued.messageId)).toBe('failed');
  });

  it('refuses a template the brand does not have, rather than sending nothing quietly', async () => {
    await expect(queueAt('no.such.template', PHONE, NOON)).rejects.toMatchObject({
      code: 'NOTIFY_TEMPLATE_INVALID',
    });
  });
});

describe('what an opt-out leaves behind, and what it stops', () => {
  it('never writes the number into the append-only audit log as given (invariant 10)', async () => {
    const marketing = await harness.asRole('marketing', ORG_A);
    const number = '01700000377';
    const added = await marketing.client.request('POST', '/v1/notify/opt-outs', {
      body: { phone: number, reason: 'Asked by phone' },
    });
    expect(added.statusCode).toBe(201);
    const removed = await marketing.client.request('DELETE', `/v1/notify/opt-outs/${number}`);
    expect(removed.statusCode).toBe(200);

    const rows = await withSystem(
      (tx) =>
        tx.execute<{ entity_id: string; before: unknown; after: unknown }>(sql`
          select entity_id, before, after from audit.audit_log
          where org_id = ${ORG_A} and action like 'notify.opt_out.%'
            and actor_user_id = ${marketing.userId}
        `),
      { orgId: ORG_A },
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.entity_id).not.toMatch(/01700000377|8801700000377/);
      expect(JSON.stringify([row.before, row.after])).not.toContain('01700000377');
    }
  });

  it('suppresses an offer whose number opted out after it was queued, and sends nothing', async () => {
    const number = '01700000378';
    // Queued at 22:00, so held until 09:00 — the window an opt-out can arrive in.
    const queued = await queueAt('offer.weekend', number, EVENING);
    expect(queued.state).toBe('queued');
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into notify.opt_outs (org_id, phone, channel, created_by)
          values (${ORG_A}, ${number}, 'sms', 'usr_notify_test')
        `),
      { orgId: ORG_A },
    );

    expect(await notify.deliver(ORG_A, queued.messageId, NINE_NEXT_DAY)).toBe('suppressed');
    expect(gateway.sent).toEqual([]);
    expect(await stateOf(queued.messageId)).toBe('suppressed');
    // Final: a redelivered job leaves it alone.
    expect(await notify.deliver(ORG_A, queued.messageId, NINE_NEXT_DAY)).toBe('skipped');
  });
});

describe('every SMS is English (M43, D-750)', () => {
  it('sends the English body, never the Bangla one a template still holds', async () => {
    // The suite's templates were written with a Bangla `body_bn` beside the English one.
    const queued = await queueAt('offer.weekend', PHONE, NOON);
    expect(await notify.deliver(ORG_A, queued.messageId, NOON)).toBe('sent');
    const sent = gateway.sent.at(-1)?.body ?? '';
    expect(sent).toBe('Your code is EID25');
    expect(banglaCharactersIn(sent)).toEqual([]);
    const stored = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ locale: string; body: string }>(
            sql`select locale, body from notify.messages where org_id = ${ORG_A} and id = ${queued.messageId}`,
          )
        )[0],
      { orgId: ORG_A },
    );
    expect(stored).toEqual({ locale: 'en', body: 'Your code is EID25' });
  });

  it('refuses to send from a template whose English body was stored in Bangla', async () => {
    const bangla = String.fromCodePoint(0x0995, 0x09cb, 0x09a1);
    await withSystem(
      (tx) =>
        tx.execute(sql`
          insert into notify.templates (org_id, key, channel, category, body_bn, body_en, updated_by)
          values (${ORG_A}, 'offer.legacy', 'sms', 'marketing',
                  ${`${bangla} {code}`}, ${`${bangla} {code}`}, 'usr_notify_test')
          on conflict (org_id, channel, key) do update set body_en = excluded.body_en
        `),
      { orgId: ORG_A },
    );
    await expect(queueAt('offer.legacy', PHONE, NOON)).rejects.toMatchObject({
      code: 'NOTIFY_TEMPLATE_INVALID',
    });
  });

  it('refuses a template written in Bangla, and saves an English one with one body', async () => {
    const marketing = await harness.asRole('marketing', ORG_A);
    const bangla = String.fromCodePoint(0x09b9, 0x09cd, 0x09af, 0x09be, 0x09b2, 0x09cb);
    const refused = await marketing.client.request('PUT', '/v1/notify/templates', {
      body: { key: 'offer.bangla', category: 'marketing', bodyEn: `${bangla} {name}` },
    });
    expect(refused.statusCode).toBeGreaterThanOrEqual(400);
    expect(refused.body).toContain('NOTIFY_TEMPLATE_INVALID');

    const saved = await marketing.client.request('PUT', '/v1/notify/templates', {
      body: { key: 'offer.english', category: 'marketing', bodyEn: 'Hello {name}' },
    });
    expect(saved.statusCode, saved.body).toBeLessThan(300);
    const listed = await marketing.client.request('GET', '/v1/notify/templates');
    const row = (
      JSON.parse(listed.body) as { items: { key: string; bodyEn: string; bodyBn?: string }[] }
    ).items.find((item) => item.key === 'offer.english');
    expect(row?.bodyEn).toBe('Hello {name}');
    expect(row).not.toHaveProperty('bodyBn');
  });
});

describe('a template’s category is not a marketer’s to turn into a sign-in code (W4)', () => {
  it('refuses otp over HTTP, and refuses to overwrite a sign-in template', async () => {
    const marketing = await harness.asRole('marketing', ORG_A);
    const asOtp = await marketing.client.request('PUT', '/v1/notify/templates', {
      body: {
        key: 'occasion.sneaky',
        category: 'otp',
        bodyEn: 'Code {code}',
      },
    });
    expect(asOtp.statusCode).toBe(400);

    // `auth.code` is the suite's sign-in template; turning it into an offer would hold
    // sign-in codes overnight.
    const overwrite = await marketing.client.request('PUT', '/v1/notify/templates', {
      body: { key: 'auth.code', category: 'marketing', bodyEn: 'Offer' },
    });
    expect(overwrite.statusCode).toBeGreaterThanOrEqual(400);
    expect(overwrite.body).toContain('NOTIFY_TEMPLATE_INVALID');
  });

  it('refuses a message whose template is not the kind the caller says it is sending', async () => {
    await expect(
      withOrg({ orgId: ORG_A, userId: 'usr_notify_test' }, (tx) =>
        notify.queue(tx, ORG_A, {
          templateKey: 'auth.code',
          phone: PHONE,
          values: { code: 'X' },
          category: 'marketing',
          now: NOON,
        }),
      ),
    ).rejects.toMatchObject({ code: 'NOTIFY_TEMPLATE_INVALID' });
  });
});
