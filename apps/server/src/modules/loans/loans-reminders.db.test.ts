import { randomUUID } from 'node:crypto';

import { seedAccountId, withSystem } from '@elysium/db';
import { addDays, businessDate, toIsoDate, type IsoDate } from '@elysium/domain';
import { addMonthsClamped } from '@elysium/domain/loans';
import { sql } from 'drizzle-orm';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type InjectedResponse,
  type RoleClient,
} from '../../testing/http-harness.js';
import { NOTIFY_QUEUES } from '../notify/notify.queues.js';
import { LOANS_QUEUE_DEFINITIONS } from './loans.queues.js';
import { LOAN_REMINDER_TEMPLATE, LoanRemindersService } from './reminders.service.js';

/**
 * Loan reminders against real Postgres (M26 check 3: each reminder fires once per
 * instalment).
 *
 * A loan of three monthly instalments with a three-day reminder window and an SMS number.
 * The job is run for chosen Dhaka dates — before the window, inside it, twice on the same
 * day, twice at once, and on a later day that has passed two due dates — and after every
 * run each instalment has **at most one** reminder row, one SMS in the notify log and one
 * `loan.instalment_due` event in the outbox, and exactly one once its window has opened.
 *
 * Every instant is real time and every date is computed from the loan's own first due
 * date, so the suite does not depend on the day it runs. The phone numbers are test values
 * for this suite, not anybody's.
 */

let harness: HttpHarness;
let jobs: JobsRuntime;
let reminders: LoanRemindersService;
let accounts: RoleClient;
let otherBrand: RoleClient;

const BANK_A = seedAccountId(ORG_A, '1100');
const BANK_B = seedAccountId(ORG_B, '1100');
const PHONE = '01700000004';

function body<T>(response: InjectedResponse): T {
  return JSON.parse(response.body) as T;
}

interface Created {
  readonly loan: { readonly id: string };
  readonly instalments: readonly {
    readonly id: string;
    readonly seq: number;
    readonly dueOn: string;
  }[];
}

async function lender(client: RoleClient, name: string): Promise<string> {
  const response = await client.client.request('POST', '/v1/loans/lenders', {
    body: { name, kind: 'person' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return body<{ id: string }>(response).id;
}

async function loan(
  client: RoleClient,
  lenderId: string,
  bank: string,
  extra: Record<string, unknown>,
): Promise<Created> {
  const response = await client.client.request('POST', '/v1/loans', {
    body: {
      loanId: randomUUID(),
      lenderId,
      principalPoisha: '3000000',
      rateBps: 1800,
      method: 'reducing',
      tenureMonths: 3,
      walletAccountId: bank,
      reminderDays: 3,
      ...extra,
    },
  });
  expect(response.statusCode, response.body).toBe(201);
  return body<Created>(response);
}

/** Per instalment: reminder rows, SMS rows and outbox events about it. */
async function trail(orgId: string, instalmentId: string) {
  const [row] = await withSystem(
    (tx) =>
      tx.execute<{
        reminders: number;
        messages: number;
        events: number;
        sms_state: string | null;
      }>(sql`
        select
          (select count(*)::int from loans.reminders
            where org_id = ${orgId} and instalment_id = ${instalmentId}) as reminders,
          (select count(*)::int from notify.messages
            where org_id = ${orgId} and ref_type = 'loan_instalment' and ref_id = ${instalmentId})
            as messages,
          (select count(*)::int from events.outbox
            where org_id = ${orgId} and name = 'loan.instalment_due'
              and payload ->> 'instalmentId' = ${instalmentId}) as events,
          (select sms_state from loans.reminders
            where org_id = ${orgId} and instalment_id = ${instalmentId}) as sms_state
      `),
    { orgId },
  );
  return row;
}

let created: Created;
let firstDue: IsoDate;

beforeAll(async () => {
  harness = await startHttpHarness('loans-reminders');
  // `notify.queue` enqueues `notify.send` in the reminder's transaction, so a runtime must
  // exist. No handler is attached, so nothing is ever sent behind the test's back.
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [...NOTIFY_QUEUES, ...LOANS_QUEUE_DEFINITIONS],
    logger: pino({ level: 'silent' }),
  });
  reminders = harness.app.get(LoanRemindersService);
  accounts = await harness.asRole('accounts', ORG_A);
  otherBrand = await harness.asRole('accounts', ORG_B);

  // The brand's reminder template. ORG_B deliberately has none.
  await withSystem(
    (tx) =>
      tx.execute(sql`
        insert into notify.templates (org_id, key, channel, category, body_bn, body_en, updated_by)
        values (${ORG_A}, ${LOAN_REMINDER_TEMPLATE}, 'sms', 'transactional',
                ${'{lender}-এর কিস্তি {seq}, {due}, ৳{amount}'},
                ${'{lender} instalment {seq} due {due}: Tk {amount}'}, 'usr_m26_test')
      `),
    { orgId: ORG_A },
  );

  firstDue = addDays(businessDate(new Date()), 20);
  created = await loan(accounts, await lender(accounts, 'Karim Uddin'), BANK_A, {
    firstDueOn: firstDue,
    reminderPhone: PHONE,
  });
}, 420_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 120_000);

describe('check 3: each reminder fires once per instalment', () => {
  it('sends nothing before the window opens', async () => {
    const run = await reminders.run(ORG_A, addDays(firstDue, -4));
    expect(run).toMatchObject({ due: 0, reminded: 0 });
    for (const row of created.instalments) {
      expect(await trail(ORG_A, row.id)).toMatchObject({ reminders: 0, messages: 0, events: 0 });
    }
  });

  it('reminds instalment 1 three days ahead, in-app and by SMS, once', async () => {
    const day = addDays(firstDue, -3);
    expect(await reminders.run(ORG_A, day)).toMatchObject({ due: 1, reminded: 1 });
    expect(await trail(ORG_A, created.instalments[0]?.id ?? '')).toEqual({
      reminders: 1,
      messages: 1,
      events: 1,
      sms_state: 'queued',
    });

    // The same day again, and the next day: nothing new.
    expect(await reminders.run(ORG_A, day)).toMatchObject({ due: 0, reminded: 0 });
    expect(await reminders.run(ORG_A, addDays(day, 1))).toMatchObject({ reminded: 0 });
    expect(await trail(ORG_A, created.instalments[0]?.id ?? '')).toMatchObject({
      reminders: 1,
      messages: 1,
      events: 1,
    });
  });

  it('reminds once when two runs race for the same instalment', async () => {
    const second = created.instalments[1];
    const day = addDays(toIsoDate(second?.dueOn ?? ''), -3);
    const [one, two] = await Promise.all([reminders.run(ORG_A, day), reminders.run(ORG_A, day)]);
    expect((one?.reminded ?? 0) + (two?.reminded ?? 0)).toBe(1);
    expect(await trail(ORG_A, second?.id ?? '')).toMatchObject({
      reminders: 1,
      messages: 1,
      events: 1,
    });
  });

  it('refuses a second reminder row for an instalment, whatever the timing', async () => {
    // The race above may or may not overlap on a given machine; this pins the index it
    // relies on deterministically.
    const first = created.instalments[0];
    const attempt = withSystem(
      (tx) =>
        tx.execute(sql`
          insert into loans.reminders (org_id, loan_id, instalment_id, reminded_on, sms_state)
          values (${ORG_A}, ${created.loan.id}, ${first?.id ?? ''}, current_date, 'no_phone')
        `),
      { orgId: ORG_A },
    );
    const thrown: unknown = await attempt.then(
      () => null,
      (error: unknown) => error,
    );
    let message = '';
    for (let current = thrown; current instanceof Error; current = current.cause) {
      message += `
${current.message}`;
    }
    expect(message).toMatch(/loan_reminders_org_instalment_idx/);
  });

  it('catches up once after missed days, even past the due date', async () => {
    const third = created.instalments[2];
    // The job did not run until a week after instalment 3 fell due.
    const late = addDays(toIsoDate(third?.dueOn ?? ''), 7);
    expect(await reminders.run(ORG_A, late)).toMatchObject({ due: 1, reminded: 1 });
    expect(await reminders.run(ORG_A, late)).toMatchObject({ due: 0 });
    for (const row of created.instalments) {
      expect(await trail(ORG_A, row.id)).toMatchObject({ reminders: 1, messages: 1, events: 1 });
    }
  });

  it('does not remind an instalment whose payment is already in hand', async () => {
    const second = await loan(accounts, await lender(accounts, 'Rahim Traders'), BANK_A, {
      firstDueOn: addDays(businessDate(new Date()), 10),
    });
    const first = second.instalments[0];
    // No threshold in this brand, so the repayment waits for a checker: in hand, not paid.
    const paid = await accounts.client.request('POST', `/v1/loans/${second.loan.id}/payments`, {
      body: { paymentId: randomUUID(), instalmentId: first?.id ?? '', walletAccountId: BANK_A },
    });
    expect(paid.statusCode, paid.body).toBe(201);
    await reminders.run(ORG_A, toIsoDate(first?.dueOn ?? ''));
    expect(await trail(ORG_A, first?.id ?? '')).toMatchObject({ reminders: 0, events: 0 });
  });

  it('still reminds in-app when there is no SMS number, or no template', async () => {
    const quiet = await loan(accounts, await lender(accounts, 'No Phone Ltd'), BANK_A, {
      firstDueOn: addMonthsClamped(firstDue, 6),
    });
    const quietFirst = quiet.instalments[0];
    await reminders.run(ORG_A, toIsoDate(quietFirst?.dueOn ?? ''));
    expect(await trail(ORG_A, quietFirst?.id ?? '')).toEqual({
      reminders: 1,
      messages: 0,
      events: 1,
      sms_state: 'no_phone',
    });

    // The other brand has no `loan.instalment_due` template: the SMS fails, the rest goes.
    const other = await loan(otherBrand, await lender(otherBrand, 'Oura Lender'), BANK_B, {
      firstDueOn: firstDue,
      reminderPhone: PHONE,
    });
    const otherFirst = other.instalments[0];
    await reminders.run(ORG_B, firstDue);
    expect(await trail(ORG_B, otherFirst?.id ?? '')).toEqual({
      reminders: 1,
      messages: 0,
      events: 1,
      sms_state: 'failed',
    });
    // And one brand's run never reminds another brand's loans.
    expect(await trail(ORG_A, otherFirst?.id ?? '')).toMatchObject({ reminders: 0 });
  });

  it('fans out one run per brand per day, deduplicated', async () => {
    const now = new Date();
    const first = await reminders.fanOut(now);
    const second = await reminders.fanOut(now);
    expect(first).toBeGreaterThanOrEqual(5);
    expect(second).toBe(first);
    const [row] = await withSystem((tx) =>
      tx.execute<{ jobs: number }>(sql`
        select count(*)::int as jobs from pgboss.job
        where name = 'loans.remind_instalments'
          and singleton_key like ${`reminders:%:${businessDate(now)}`}
      `),
    );
    expect(row?.jobs).toBe(first);
  });
});
