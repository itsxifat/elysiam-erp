import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withOrg, withSystem, type Tx } from '../client.js';
import { seedAccountId } from '../seed/ledger.js';
import { SEED_ORG_IDS } from '../seed/orgs.js';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from './harness.js';

/**
 * The ledger's database-level guarantees (architecture §7; M03 checks 2, 3
 * and 4 at the layer that actually enforces them).
 *
 * Everything here goes around `ledger.post` on purpose and talks raw SQL as
 * `erp_app` — the application role — because the claim is that the database
 * refuses a corrupt ledger *whoever* writes it: a service with a bug, a job
 * that skips the service, a repair script at 2 a.m.
 */

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
const ORG_B = SEED_ORG_IDS['oura-lifestyle'] ?? '';

const BANK_A = seedAccountId(ORG_A, '1100');
const INCOME_A = seedAccountId(ORG_A, '4300');
const SUPPLIER_PAYABLE_A = seedAccountId(ORG_A, '2100');
const HQ_CASH_A = seedAccountId(ORG_A, '1010-HQ');
const BANK_B = seedAccountId(ORG_B, '1100');

let database: TestDatabase;

beforeAll(async () => {
  database = await startTestDatabase('ledger');
}, 180_000);

afterAll(async () => {
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

/** PostgreSQL's own message and SQLSTATE, dug out from under Drizzle's wrapper. */
async function refusal(work: Promise<unknown>): Promise<{ message: string; code: string }> {
  try {
    await work;
  } catch (error) {
    const messages: string[] = [];
    let code = '';
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      messages.push(current.message);
      const candidate = (current as { code?: unknown }).code;
      if (typeof candidate === 'string' && code === '') code = candidate;
    }
    return { message: messages.join(' | '), code };
  }
  throw new Error('expected PostgreSQL to refuse this');
}

const asApp = <T>(fn: (tx: Tx) => Promise<T>, orgId = ORG_A): Promise<T> =>
  withOrg({ orgId, userId: 'usr_ledger_test' }, fn);

/** A journal row, raw. Returns its id. */
async function insertJournal(
  tx: Tx,
  options: { orgId?: string; businessDate?: string } = {},
): Promise<string> {
  const sourceId = randomUUID();
  const rows = await tx.execute<{ id: string }>(sql`
    insert into ledger.journals
      (org_id, business_date, source_type, source_id, idempotency_key, content_hash, created_by, created_txid)
    values (
      ${options.orgId ?? ORG_A}, ${options.businessDate ?? '2026-07-15'}, 'test', ${sourceId},
      ${`test:${sourceId}:posted`}, 'hash', 'usr_ledger_test',
      -- Any value supplied here is overwritten by the trigger.
      '1'::xid8
    )
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('journal insert returned nothing');
  return id;
}

async function insertLine(
  tx: Tx,
  journalId: string,
  lineNo: number,
  accountId: string,
  debit: bigint,
  credit: bigint,
  extra: {
    orgId?: string;
    branchId?: string | null;
    partyType?: string | null;
    partyId?: string | null;
  } = {},
): Promise<void> {
  await tx.execute(sql`
    insert into ledger.journal_lines
      (org_id, journal_id, line_no, account_id, branch_id, party_type, party_id, debit_poisha, credit_poisha)
    values (
      ${extra.orgId ?? ORG_A}, ${journalId}, ${lineNo}, ${accountId},
      ${extra.branchId ?? null}::uuid, ${extra.partyType ?? null}::ledger.party_type,
      ${extra.partyId ?? null}::uuid, ${debit.toString()}, ${credit.toString()}
    )
  `);
}

async function postBalanced(amount = 1_000n, businessDate = '2026-07-15'): Promise<string> {
  return asApp(async (tx) => {
    const id = await insertJournal(tx, { businessDate });
    await insertLine(tx, id, 1, BANK_A, amount, 0n);
    await insertLine(tx, id, 2, INCOME_A, 0n, amount);
    return id;
  });
}

async function journalCount(): Promise<number> {
  const rows = await withSystem(
    async (tx) => tx.execute<{ n: string }>(sql`select count(*)::text as n from ledger.journals`),
    { orgId: ORG_A },
  );
  return Number(rows[0]?.n ?? 0);
}

describe('check 2: an unbalanced journal inserted with raw SQL fails at commit', () => {
  it('accepts every statement, then refuses the commit', async () => {
    const before = await journalCount();
    let insideTransaction = -1;

    const result = await refusal(
      asApp(async (tx) => {
        const id = await insertJournal(tx);
        await insertLine(tx, id, 1, BANK_A, 10_000n, 0n);
        await insertLine(tx, id, 2, INCOME_A, 0n, 9_999n);
        // Every statement succeeded: the check is deferred to commit.
        const rows = await tx.execute<{ n: string }>(
          sql`select count(*)::text as n from ledger.journal_lines where journal_id = ${id}`,
        );
        insideTransaction = Number(rows[0]?.n);
      }),
    );

    expect(insideTransaction, 'both lines were written inside the transaction').toBe(2);
    expect(result.message).toMatch(/JOURNAL_UNBALANCED: .* debits of 10000 and credits of 9999/);
    expect(result.code).toBe('23514');
    expect(await journalCount(), 'nothing survived the failed commit').toBe(before);
  });

  it('refuses a journal with no lines, and one with a single line', async () => {
    expect((await refusal(asApp(async (tx) => insertJournal(tx)))).message).toMatch(
      /JOURNAL_TOO_FEW_LINES: .* has 0 line/,
    );
    expect(
      (
        await refusal(
          asApp(async (tx) => {
            const id = await insertJournal(tx);
            await insertLine(tx, id, 1, BANK_A, 500n, 0n);
          }),
        )
      ).message,
    ).toMatch(/JOURNAL_TOO_FEW_LINES: .* has 1 line/);
  });

  it('refuses a line with both sides, or neither, at the statement', async () => {
    for (const [debit, credit] of [
      [5n, 5n],
      [0n, 0n],
    ] as const) {
      const result = await refusal(
        asApp(async (tx) => {
          const id = await insertJournal(tx);
          await insertLine(tx, id, 1, BANK_A, debit, credit);
        }),
      );
      expect(result.message).toMatch(/journal_lines_one_side/);
    }
  });

  it('still refuses when the caller asks for the check immediately', async () => {
    // SET CONSTRAINTS … IMMEDIATE only moves the check earlier.
    const result = await refusal(
      asApp(async (tx) => {
        await tx.execute(sql`set constraints all immediate`);
        await insertJournal(tx);
      }),
    );
    expect(result.message).toMatch(/JOURNAL_TOO_FEW_LINES/);
  });

  it('commits a balanced journal written the same way (the control)', async () => {
    const before = await journalCount();
    await postBalanced();
    expect(await journalCount()).toBe(before + 1);
  });
});

describe('check 3: UPDATE and DELETE on journals and lines fail for erp_app', () => {
  it('refuses UPDATE and DELETE on both tables, by grant', async () => {
    const id = await postBalanced();
    const statements = [
      sql`update ledger.journals set memo = 'edited' where id = ${id}`,
      sql`delete from ledger.journals where id = ${id}`,
      sql`update ledger.journal_lines set debit_poisha = 1 where journal_id = ${id}`,
      sql`delete from ledger.journal_lines where journal_id = ${id}`,
      sql`truncate ledger.journal_lines`,
    ];
    for (const statement of statements) {
      const result = await refusal(asApp(async (tx) => tx.execute(statement)));
      expect(result.code, result.message).toBe('42501');
      expect(result.message).toMatch(/permission denied/);
    }
  });

  it('refuses them for the owner role too, by trigger', async () => {
    const id = await postBalanced();
    for (const statement of [
      sql`update ledger.journals set memo = 'edited' where id = ${id}`,
      sql`delete from ledger.journal_lines where journal_id = ${id}`,
    ]) {
      const result = await refusal(
        withSystem(async (tx) => tx.execute(statement), { orgId: ORG_A }),
      );
      expect(result.message).toMatch(/LEDGER_IMMUTABLE/);
    }
  });

  it('refuses a balanced pair of lines added to a journal posted earlier', async () => {
    // The balance check alone would pass this: +1000 / -1000 keeps it balanced.
    const id = await postBalanced();
    const result = await refusal(
      asApp(async (tx) => {
        await insertLine(tx, id, 3, BANK_A, 1_000n, 0n);
        await insertLine(tx, id, 4, INCOME_A, 0n, 1_000n);
      }),
    );
    expect(result.message).toMatch(/LEDGER_IMMUTABLE: journal .* is already posted/);
  });
});

describe('lines must agree with their account', () => {
  it('refuses a missing party on a party account, and a party on an account that takes none', async () => {
    const missing = await refusal(
      asApp(async (tx) => {
        const id = await insertJournal(tx);
        await insertLine(tx, id, 1, BANK_A, 700n, 0n);
        await insertLine(tx, id, 2, SUPPLIER_PAYABLE_A, 0n, 700n);
      }),
    );
    expect(missing.message).toMatch(/takes party supplier, the line names none/);

    const extra = await refusal(
      asApp(async (tx) => {
        const id = await insertJournal(tx);
        await insertLine(tx, id, 1, BANK_A, 700n, 0n, {
          partyType: 'supplier',
          partyId: randomUUID(),
        });
        await insertLine(tx, id, 2, INCOME_A, 0n, 700n);
      }),
    );
    expect(extra.message).toMatch(/takes party none, the line names supplier/);
  });

  it("refuses a branch wallet's line tagged with another branch, or none", async () => {
    const result = await refusal(
      asApp(async (tx) => {
        const id = await insertJournal(tx);
        await insertLine(tx, id, 1, HQ_CASH_A, 700n, 0n);
        await insertLine(tx, id, 2, INCOME_A, 0n, 700n);
      }),
    );
    expect(result.message).toMatch(/belongs to branch .* the line names none/);
  });

  it('refuses an inactive account', async () => {
    const accountId = randomUUID();
    await withSystem(
      async (tx) =>
        tx.execute(sql`insert into ledger.accounts (id, org_id, code, name, class, subtype, normal_balance, is_active)
          values (${accountId}, ${ORG_A}, 'X-INACTIVE', 'Old', 'income', 'other_income', 'credit', false)`),
      { orgId: ORG_A },
    );
    const result = await refusal(
      asApp(async (tx) => {
        const id = await insertJournal(tx);
        await insertLine(tx, id, 1, BANK_A, 700n, 0n);
        await insertLine(tx, id, 2, accountId, 0n, 700n);
      }),
    );
    expect(result.message).toMatch(/LEDGER_ACCOUNT_INVALID: .* is inactive/);
  });

  it("refuses another org's account, whatever the org context says (D-047)", async () => {
    const result = await refusal(
      asApp(async (tx) => {
        const id = await insertJournal(tx);
        await insertLine(tx, id, 1, BANK_B, 700n, 0n);
        await insertLine(tx, id, 2, INCOME_A, 0n, 700n);
      }),
    );
    expect(result.message).toMatch(/does not exist|violates foreign key/);
  });

  it('refuses changing what an account is, but allows renaming it', async () => {
    const changed = await refusal(
      asApp(async (tx) =>
        tx.execute(sql`update ledger.accounts set subtype = 'cogs' where id = ${BANK_A}`),
      ),
    );
    expect(changed.message).toMatch(/can be renamed or deactivated, nothing else/);

    await asApp(async (tx) =>
      tx.execute(sql`update ledger.accounts set name = 'Bank (City)' where id = ${BANK_A}`),
    );
    const deleted = await refusal(
      asApp(async (tx) => tx.execute(sql`delete from ledger.accounts where id = ${BANK_A}`)),
    );
    expect(deleted.code).toBe('42501');
  });
});

describe('idempotency at the database', () => {
  it('refuses a second journal with the same key in the same org', async () => {
    const sourceId = randomUUID();
    const insert = (tx: Tx) =>
      tx.execute(sql`
        insert into ledger.journals
          (org_id, business_date, source_type, source_id, idempotency_key, content_hash, created_by, created_txid)
        values (${ORG_A}, '2026-07-15', 'test', ${sourceId}, ${`test:${sourceId}:posted`}, 'h', 'u', '1'::xid8)
      `);
    await asApp(async (tx) => {
      await insert(tx);
      const [row] = await tx.execute<{ id: string }>(
        sql`select id from ledger.journals where source_id = ${sourceId}`,
      );
      await insertLine(tx, row?.id ?? '', 1, BANK_A, 5n, 0n);
      await insertLine(tx, row?.id ?? '', 2, INCOME_A, 0n, 5n);
    });
    const result = await refusal(asApp(async (tx) => insert(tx)));
    expect(result.code).toBe('23505');
    expect(result.message).toMatch(/journals_org_idempotency_key_idx/);
  });

  it('refuses a key that does not match its source', async () => {
    const result = await refusal(
      asApp(async (tx) =>
        tx.execute(sql`
          insert into ledger.journals
            (org_id, business_date, source_type, source_id, idempotency_key, content_hash, created_by, created_txid)
          values (${ORG_A}, '2026-07-15', 'test', ${randomUUID()}, 'test:something-else:posted', 'h', 'u', '1'::xid8)
        `),
      ),
    );
    expect(result.message).toMatch(/journals_idempotency_key_matches_source/);
  });
});

/** A platform super admin, and an ordinary user, for the reopen rule (0015). */
const SUPER = 'usr_ledger_super_admin';
const PLAIN = 'usr_ledger_plain_admin';

beforeAll(async () => {
  // As the owner: since 0015 `erp_app` cannot make anyone a super admin.
  await withSystem(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified, is_super_admin)
      values (${SUPER}, 'ledger-super@example.invalid', 'Super', true, true),
             (${PLAIN}, 'ledger-plain@example.invalid', 'Plain', true, false)
      on conflict (id) do nothing
    `);
  });
});

const asUser = <T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
  withOrg({ orgId: ORG_A, userId }, fn);

/** Close a month directly, as the periods service does. */
async function closeMonth(startsOn: string, endsOn: string): Promise<string> {
  return asUser('usr_closer', async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      insert into ledger.periods (org_id, starts_on, ends_on, status, closed_at, closed_by)
      values (${ORG_A}, ${startsOn}, ${endsOn}, 'closed', now(), 'usr_closer')
      on conflict (org_id, starts_on) do update
        set status = 'closed', closed_at = now(), closed_by = 'usr_closer', updated_at = now()
      returning id
    `);
    return rows[0]?.id ?? '';
  });
}

/** A pending period_reopen, raised by a maker. */
async function raiseReopen(periodId: string): Promise<string> {
  const id = randomUUID();
  await asUser('usr_maker', async (tx) =>
    tx.execute(sql`
      insert into approvals.approval_requests (id, org_id, type, status, requested_by, payload)
      values (${id}, ${ORG_A}, 'period_reopen', 'pending', 'usr_maker', ${JSON.stringify({ periodId })}::jsonb)
    `),
  );
  return id;
}

/** Decide a request, acting as the decider. */
async function decide(id: string, decider: string): Promise<void> {
  await asUser(decider, async (tx) =>
    tx.execute(sql`
      update approvals.approval_requests
      set status = 'approved', decided_by = ${decider}, decided_at = now()
      where id = ${id}
    `),
  );
}

async function approvedReopen(periodId: string, decider = SUPER): Promise<string> {
  const id = await raiseReopen(periodId);
  await decide(id, decider);
  return id;
}

/** Reopen, acting as `actor` — the super admin, in the decision's transaction. */
async function reopen(periodId: string, approvalId: string, actor = SUPER): Promise<unknown> {
  return asUser(actor, async (tx) =>
    tx.execute(sql`
      update ledger.periods
      set status = 'open', reopened_at = now(), reopen_approval_id = ${approvalId}, updated_at = now()
      where id = ${periodId}
    `),
  );
}

async function periodRow(id: string) {
  const [row] = await withSystem(
    async (tx) =>
      tx.execute<{ status: string; closed_at: string; reopened_at: string | null }>(sql`
        select status::text, closed_at::text, reopened_at::text from ledger.periods where id = ${id}
      `),
    { orgId: ORG_A },
  );
  return row;
}

describe('check 4 (database): the period lock and the reopen rule', () => {
  // Months ascend through this block: a closed month locks every date before
  // it (D-093), so each test works in a month later than the last one's.

  it('refuses a journal dated in or before a closed month, and accepts one after', async () => {
    await closeMonth('2025-01-01', '2025-01-31');

    const inMonth = await refusal(postBalanced(1_000n, '2025-01-31'));
    expect(inMonth.message).toMatch(/PERIOD_CLOSED: 2025-01-31 falls on or before 2025-01/);

    // Balances are cumulative: a date before the closed month would change its
    // closing figures just as surely (audit W3).
    const before = await refusal(postBalanced(1_000n, '2024-12-31'));
    expect(before.message).toMatch(/PERIOD_CLOSED: 2024-12-31 falls on or before 2025-01/);

    await expect(postBalanced(1_000n, '2025-02-01')).resolves.toBeTypeOf('string');
  });

  it('refuses reopening by a plain UPDATE, a pending approval, or the wrong approval', async () => {
    const periodId = await closeMonth('2025-02-01', '2025-02-28');

    const bare = await refusal(
      asUser(SUPER, async (tx) =>
        tx.execute(
          sql`update ledger.periods set status = 'open', reopened_at = now() where id = ${periodId}`,
        ),
      ),
    );
    expect(bare.message).toMatch(/PERIOD_REOPEN_UNAUTHORISED/);

    const pending = await raiseReopen(periodId);
    expect((await refusal(reopen(periodId, pending))).message).toMatch(
      /PERIOD_REOPEN_UNAUTHORISED/,
    );

    const otherPeriod = await closeMonth('2025-03-01', '2025-03-31');
    const forOther = await approvedReopen(otherPeriod);
    expect((await refusal(reopen(periodId, forOther))).message).toMatch(
      /PERIOD_REOPEN_UNAUTHORISED: approval .* does not authorise reopening 2025-02/,
    );

    // Deleting the row would reopen it with no approval at all.
    const deleted = await refusal(
      asApp(async (tx) => tx.execute(sql`delete from ledger.periods where id = ${periodId}`)),
    );
    expect(deleted.code).toBe('42501');

    // And a period cannot be created open, or moved.
    const createdOpen = await refusal(
      asApp(async (tx) =>
        tx.execute(sql`insert into ledger.periods (org_id, starts_on, ends_on, status)
          values (${ORG_A}, '2024-01-01', '2024-01-31', 'open')`),
      ),
    );
    expect(createdOpen.message).toMatch(/PERIOD_INVALID/);
    const moved = await refusal(
      asApp(async (tx) =>
        tx.execute(sql`update ledger.periods set starts_on = '2024-02-01', ends_on = '2024-02-29'
          where id = ${periodId}`),
      ),
    );
    expect(moved.message).toMatch(/PERIOD_INVALID|periods_whole_month/);
  });

  it('refuses a forged approval: born approved, decided by someone else, or not by a super admin (audit W1)', async () => {
    const periodId = await closeMonth('2025-04-01', '2025-04-30');

    // The two-statement forgery the audit reproduced: a row born approved.
    const born = await refusal(
      asUser(SUPER, async (tx) =>
        tx.execute(sql`
          insert into approvals.approval_requests
            (org_id, type, status, requested_by, decided_by, decided_at, payload)
          values (${ORG_A}, 'period_reopen', 'approved', 'usr_maker', ${SUPER}, now(),
                  ${JSON.stringify({ periodId })}::jsonb)
        `),
      ),
    );
    expect(born.message).toMatch(/APPROVAL_INVALID: a request is raised pending/);

    // Decided "by" someone other than the user the transaction is acting as.
    const pending = await raiseReopen(periodId);
    const impersonated = await refusal(
      asUser(PLAIN, async (tx) =>
        tx.execute(sql`update approvals.approval_requests
          set status = 'approved', decided_by = ${SUPER}, decided_at = now() where id = ${pending}`),
      ),
    );
    expect(impersonated.message).toMatch(/decided_by must be the acting user/);

    // Genuinely decided, but by someone who is not a super admin.
    const byPlain = await approvedReopen(periodId, PLAIN);
    expect((await refusal(reopen(periodId, byPlain, PLAIN))).message).toMatch(
      /PERIOD_REOPEN_UNAUTHORISED/,
    );

    // A super admin's approval, applied by someone else's transaction.
    const bySuper = await approvedReopen(periodId);
    expect((await refusal(reopen(periodId, bySuper, PLAIN))).message).toMatch(
      /PERIOD_REOPEN_UNAUTHORISED/,
    );

    // And the app role cannot make anyone a super admin (D-094).
    const promoted = await refusal(
      asApp(async (tx) =>
        tx.execute(sql`update iam.users set is_super_admin = true where id = ${PLAIN}`),
      ),
    );
    expect(promoted.message).toMatch(/only the owner role grants super admin/);

    // The legitimate path still works.
    await reopen(periodId, bySuper);
    expect((await periodRow(periodId))?.status).toBe('open');
  });

  it('reopens with an approved period_reopen, and that approval cannot reopen it again', async () => {
    const periodId = await closeMonth('2025-05-01', '2025-05-31');
    const approval = await approvedReopen(periodId);
    await reopen(periodId, approval);

    await expect(postBalanced(500n, '2025-05-10')).resolves.toBeTypeOf('string');

    // Closed again by a raw UPDATE that tries to keep the old closed_at: the
    // database stamps its own time, so the old approval is spent (audit W2).
    await asUser('usr_closer', async (tx) =>
      tx.execute(sql`update ledger.periods set status = 'closed', closed_at = '2000-01-01T00:00:00Z'
        where id = ${periodId}`),
    );
    const row = await periodRow(periodId);
    expect(row?.status).toBe('closed');
    expect(new Date(row?.closed_at ?? 0).getTime()).toBeGreaterThanOrEqual(
      new Date(row?.reopened_at ?? 0).getTime(),
    );

    expect((await refusal(reopen(periodId, approval))).message).toMatch(
      /PERIOD_REOPEN_UNAUTHORISED/,
    );
    expect((await refusal(postBalanced(500n, '2025-05-11'))).message).toMatch(/PERIOD_CLOSED/);
  });

  it('refuses an approval raised during an earlier closure (audit W2)', async () => {
    const periodId = await closeMonth('2025-06-01', '2025-06-30');
    // Two requests during the first closure; one is used.
    const first = await approvedReopen(periodId);
    const second = await approvedReopen(periodId);
    await reopen(periodId, second);
    await closeMonth('2025-06-01', '2025-06-30');

    expect((await refusal(reopen(periodId, first))).message).toMatch(
      /PERIOD_REOPEN_UNAUTHORISED: approval .* does not authorise/,
    );
  });

  it('makes a close wait for an in-flight post, and a post wait for an in-flight close', async () => {
    // A post holds the org's period lock shared until it commits.
    let releasePost: () => void = () => undefined;
    const postHeld = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let postInserted: () => void = () => undefined;
    const postStarted = new Promise<void>((resolve) => {
      postInserted = resolve;
    });

    const post = asApp(async (tx) => {
      const id = await insertJournal(tx, { businessDate: '2025-11-20' });
      await insertLine(tx, id, 1, BANK_A, 300n, 0n);
      await insertLine(tx, id, 2, INCOME_A, 0n, 300n);
      postInserted();
      await postHeld;
      return id;
    });
    await postStarted;

    let closeDone = false;
    const close = closeMonth('2025-11-01', '2025-11-30').then((id) => {
      closeDone = true;
      return id;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(closeDone, 'the close must wait for the in-flight post').toBe(false);

    releasePost();
    await expect(post).resolves.toBeTypeOf('string');
    await close;
    expect(closeDone).toBe(true);

    // Now the other way round: a close in flight holds every new post.
    let releaseClose: () => void = () => undefined;
    const closeHeld = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    let closeWritten: () => void = () => undefined;
    const closeStarted = new Promise<void>((resolve) => {
      closeWritten = resolve;
    });
    const secondClose = asApp(async (tx) => {
      await tx.execute(sql`
        insert into ledger.periods (org_id, starts_on, ends_on, status, closed_at, closed_by)
        values (${ORG_A}, '2025-12-01', '2025-12-31', 'closed', now(), 'usr_closer')
      `);
      closeWritten();
      await closeHeld;
    });
    await closeStarted;

    let postSettled = false;
    const blockedPost = postBalanced(300n, '2025-12-15').finally(() => {
      postSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(postSettled, 'the post must wait for the in-flight close').toBe(false);

    releaseClose();
    await secondClose;
    expect((await refusal(blockedPost)).message).toMatch(/PERIOD_CLOSED/);
  });

  it('refuses posting under REPEATABLE READ, where the lock would protect nothing', async () => {
    // Straight through the driver: withOrg has already run a query by the time
    // a callback could ask for the isolation level, and it must come first.
    const client = postgres(database.appUrl, { max: 1, onnotice: () => undefined });
    try {
      const sourceId = randomUUID();
      const result = await refusal(
        client.begin('isolation level repeatable read', async (tx) => {
          await tx`select set_config('app.org_id', ${ORG_A}, true)`;
          await tx`
            insert into ledger.journals
              (org_id, business_date, source_type, source_id, idempotency_key, content_hash,
               created_by, created_txid)
            values (${ORG_A}, '2026-07-15', 'test', ${sourceId}, ${`test:${sourceId}:posted`},
                    'h', 'u', '1'::xid8)
          `;
        }),
      );
      expect(result.message).toMatch(/LEDGER_ISOLATION: .* not repeatable read/);
    } finally {
      await client.end();
    }
  });
});

describe('accounts and reversals (0015)', () => {
  it("never changes an account's id, and refuses an account whose shape contradicts its subtype", async () => {
    const moved = await refusal(
      asApp(async (tx) =>
        tx.execute(sql`update ledger.accounts set id = gen_random_uuid() where id = ${BANK_A}`),
      ),
    );
    expect(moved.message).toMatch(/can be renamed or deactivated, nothing else/);

    for (const [subtype, cls, normal, party] of [
      ['supplier_payable', 'liability', 'credit', null],
      ['inventory', 'income', 'debit', null],
      ['wallet_bank', 'asset', 'credit', null],
    ] as const) {
      const result = await refusal(
        asApp(async (tx) =>
          tx.execute(sql`insert into ledger.accounts (org_id, code, name, class, subtype, normal_balance, party_type)
            values (${ORG_A}, ${`X-${subtype.toUpperCase().replace(/_/g, '-')}`}, 'bad', ${cls}::ledger.account_class,
                    ${subtype}::ledger.account_subtype, ${normal}::ledger.normal_balance,
                    ${party}::ledger.party_type)`),
        ),
      );
      expect(result.message, subtype).toMatch(/LEDGER_ACCOUNT_INVALID: a .* account is/);
    }
  });

  it('refuses a reversal that does not mirror the journal it reverses (audit N3)', async () => {
    const original = await postBalanced(1_000n);
    const reversal = (
      debit: bigint,
      key = `journal:${original}:reversed`,
      sourceType = 'journal',
    ) =>
      asApp(async (tx) => {
        const rows = await tx.execute<{ id: string }>(sql`
          insert into ledger.journals
            (org_id, business_date, source_type, source_id, idempotency_key, reverses_journal_id,
             content_hash, created_by, created_txid)
          values (${ORG_A}, '2026-07-16', ${sourceType}, ${original}, ${key}, ${original}, 'h', 'u', '1'::xid8)
          returning id
        `);
        const id = rows[0]?.id ?? '';
        await insertLine(tx, id, 1, BANK_A, 0n, debit);
        await insertLine(tx, id, 2, INCOME_A, debit, 0n);
      });

    // Balanced, but not the mirror image.
    expect((await refusal(reversal(999n))).message).toMatch(/does not mirror journal/);
    // Not keyed on what it reverses.
    expect((await refusal(reversal(1_000n, `test:${original}:reversed`, 'test'))).message).toMatch(
      /journals_reversal_shape/,
    );
    // The true mirror commits.
    await expect(reversal(1_000n)).resolves.toBeUndefined();
  });
});

describe('tenancy', () => {
  it("does not show one org's journals to another", async () => {
    await postBalanced();
    const seen = await asApp(
      async (tx) => tx.execute<{ n: string }>(sql`select count(*)::text as n from ledger.journals`),
      ORG_B,
    );
    expect(Number(seen[0]?.n)).toBe(0);
  });
});
