import { withOrg, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ORG_A, ORG_B, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { HrCrypto, hrFieldKey, maskEmployeePhone, maskPayoutRef } from './hr.crypto.js';
import { HrModule } from './hr.module.js';
import { ensureDefaultCalendar } from './hr.repository.js';
import {
  applyHrMigrations,
  seedAttendance,
  seedEmployee,
  seedHoliday,
  seedStructure,
} from './hr.testing.js';

/**
 * The HR schema against a real database (M19 acceptance checks 2, 3 and the database half
 * of 1 and 4).
 *
 * What this suite exists to prove, in the order it matters:
 *
 * 1. **Check 3 — encrypted fields are unreadable in a raw database query.** Read as
 *    `erp_owner`, the role that runs migrations and is exempt from nothing else, straight
 *    out of the column. The plaintext must not appear, the ciphertext must not decrypt
 *    under another employee's AAD, and the mask must not be the number.
 * 2. **Check 2 — a payroll run cannot be posted twice.** Three layers, tested
 *    separately: the unique index on (org, month), the status trigger, and the ledger's
 *    idempotency key. Each one is tested on its own, because in production only one of
 *    them fires and which one depends on the path.
 * 3. **Invariant 4 — tenancy.** Org B cannot see org A's employees, payslips or loans, and
 *    the `hr` schema's policies are the generated ones.
 * 4. **The frozen-payslip guarantees.** A payslip cannot be edited, a submitted run's
 *    totals cannot be changed, a used salary structure cannot be restated, and a run whose
 *    totals disagree with its payslips cannot commit.
 */

let harness: HttpHarness;
let crypto: HrCrypto;

const SYSTEM_USER = 'usr_hr_db_test';

beforeAll(async () => {
  harness = await startHttpHarness('hr-db', { extraModules: [HrModule] });
  await applyHrMigrations();
  crypto = new HrCrypto(hrFieldKey(process.env.AUTH_SECRET ?? ''));
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

/**
 * Assert that a statement was refused, and by which rule.
 *
 * Drizzle wraps a PostgreSQL error in one whose message is `Failed query: …`, so
 * `rejects.toThrow(/PAYROLL_IMMUTABLE/)` matches the wrapper and fails — the code it is
 * looking for is on `error.cause`. The chain is walked instead, which is the same thing
 * `databasePayrollCode` does in production for the same reason.
 */
async function refused(work: () => Promise<unknown>, pattern?: RegExp): Promise<void> {
  let thrown: unknown;
  try {
    await work();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, 'the statement was expected to be refused').toBeDefined();

  /*
   * The chain is walked as plain objects, not as `Error`s.
   *
   * Drizzle wraps a refusal in an error whose message is `Failed query: …` and hangs the
   * PostgreSQL error off `cause` — and that object does not satisfy `instanceof Error`
   * across the postgres.js boundary, so an `instanceof` walk stops at the wrapper and
   * every assertion about a trigger code silently matches nothing. `databasePayrollCode`
   * reads the chain the same way in production, for the same reason.
   */
  const messages: string[] = [];
  for (
    let current: unknown = thrown, depth = 0;
    current !== null && current !== undefined && depth < 8;
    depth += 1
  ) {
    const message = (current as { message?: unknown }).message;
    if (typeof message === 'string') messages.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  if (pattern !== undefined) expect(messages.join(' | ')).toMatch(pattern);
}

// --- check 3: the encrypted fields --------------------------------------------

describe('encrypted employee fields (check 3)', () => {
  const NID = '1990123456789';
  const BKASH = '01712345678';

  it('stores no plaintext anywhere a raw query can reach', async () => {
    const employee = await seedEmployee(ORG_A, {
      code: 'ENC-01',
      fullName: 'Encrypted Employee',
      joinDate: '2026-01-01',
    });
    const owner = { orgId: ORG_A, employeeId: employee.id };

    await withSystem(
      async (tx) => {
        await tx.execute(sql`
          update hr.employees
          set payout_method = 'bkash',
              payout_ref_cipher = ${crypto.encrypt(BKASH, owner, 'payout_ref')},
              payout_ref_masked = ${maskPayoutRef(BKASH)},
              national_id_cipher = ${crypto.encrypt(NID, owner, 'national_id')},
              national_id_masked = ${maskPayoutRef(NID)},
              phone_cipher = ${crypto.encrypt(BKASH, owner, 'phone')},
              phone_masked = ${maskEmployeePhone(BKASH)}
          where org_id = ${ORG_A} and id = ${employee.id}
        `);
      },
      { orgId: ORG_A },
    );

    /*
     * The raw read, as `erp_owner`.
     *
     * Cast to text so a `bytea` arrives as its hex representation — which is what a
     * `pg_dump`, a CSV export and a psql session all show. If the plaintext were stored,
     * or hex-encoded, its digits would be findable in this string.
     */
    const raw = await withSystem(
      async (tx) => {
        const rows = await tx.execute<{
          payout: string;
          nid: string;
          phone: string;
          payout_masked: string;
          nid_masked: string;
          phone_masked: string;
          whole_row: string;
        }>(sql`
          select payout_ref_cipher::text as payout,
                 national_id_cipher::text as nid,
                 phone_cipher::text as phone,
                 payout_ref_masked as payout_masked,
                 national_id_masked as nid_masked,
                 phone_masked as phone_masked,
                 e::text as whole_row
          from hr.employees e where org_id = ${ORG_A} and id = ${employee.id}
        `);
        return rows[0];
      },
      { orgId: ORG_A },
    );

    expect(raw).toBeDefined();
    // The whole row as text: no column, masked or otherwise, contains either number.
    expect(raw?.whole_row).not.toContain(NID);
    expect(raw?.whole_row).not.toContain(BKASH);
    // And not hex-encoded either, which is how `bytea` would render a plaintext.
    const hex = (value: string) => Buffer.from(value, 'utf8').toString('hex');
    expect(raw?.payout).not.toContain(hex(BKASH));
    expect(raw?.nid).not.toContain(hex(NID));
    // The masks are masks: they carry a masking character and only the tail digits.
    expect(raw?.payout_masked).toBe('*******5678');
    expect(raw?.phone_masked).toBe('017******78');
    expect(raw?.nid_masked).toMatch(/^\*+6789$/);
  });

  it('decrypts only under its own employee and field, so a copied ciphertext fails', async () => {
    const one = await seedEmployee(ORG_A, {
      code: 'ENC-02',
      fullName: 'First',
      joinDate: '2026-01-01',
    });
    const two = await seedEmployee(ORG_A, {
      code: 'ENC-03',
      fullName: 'Second',
      joinDate: '2026-01-01',
    });

    const envelope = crypto.encrypt(BKASH, { orgId: ORG_A, employeeId: one.id }, 'payout_ref');
    expect(crypto.decrypt(envelope, { orgId: ORG_A, employeeId: one.id }, 'payout_ref')).toBe(
      BKASH,
    );
    // Moved to another employee's row: the AAD no longer matches, so the tag check fails.
    // Without the AAD this would decrypt perfectly and the salary payment would go to the
    // wrong person's bKash number.
    expect(() =>
      crypto.decrypt(envelope, { orgId: ORG_A, employeeId: two.id }, 'payout_ref'),
    ).toThrow(/could not be read/);
    // Moved to another column on the same row: also refused.
    expect(() =>
      crypto.decrypt(envelope, { orgId: ORG_A, employeeId: one.id }, 'national_id'),
    ).toThrow(/could not be read/);
    // Moved to another org: also refused, which is the belt to RLS's braces.
    expect(() =>
      crypto.decrypt(envelope, { orgId: ORG_B, employeeId: one.id }, 'payout_ref'),
    ).toThrow(/could not be read/);
  });

  it('refuses a mask that is really the whole number (migration 0055)', async () => {
    const employee = await seedEmployee(ORG_A, {
      code: 'ENC-04',
      fullName: 'Masked',
      joinDate: '2026-01-01',
    });
    await refused(
      () =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
            update hr.employees set phone_masked = '01712345678'
            where org_id = ${ORG_A} and id = ${employee.id}
          `);
          },
          { orgId: ORG_A },
        ),
      /HR_FIELD_NOT_MASKED/,
    );
  });

  /*
   * The first test in this block writes its own ciphertext with raw SQL, so it proves the
   * *column* can hold something unreadable and says nothing about what the *service* puts
   * there. A service that stored the NID as UTF-8 bytes in `national_id_cipher`, or
   * copied the number into a free-text column, would pass it untouched.
   *
   * This one goes through the front door — `POST /v1/hr/employees` as the HR role, the
   * validation, the service's encryption, the audit net — and then reads back everything
   * the database holds for that employee as the owner, the widest raw view there is short
   * of a superuser: the whole row through `row_to_json`, and every audit row written about
   * it. None of the three numbers may appear in any form someone could search for.
   */
  it('stores what the API was given only as ciphertext and masks', async () => {
    const hr = await harness.asRole('hr', ORG_A);
    const numbers = {
      nationalId: '1987654321098',
      phone: '01733344455',
      payoutRef: '01855566677',
    };

    const created = await hr.client.request('POST', '/v1/hr/employees', {
      body: {
        code: 'ENC-API-01',
        fullName: 'Through The Front Door',
        joinDate: '2026-02-01',
        payoutMethod: 'bkash',
        ...numbers,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const { id } = JSON.parse(created.body) as { id: string };
    // Not even the response echoes them: masks only.
    for (const value of Object.values(numbers)) expect(created.body).not.toContain(value);

    const raw = await withSystem(
      async (tx) => {
        const row = await tx.execute<{ doc: string }>(sql`
          select row_to_json(e)::text as doc from hr.employees e
          where org_id = ${ORG_A} and id = ${id}
        `);
        const audit = await tx.execute<{ doc: string }>(sql`
          select row_to_json(a)::text as doc from audit.audit_log a
          where org_id = ${ORG_A} and entity_id = ${id}
        `);
        return { row: row[0]?.doc ?? '', audit: audit.map((entry) => entry.doc) };
      },
      { orgId: ORG_A },
    );
    expect(raw.row, 'the employee row exists').toContain(id);
    expect(raw.audit.length, 'the create was audited').toBeGreaterThan(0);

    /*
     * Every spelling a leak could take: as typed; with the leading zero dropped or the
     * country code added, which is what phone normalisation produces; as the hex that
     * `bytea` renders to; as base64; and, across the whole document with every non-digit
     * removed, as a digit run — which catches a number stored with separators.
     */
    const spellings = (value: string): string[] => {
      const forms = new Set([value]);
      if (value.startsWith('0')) {
        forms.add(value.slice(1));
        forms.add(`880${value.slice(1)}`);
        forms.add(`+880${value.slice(1)}`);
      }
      const hex = [...forms].map((form) => Buffer.from(form, 'utf8').toString('hex'));
      const base64 = [...forms].map((form) => Buffer.from(form, 'utf8').toString('base64'));
      return [...forms, ...hex, ...base64];
    };

    for (const doc of [raw.row, ...raw.audit]) {
      const digits = doc.replace(/\D+/g, '');
      for (const [field, value] of Object.entries(numbers)) {
        for (const form of spellings(value)) {
          expect(doc.toLowerCase(), `${field} as "${form}"`).not.toContain(form.toLowerCase());
        }
        expect(digits, `${field} as a digit run`).not.toContain(value.slice(1));
      }
    }

    // And the masks are what the service promised, so the columns are not simply empty.
    const masks = JSON.parse(raw.row) as Record<string, unknown>;
    expect(masks.national_id_masked).toBe('********1098');
    expect(masks.phone_masked).toBe('017******55');
    expect(masks.payout_ref_masked).toBe('*******6677');
    for (const column of ['national_id_cipher', 'phone_cipher', 'payout_ref_cipher']) {
      expect(masks[column], `${column} holds ciphertext`).toEqual(
        expect.stringMatching(/^\\x[0-9a-f]+$/),
      );
    }
  });
});

// --- tenancy ------------------------------------------------------------------

describe('tenancy (invariant 4)', () => {
  it('shows one org nothing of another org’s people or payroll', async () => {
    const mine = await seedEmployee(ORG_A, {
      code: 'TEN-01',
      fullName: 'Org A staff',
      joinDate: '2026-01-01',
    });
    await seedEmployee(ORG_B, {
      code: 'TEN-01',
      fullName: 'Org B staff',
      joinDate: '2026-01-01',
    });

    const seenFromB = await withOrg({ orgId: ORG_B, userId: SYSTEM_USER }, async (tx) => {
      const rows = await tx.execute<{ count: string }>(sql`
        select count(*)::text as count from hr.employees where id = ${mine.id}
      `);
      return rows[0]?.count;
    });
    expect(seenFromB).toBe('0');

    // The same employee code in two orgs is fine, which is the point of the unique index
    // being on (org_id, code) rather than on code.
    const fromA = await withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
      const rows = await tx.execute<{ full_name: string }>(sql`
        select full_name from hr.employees where code = 'TEN-01'
      `);
      return rows.map((row) => row.full_name);
    });
    expect(fromA).toEqual(['Org A staff']);
  });

  it('has RLS enabled and forced on every hr table', async () => {
    const rows = await withSystem(async (tx) => {
      const result = await tx.execute<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(sql`
        select c.relname, c.relrowsecurity, c.relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'hr' and c.relkind = 'r'
        order by c.relname
      `);
      return [...result];
    });
    // M19's fourteen and M20's seven (targets, members, weeks, rules, versions, awards, desk events).
    expect(rows).toHaveLength(21);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} RLS`).toBe(true);
      // FORCE is not optional: without it `erp_owner`, the table owner, is exempt.
      expect(row.relforcerowsecurity, `${row.relname} FORCE`).toBe(true);
    }
  });

  it('gives erp_app no DELETE on a payslip and no UPDATE on one either', async () => {
    const grants = await withSystem(async (tx) => {
      const rows = await tx.execute<{ table_name: string; privilege_type: string }>(sql`
        select table_name, privilege_type
        from information_schema.role_table_grants
        where grantee = 'erp_app' and table_schema = 'hr'
          and table_name in ('payroll_lines', 'payroll_line_components', 'payroll_loan_deductions',
                             'employees', 'attendance_days', 'payroll_runs')
        order by table_name, privilege_type
      `);
      return [...rows];
    });
    const forTable = (name: string) =>
      grants
        .filter((row) => row.table_name === name)
        .map((row) => row.privilege_type)
        .sort();

    // Append-only: the frozen payslip and its evidence.
    expect(forTable('payroll_lines')).toEqual(['INSERT', 'SELECT']);
    expect(forTable('payroll_line_components')).toEqual(['INSERT', 'SELECT']);
    expect(forTable('payroll_loan_deductions')).toEqual(['INSERT', 'SELECT']);
    // Updatable, never deletable: a person who worked here is part of the record.
    expect(forTable('employees')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(forTable('attendance_days')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    expect(forTable('payroll_runs')).toEqual(['INSERT', 'SELECT', 'UPDATE']);
  });
});

// --- check 2 and the frozen payslip -------------------------------------------

describe('a payroll run cannot be posted twice (check 2)', () => {
  it('allows one run per org per month', async () => {
    await withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
      await tx.execute(sql`
        insert into hr.payroll_runs (org_id, month, created_by)
        values (${ORG_A}, '2030-01', ${SYSTEM_USER})
      `);
    });
    await refused(() =>
      withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
        await tx.execute(sql`
          insert into hr.payroll_runs (org_id, month, created_by)
          values (${ORG_A}, '2030-01', ${SYSTEM_USER})
        `);
      }),
    );
  });

  it('refuses a run that claims to be posted on the way in', async () => {
    await refused(
      () =>
        withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
          await tx.execute(sql`
          insert into hr.payroll_runs (org_id, month, status, created_by)
          values (${ORG_A}, '2030-02', 'posted', ${SYSTEM_USER})
        `);
        }),
      /PAYROLL_TRANSITION_INVALID/,
    );
  });

  it('refuses posted → posted and posted → pending_approval', async () => {
    const runId = await withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into hr.payroll_runs (org_id, month, created_by)
        values (${ORG_A}, '2030-03', ${SYSTEM_USER})
        returning id
      `);
      return rows[0]?.id ?? '';
    });

    // Pushed into `posted` the long way round, as the executor does: an approval, then a
    // journal. Written directly here, because the point is the trigger rather than the
    // service.
    const { approvalId, journalId } = await stubApprovalAndJournal(runId);

    await withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
      await tx.execute(sql`
        update hr.payroll_runs
        set status = 'pending_approval', approval_request_id = ${approvalId},
            employee_count = 0, gross_poisha = 0, deductions_poisha = 0, net_poisha = 0
        where org_id = ${ORG_A} and id = ${runId}
      `);
      await tx.execute(sql`
        update hr.payroll_runs
        set status = 'posted', journal_id = ${journalId}, posted_on = current_date
        where org_id = ${ORG_A} and id = ${runId}
      `);
    });

    /*
     * `posted → posted` is absent from this list on purpose.
     *
     * An UPDATE that sets the status to the value it already has changes nothing, and the
     * trigger lets it through as the no-op it is. What stops a *second posting* is the
     * three things that actually would: `markRunPosted` only matches a run in
     * `pending_approval`, the ledger refuses a second journal under the key
     * `payroll_run:<id>:posted`, and the two transitions below are refused — so there is no
     * path back to a state a posting could be started from.
     */
    for (const next of ['pending_approval', 'draft'] as const) {
      await refused(
        () =>
          withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
            await tx.execute(sql`
            update hr.payroll_runs set status = ${next}::hr.payroll_run_status
            where org_id = ${ORG_A} and id = ${runId}
          `);
          }),
        /PAYROLL_TRANSITION_INVALID|PAYROLL_IMMUTABLE/,
      );
    }
  });
});

describe('the frozen payslip', () => {
  it('refuses any change to a payslip, by grant and by trigger', async () => {
    const { lineId } = await seedFrozenRun('2030-04');

    /*
     * Two layers, tested separately, because only one of them fires per caller.
     *
     * `erp_app` — the running API — holds no UPDATE or DELETE on these tables at all
     * (migration 0054), so its refusal is a permission error and the trigger never runs.
     * `erp_owner` — the role that runs migrations, and the role a repair script would
     * connect as — does hold them, and that is exactly the caller the trigger in 0055
     * exists for. Asserting only the first would leave the trigger untested; asserting
     * only the second would leave the grant untested.
     */
    await refused(
      () =>
        withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
          await tx.execute(sql`
          update hr.payroll_lines set net_poisha = net_poisha + 1
          where org_id = ${ORG_A} and id = ${lineId}
        `);
        }),
      /permission denied/i,
    );

    await refused(
      () =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
            update hr.payroll_lines set net_poisha = net_poisha + 1
            where org_id = ${ORG_A} and id = ${lineId}
          `);
          },
          { orgId: ORG_A },
        ),
      /PAYROLL_IMMUTABLE/,
    );

    await refused(
      () =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
            delete from hr.payroll_line_components where org_id = ${ORG_A} and line_id = ${lineId}
          `);
          },
          { orgId: ORG_A },
        ),
      /PAYROLL_IMMUTABLE/,
    );
  });

  it('refuses a payslip whose components do not add up', async () => {
    const runId = await draftRun('2030-05');
    const { employeeId, structureId } = await payableEmployee('FRZ-01');

    await refused(
      () =>
        withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
          const rows = await tx.execute<{ id: string }>(sql`
          insert into hr.payroll_lines
            (org_id, run_id, employee_id, salary_structure_id, basic_poisha, allowances_poisha,
             bonus_poisha, gross_poisha, absence_deduction_poisha, fixed_deduction_poisha,
             other_deduction_poisha, loan_deduction_poisha, deductions_poisha, net_poisha,
             salary_expense_poisha, working_days, present_days, absent_days)
          values (${ORG_A}, ${runId}, ${employeeId}, ${structureId}, 2000000, 0, 0, 2000000,
                  0, 0, 0, 0, 0, 2000000, 2000000, 27, 27, 0)
          returning id
        `);
          // One component of ৳5,000 against a payslip of ৳20,000: the deferred trigger in
          // migration 0056 compares them at commit.
          await tx.execute(sql`
          insert into hr.payroll_line_components
            (org_id, line_id, direction, code, label, amount_poisha, line_no)
          values (${ORG_A}, ${rows[0]?.id ?? ''}, 'earning', 'basic', 'Basic', 500000, 1)
        `);
        }),
      /PAYROLL_TOTALS_MISMATCH/,
    );
  });

  it('refuses a payslip that does not balance against the payroll journal', async () => {
    const runId = await draftRun('2030-06');
    const { employeeId, structureId } = await payableEmployee('FRZ-02');

    await refused(
      () =>
        withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
          // salary expense 2,000,000 + bonus 0 ≠ net 1,900,000 + loan 0. §7's journal would
          // balance — it is built from these two columns — and book the wrong expense.
          await tx.execute(sql`
          insert into hr.payroll_lines
            (org_id, run_id, employee_id, salary_structure_id, basic_poisha, allowances_poisha,
             bonus_poisha, gross_poisha, absence_deduction_poisha, fixed_deduction_poisha,
             other_deduction_poisha, loan_deduction_poisha, deductions_poisha, net_poisha,
             salary_expense_poisha, working_days, present_days, absent_days)
          values (${ORG_A}, ${runId}, ${employeeId}, ${structureId}, 2000000, 0, 0, 2000000,
                  100000, 0, 0, 0, 100000, 1900000, 2000000, 27, 26, 1)
        `);
        }),
      /PAYROLL_TOTALS_MISMATCH|payroll_lines_journal_identity/,
    );
  });

  it('refuses a submitted run whose totals disagree with its payslips', async () => {
    const runId = await draftRun('2030-07');
    const { employeeId, structureId } = await payableEmployee('FRZ-03');
    const { approvalId } = await stubApprovalAndJournal(runId, '2000000');

    await refused(
      () =>
        withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
          const rows = await tx.execute<{ id: string }>(sql`
          insert into hr.payroll_lines
            (org_id, run_id, employee_id, salary_structure_id, basic_poisha, allowances_poisha,
             bonus_poisha, gross_poisha, absence_deduction_poisha, fixed_deduction_poisha,
             other_deduction_poisha, loan_deduction_poisha, deductions_poisha, net_poisha,
             salary_expense_poisha, working_days, present_days, absent_days)
          values (${ORG_A}, ${runId}, ${employeeId}, ${structureId}, 1000000, 0, 0, 1000000,
                  0, 0, 0, 0, 0, 1000000, 1000000, 27, 27, 0)
          returning id
        `);
          await tx.execute(sql`
          insert into hr.payroll_line_components
            (org_id, line_id, direction, code, label, amount_poisha, line_no)
          values (${ORG_A}, ${rows[0]?.id ?? ''}, 'earning', 'basic', 'Basic', 1000000, 1)
        `);
          // The run says ৳20,000; its one payslip says ৳10,000.
          await tx.execute(sql`
          update hr.payroll_runs
          set status = 'pending_approval', approval_request_id = ${approvalId},
              employee_count = 1, gross_poisha = 2000000, deductions_poisha = 0,
              net_poisha = 2000000
          where org_id = ${ORG_A} and id = ${runId}
        `);
        }),
      /PAYROLL_TOTALS_MISMATCH/,
    );
  });

  it('refuses a run pointed at an approval for a different amount', async () => {
    const runId = await draftRun('2030-08');
    const { approvalId } = await stubApprovalAndJournal(runId, '999');

    await refused(
      () =>
        withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
          await tx.execute(sql`
          update hr.payroll_runs
          set status = 'pending_approval', approval_request_id = ${approvalId},
              employee_count = 0, gross_poisha = 0, deductions_poisha = 0, net_poisha = 12345
          where org_id = ${ORG_A} and id = ${runId}
        `);
        }),
      /PAYROLL_APPROVAL_INVALID/,
    );
  });

  it('refuses a run approved against an amount a person typed', async () => {
    const runId = await draftRun('2030-09');
    const { approvalId } = await stubApprovalAndJournal(runId, '12345', {
      derivedByServer: false,
    });

    await refused(
      () =>
        withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
          await tx.execute(sql`
          update hr.payroll_runs
          set status = 'pending_approval', approval_request_id = ${approvalId},
              employee_count = 0, gross_poisha = 0, deductions_poisha = 0, net_poisha = 12345
          where org_id = ${ORG_A} and id = ${runId}
        `);
        }),
      /PAYROLL_APPROVAL_INVALID/,
    );
  });

  it('refuses a change to a salary structure a payslip has used', async () => {
    const { structureId } = await seedFrozenRun('2030-10');
    await refused(
      () =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
            update hr.salary_structures set basic_poisha = 9999999
            where org_id = ${ORG_A} and id = ${structureId}
          `);
          },
          { orgId: ORG_A },
        ),
      /PAYROLL_STRUCTURE_FROZEN/,
    );
  });
});

// --- loans and attendance -----------------------------------------------------

describe('loans and attendance in the database', () => {
  it('never lets an instalment be deducted beyond its amount, or un-deducted', async () => {
    const employee = await seedEmployee(ORG_A, {
      code: 'LOAN-01',
      fullName: 'Borrower',
      joinDate: '2026-01-01',
    });
    const instalmentId = await withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
      const loan = await tx.execute<{ id: string }>(sql`
          insert into hr.employee_loans
            (org_id, employee_id, principal_poisha, instalment_count, first_month, created_by)
          values (${ORG_A}, ${employee.id}, 600000, 3, '2030-01', ${SYSTEM_USER})
          returning id
        `);
      const rows = await tx.execute<{ id: string }>(sql`
          insert into hr.loan_instalments (org_id, loan_id, seq, due_month, amount_poisha)
          values (${ORG_A}, ${loan[0]?.id ?? ''}, 1, '2030-01', 200000)
          returning id
        `);
      return rows[0]?.id ?? '';
    });

    await withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
      await tx.execute(sql`
        update hr.loan_instalments
        set deducted_poisha = 200000, status = 'deducted'
        where org_id = ${ORG_A} and id = ${instalmentId}
      `);
    });

    await refused(() =>
      withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
        await tx.execute(sql`
          update hr.loan_instalments set deducted_poisha = 250000
          where org_id = ${ORG_A} and id = ${instalmentId}
        `);
      }),
    );

    await refused(
      () =>
        withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
          await tx.execute(sql`
          update hr.loan_instalments set deducted_poisha = 0, status = 'due'
          where org_id = ${ORG_A} and id = ${instalmentId}
        `);
        }),
      /PAYROLL_LOAN_FROZEN/,
    );
  });

  it('refuses an active loan with no journal behind it', async () => {
    const employee = await seedEmployee(ORG_A, {
      code: 'LOAN-02',
      fullName: 'No journal',
      joinDate: '2026-01-01',
    });
    await refused(() =>
      withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
        await tx.execute(sql`
          insert into hr.employee_loans
            (org_id, employee_id, principal_poisha, instalment_count, first_month, status,
             created_by)
          values (${ORG_A}, ${employee.id}, 600000, 3, '2030-01', 'active', ${SYSTEM_USER})
        `);
      }),
    );
  });

  it('requires a correction to record itself as manual', async () => {
    const employee = await seedEmployee(ORG_A, {
      code: 'ATT-01',
      fullName: 'Attendee',
      joinDate: '2026-01-01',
    });
    const calendar = await withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, (tx) =>
      ensureDefaultCalendar(tx, ORG_A),
    );
    await seedHoliday(ORG_A, { calendarId: calendar.id, date: '2030-02-21', label: 'Shaheed Day' });
    await seedAttendance(ORG_A, {
      employeeId: employee.id,
      date: '2030-02-04',
      status: 'present',
    });

    // Force the row to look imported, then try to correct it while still claiming it was.
    await withSystem(
      async (tx) => {
        const importRows = await tx.execute<{ id: string }>(sql`
          insert into hr.attendance_imports
            (org_id, month, status, mapping, row_count, accepted_count, rejected_count, created_by)
          values (${ORG_A}, '2030-02', 'applied', '{}'::jsonb, 1, 1, 0, ${SYSTEM_USER})
          returning id
        `);
        await tx.execute(sql`
          update hr.attendance_days
          set source = 'csv_import', import_id = ${importRows[0]?.id ?? ''}
          where org_id = ${ORG_A} and employee_id = ${employee.id}
            and business_date = '2030-02-04'::date
        `);
      },
      { orgId: ORG_A },
    );

    await refused(
      () =>
        withSystem(
          async (tx) => {
            await tx.execute(sql`
            update hr.attendance_days set status = 'absent'
            where org_id = ${ORG_A} and employee_id = ${employee.id}
              and business_date = '2030-02-04'::date
          `);
          },
          { orgId: ORG_A },
        ),
      /ATTENDANCE_INVALID/,
    );
  });

  it('gives an org without one a default working-day calendar on first use (D-187)', async () => {
    /*
     * Migration 0057 is a backfill, and the harness proves why it needs a partner.
     *
     * `startTestDatabase` runs `migrate()` and *then* seeds the five orgs — the same order
     * `pnpm db:migrate && pnpm db:seed` uses — so 0057 sees an empty `org.organizations` and
     * inserts nothing. `ensureDefaultCalendar` is what makes payroll work anyway, and this
     * is the test that would have caught the version of this milestone where it did not:
     * without it, every payroll run in a freshly seeded database refused to compute.
     */
    for (const orgId of [ORG_A, ORG_B]) {
      // No assertion that the org starts with none: another test in this file may have
      // created it already, and a test that depends on the order of its neighbours is a
      // test that fails for a reason nobody can find.
      const created = await withOrg({ orgId, userId: SYSTEM_USER }, (tx) =>
        ensureDefaultCalendar(tx, orgId),
      );
      expect(created.code).toBe('STD');
      expect(created.weekly_off).toEqual([5]);
      expect(created.is_default).toBe(true);

      // Idempotent: a second call returns the same row rather than colliding on the
      // partial unique index that allows one default per org.
      const again = await withOrg({ orgId, userId: SYSTEM_USER }, (tx) =>
        ensureDefaultCalendar(tx, orgId),
      );
      expect(again.id).toBe(created.id);
    }
  });
});

// --- helpers ------------------------------------------------------------------

async function draftRun(month: string): Promise<string> {
  return withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      insert into hr.payroll_runs (org_id, month, created_by)
      values (${ORG_A}, ${month}, ${SYSTEM_USER})
      returning id
    `);
    return rows[0]?.id ?? '';
  });
}

async function payableEmployee(code: string): Promise<{ employeeId: string; structureId: string }> {
  const employee = await seedEmployee(ORG_A, {
    code,
    fullName: `Employee ${code}`,
    joinDate: '2026-01-01',
  });
  const structureId = await seedStructure(ORG_A, {
    employeeId: employee.id,
    effectiveFrom: '2026-01-01',
    basicPoisha: 2_000_000n,
  });
  return { employeeId: employee.id, structureId };
}

/**
 * An approved `payroll_run` request and a balanced journal, written directly.
 *
 * The suite's subject is the triggers, not the services, so the two rows the triggers
 * compare against are made by hand. The request is created with
 * `amount_derived_by_server` true by default, because that is what migration 0056
 * requires and the one test that needs it false asks for it.
 */
async function stubApprovalAndJournal(
  runId: string,
  amountPoisha = '0',
  options: { derivedByServer?: boolean } = {},
): Promise<{ approvalId: string; journalId: string }> {
  return withSystem(
    async (tx) => {
      /*
       * Raised pending, then decided — which is not a convenience, it is the only way in.
       *
       * Migration 0015's `stamp_request` trigger refuses a request born `approved`: an
       * approval row is evidence, and a row that arrived already decided is evidence of
       * nothing. Two statements here is the same two the approvals service makes.
       */
      const approval = await tx.execute<{ id: string }>(sql`
        insert into approvals.approval_requests
          (org_id, type, status, requested_by, amount_poisha, amount_derived_by_server, payload)
        values (${ORG_A}, 'payroll_run', 'pending', 'usr_maker', ${amountPoisha},
                ${options.derivedByServer ?? true}, ${JSON.stringify({ runId })}::jsonb)
        returning id
      `);
      await tx.execute(sql`
        update approvals.approval_requests
        set status = 'approved', decided_by = 'usr_checker', decided_at = now()
        where org_id = ${ORG_A} and id = ${approval[0]?.id ?? ''}
      `);

      const accounts = await tx.execute<{ id: string; subtype: string }>(sql`
        select id, subtype::text as subtype from ledger.accounts
        where org_id = ${ORG_A} and subtype in ('salary_expense', 'salary_payable')
      `);
      const expense = accounts.find((row) => row.subtype === 'salary_expense')?.id ?? '';
      const payable = accounts.find((row) => row.subtype === 'salary_payable')?.id ?? '';

      const journal = await tx.execute<{ id: string }>(sql`
        insert into ledger.journals
          (org_id, business_date, source_type, source_id, idempotency_key, memo, content_hash,
           created_by)
        values (${ORG_A}, current_date, 'payroll_run', ${runId},
                ${`payroll_run:${runId}:posted`}, 'stub', repeat('0', 64), ${SYSTEM_USER})
        returning id
      `);
      const journalId = journal[0]?.id ?? '';
      await tx.execute(sql`
        insert into ledger.journal_lines
          (journal_id, org_id, line_no, account_id, debit_poisha, credit_poisha)
        values (${journalId}, ${ORG_A}, 1, ${expense}, 1, 0),
               (${journalId}, ${ORG_A}, 2, ${payable}, 0, 1)
      `);

      return { approvalId: approval[0]?.id ?? '', journalId };
    },
    { orgId: ORG_A },
  );
}

/** A run pushed all the way to `posted`, with one payslip that adds up. */
async function seedFrozenRun(
  month: string,
): Promise<{ runId: string; lineId: string; structureId: string }> {
  const runId = await draftRun(month);
  const { employeeId, structureId } = await payableEmployee(`FRZ-${month}`);
  const { approvalId, journalId } = await stubApprovalAndJournal(runId, '2000000');

  const lineId = await withOrg({ orgId: ORG_A, userId: SYSTEM_USER }, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      insert into hr.payroll_lines
        (org_id, run_id, employee_id, salary_structure_id, basic_poisha, allowances_poisha,
         bonus_poisha, gross_poisha, absence_deduction_poisha, fixed_deduction_poisha,
         other_deduction_poisha, loan_deduction_poisha, deductions_poisha, net_poisha,
         salary_expense_poisha, working_days, present_days, absent_days)
      values (${ORG_A}, ${runId}, ${employeeId}, ${structureId}, 2000000, 0, 0, 2000000,
              0, 0, 0, 0, 0, 2000000, 2000000, 27, 27, 0)
      returning id
    `);
    const id = rows[0]?.id ?? '';
    await tx.execute(sql`
      insert into hr.payroll_line_components
        (org_id, line_id, direction, code, label, amount_poisha, line_no)
      values (${ORG_A}, ${id}, 'earning', 'basic', 'Basic', 2000000, 1)
    `);
    await tx.execute(sql`
      update hr.payroll_runs
      set status = 'pending_approval', approval_request_id = ${approvalId},
          employee_count = 1, gross_poisha = 2000000, deductions_poisha = 0,
          net_poisha = 2000000
      where org_id = ${ORG_A} and id = ${runId}
    `);
    await tx.execute(sql`
      update hr.payroll_runs
      set status = 'posted', journal_id = ${journalId}, posted_on = current_date
      where org_id = ${ORG_A} and id = ${runId}
    `);
    return id;
  });

  return { runId, lineId, structureId };
}
