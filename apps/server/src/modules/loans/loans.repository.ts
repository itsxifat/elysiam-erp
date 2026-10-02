import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The loans module's SQL (M26). Every statement names `loans.*` and nothing else: accounts
 * and journals come through `LEDGER_API`, approvals through `ApprovalsService`, messages
 * through `NotifyApi` (invariant 12, `module-boundaries.test.ts`).
 *
 * Every query runs inside the caller's `withOrg`, so RLS is the floor; the explicit
 * `org_id = …` is the index's leading column. Amounts come back as text and become bigints
 * at the edge of the service, never numbers.
 */

// --- lenders ---------------------------------------------------------------------

export interface LenderRow extends Record<string, unknown> {
  readonly id: string;
  readonly name: string;
  readonly kind: 'bank' | 'person' | 'other';
  readonly notes: string | null;
  readonly created_at: Date;
}

export async function listLenders(tx: Tx, orgId: string): Promise<LenderRow[]> {
  const rows = await tx.execute<LenderRow>(sql`
    select id, name, kind, notes, created_at from loans.lenders
    where org_id = ${orgId} order by name, created_at
  `);
  return [...rows];
}

export async function lenderById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<LenderRow | undefined> {
  const rows = await tx.execute<LenderRow>(sql`
    select id, name, kind, notes, created_at from loans.lenders
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

export async function insertLender(
  tx: Tx,
  row: {
    readonly orgId: string;
    readonly name: string;
    readonly kind: string;
    readonly notes: string | null;
    readonly createdBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into loans.lenders (org_id, name, kind, notes, created_by)
    values (${row.orgId}, ${row.name}, ${row.kind}, ${row.notes}, ${row.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('the lender insert returned no id');
  return id;
}

// --- loans and their schedules -----------------------------------------------------

export interface LoanRow extends Record<string, unknown> {
  readonly id: string;
  readonly lender_id: string;
  readonly lender_name: string;
  readonly reference: string | null;
  readonly principal_poisha: string;
  readonly rate_bps: number;
  readonly method: 'flat' | 'reducing';
  readonly tenure_months: number;
  readonly received_on: string;
  readonly first_due_on: string;
  readonly reminder_days: number;
  readonly reminder_phone: string | null;
  readonly wallet_account_id: string;
  readonly received_journal_id: string;
  readonly memo: string | null;
  readonly created_at: Date;
}

const LOAN_COLUMNS = sql`l.id, l.lender_id, le.name as lender_name, l.reference,
  l.principal_poisha::text as principal_poisha, l.rate_bps, l.method, l.tenure_months,
  l.received_on::text as received_on, l.first_due_on::text as first_due_on, l.reminder_days,
  l.reminder_phone, l.wallet_account_id, l.received_journal_id, l.memo, l.created_at`;

export async function loanById(tx: Tx, orgId: string, id: string): Promise<LoanRow | undefined> {
  const rows = await tx.execute<LoanRow>(sql`
    select ${LOAN_COLUMNS}
    from loans.loans l
    join loans.lenders le on le.org_id = l.org_id and le.id = l.lender_id
    where l.org_id = ${orgId} and l.id = ${id}
  `);
  return rows[0];
}

export async function insertLoan(
  tx: Tx,
  row: {
    readonly orgId: string;
    readonly id: string;
    readonly lenderId: string;
    readonly reference: string | null;
    readonly principalPoisha: bigint;
    readonly rateBps: number;
    readonly method: string;
    readonly tenureMonths: number;
    readonly receivedOn: string;
    readonly firstDueOn: string;
    readonly reminderDays: number;
    readonly reminderPhone: string | null;
    readonly walletAccountId: string;
    readonly receivedJournalId: string;
    readonly memo: string | null;
    readonly createdBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into loans.loans
      (org_id, id, lender_id, reference, principal_poisha, rate_bps, method, tenure_months,
       received_on, first_due_on, reminder_days, reminder_phone, wallet_account_id,
       received_journal_id, memo, created_by)
    values (${row.orgId}, ${row.id}, ${row.lenderId}, ${row.reference},
            ${row.principalPoisha.toString()}::bigint, ${row.rateBps}, ${row.method},
            ${row.tenureMonths}, ${row.receivedOn}::date, ${row.firstDueOn}::date,
            ${row.reminderDays}, ${row.reminderPhone}, ${row.walletAccountId},
            ${row.receivedJournalId}, ${row.memo}, ${row.createdBy})
  `);
}

export async function insertInstalments(
  tx: Tx,
  orgId: string,
  loanId: string,
  rows: readonly {
    readonly seq: number;
    readonly dueOn: string;
    readonly principalPoisha: bigint;
    readonly interestPoisha: bigint;
  }[],
): Promise<void> {
  for (const row of rows) {
    await tx.execute(sql`
      insert into loans.instalments (org_id, loan_id, seq, due_on, principal_poisha, interest_poisha)
      values (${orgId}, ${loanId}, ${row.seq}, ${row.dueOn}::date,
              ${row.principalPoisha.toString()}::bigint, ${row.interestPoisha.toString()}::bigint)
    `);
  }
}

export interface LoanSummaryRow extends LoanRow {
  readonly instalments: number;
  readonly paid_instalments: number;
  readonly paid_principal_poisha: string;
  readonly paid_interest_poisha: string;
  readonly next_instalment_id: string | null;
  readonly next_seq: number | null;
  readonly next_due_on: string | null;
  readonly next_total_poisha: string | null;
  readonly next_status: 'pending_approval' | null;
}

/**
 * Every loan with what is paid and the next instalment, derived from the rows (no balance
 * column to drift). "Next" is the lowest instalment without a posted payment; it may be
 * waiting for a checker, which `next_status` says.
 */
export async function listLoans(tx: Tx, orgId: string): Promise<LoanSummaryRow[]> {
  const rows = await tx.execute<LoanSummaryRow>(sql`
    select ${LOAN_COLUMNS},
           paid.instalments, paid.paid_instalments,
           paid.paid_principal_poisha, paid.paid_interest_poisha,
           nx.id as next_instalment_id, nx.seq as next_seq, nx.due_on as next_due_on,
           nx.total_poisha as next_total_poisha, nx.status as next_status
    from loans.loans l
    join loans.lenders le on le.org_id = l.org_id and le.id = l.lender_id
    cross join lateral (
      select count(*)::int as instalments,
             count(p.id)::int as paid_instalments,
             coalesce(sum(p.principal_poisha), 0)::text as paid_principal_poisha,
             coalesce(sum(p.interest_poisha), 0)::text as paid_interest_poisha
      from loans.instalments i
      left join loans.payments p
        on p.org_id = i.org_id and p.instalment_id = i.id and p.status = 'posted'
      where i.org_id = l.org_id and i.loan_id = l.id
    ) paid
    left join lateral (
      select i.id, i.seq, i.due_on::text as due_on,
             (i.principal_poisha + i.interest_poisha)::text as total_poisha,
             (select p.status from loans.payments p
               where p.org_id = i.org_id and p.instalment_id = i.id
                 and p.status = 'pending_approval') as status
      from loans.instalments i
      where i.org_id = l.org_id and i.loan_id = l.id
        and not exists (select 1 from loans.payments p
                        where p.org_id = i.org_id and p.instalment_id = i.id
                          and p.status = 'posted')
      order by i.seq
      limit 1
    ) nx on true
    where l.org_id = ${orgId}
    order by nx.due_on nulls last, l.created_at desc
  `);
  return [...rows];
}

export interface InstalmentRow extends Record<string, unknown> {
  readonly id: string;
  readonly loan_id: string;
  readonly seq: number;
  readonly due_on: string;
  readonly principal_poisha: string;
  readonly interest_poisha: string;
  /** The live payment's status: posted, waiting for a checker, or none. */
  readonly payment_status: 'posted' | 'pending_approval' | null;
  readonly payment_id: string | null;
  readonly reminded_on: string | null;
}

export async function instalmentsOf(
  tx: Tx,
  orgId: string,
  loanId: string,
): Promise<InstalmentRow[]> {
  const rows = await tx.execute<InstalmentRow>(sql`
    select i.id, i.loan_id, i.seq, i.due_on::text as due_on,
           i.principal_poisha::text as principal_poisha,
           i.interest_poisha::text as interest_poisha,
           p.status as payment_status, p.id as payment_id,
           r.reminded_on::text as reminded_on
    from loans.instalments i
    left join loans.payments p
      on p.org_id = i.org_id and p.instalment_id = i.id and p.status <> 'rejected'
    left join loans.reminders r on r.org_id = i.org_id and r.instalment_id = i.id
    where i.org_id = ${orgId} and i.loan_id = ${loanId}
    order by i.seq
  `);
  return [...rows];
}

// --- payments ----------------------------------------------------------------------

export interface PaymentRow extends Record<string, unknown> {
  readonly id: string;
  readonly loan_id: string;
  readonly instalment_id: string;
  readonly seq: number;
  readonly wallet_account_id: string;
  readonly principal_poisha: string;
  readonly interest_poisha: string;
  readonly status: 'pending_approval' | 'posted' | 'rejected';
  readonly occurred_at: Date;
  readonly business_date: string;
  readonly approval_request_id: string | null;
  readonly journal_id: string | null;
  readonly memo: string | null;
  readonly created_by: string;
}

const PAYMENT_COLUMNS = sql`p.id, p.loan_id, p.instalment_id, i.seq, p.wallet_account_id,
  p.principal_poisha::text as principal_poisha, p.interest_poisha::text as interest_poisha,
  p.status, p.occurred_at, p.business_date::text as business_date, p.approval_request_id,
  p.journal_id, p.memo, p.created_by`;

export async function paymentById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<PaymentRow | undefined> {
  const rows = await tx.execute<PaymentRow>(sql`
    select ${PAYMENT_COLUMNS}
    from loans.payments p
    join loans.instalments i on i.org_id = p.org_id and i.id = p.instalment_id
    where p.org_id = ${orgId} and p.id = ${id}
  `);
  return rows[0];
}

export async function paymentsOf(tx: Tx, orgId: string, loanId: string): Promise<PaymentRow[]> {
  const rows = await tx.execute<PaymentRow>(sql`
    select ${PAYMENT_COLUMNS}
    from loans.payments p
    join loans.instalments i on i.org_id = p.org_id and i.id = p.instalment_id
    where p.org_id = ${orgId} and p.loan_id = ${loanId}
    order by i.seq, p.created_at
  `);
  return [...rows];
}

export async function insertPayment(
  tx: Tx,
  row: {
    readonly orgId: string;
    readonly id: string;
    readonly loanId: string;
    readonly instalmentId: string;
    readonly walletAccountId: string;
    readonly principalPoisha: bigint;
    readonly interestPoisha: bigint;
    readonly status: 'pending_approval' | 'posted';
    readonly occurredAt: Date;
    readonly businessDate: string;
    readonly approvalRequestId: string | null;
    readonly journalId: string | null;
    readonly memo: string | null;
    readonly createdBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into loans.payments
      (org_id, id, loan_id, instalment_id, wallet_account_id, principal_poisha,
       interest_poisha, status, occurred_at, business_date, approval_request_id, journal_id,
       memo, created_by)
    values (${row.orgId}, ${row.id}, ${row.loanId}, ${row.instalmentId}, ${row.walletAccountId},
            ${row.principalPoisha.toString()}::bigint, ${row.interestPoisha.toString()}::bigint,
            ${row.status}, ${row.occurredAt.toISOString()}::timestamptz, ${row.businessDate}::date,
            ${row.approvalRequestId}::uuid, ${row.journalId}::uuid, ${row.memo}, ${row.createdBy})
  `);
}

/** The one transition: pending_approval → posted | rejected (0090). Returns rows moved. */
export async function settlePayment(
  tx: Tx,
  orgId: string,
  id: string,
  outcome: { readonly status: 'posted' | 'rejected'; readonly journalId: string | null },
): Promise<number> {
  const rows = await tx.execute<{ id: string }>(sql`
    update loans.payments
    set status = ${outcome.status}, journal_id = ${outcome.journalId}::uuid, updated_at = now()
    where org_id = ${orgId} and id = ${id} and status = 'pending_approval'
    returning id
  `);
  return rows.length;
}

// --- reminders ---------------------------------------------------------------------

export interface ReminderCandidateRow extends Record<string, unknown> {
  readonly instalment_id: string;
  readonly loan_id: string;
  readonly seq: number;
  readonly due_on: string;
  readonly total_poisha: string;
  readonly reminder_days: number;
  readonly reminder_phone: string | null;
  readonly lender_name: string;
}

/**
 * Unpaid, unreminded instalments due on or before `horizon`. "Unpaid" means no live
 * payment: one waiting for a checker is already in hand and needs no reminder. The window
 * itself (`isReminderDue`) is the domain's; this only narrows what it is asked about.
 */
export async function reminderCandidates(
  tx: Tx,
  orgId: string,
  horizon: string,
): Promise<ReminderCandidateRow[]> {
  const rows = await tx.execute<ReminderCandidateRow>(sql`
    select i.id as instalment_id, i.loan_id, i.seq, i.due_on::text as due_on,
           (i.principal_poisha + i.interest_poisha)::text as total_poisha,
           l.reminder_days, l.reminder_phone, le.name as lender_name
    from loans.instalments i
    join loans.loans l on l.org_id = i.org_id and l.id = i.loan_id
    join loans.lenders le on le.org_id = l.org_id and le.id = l.lender_id
    where i.org_id = ${orgId}
      and i.due_on <= ${horizon}::date
      and not exists (select 1 from loans.reminders r
                      where r.org_id = i.org_id and r.instalment_id = i.id)
      and not exists (select 1 from loans.payments p
                      where p.org_id = i.org_id and p.instalment_id = i.id
                        and p.status <> 'rejected')
    order by i.due_on, i.seq
  `);
  return [...rows];
}

export async function reminderExists(
  tx: Tx,
  orgId: string,
  instalmentId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ found: boolean }>(sql`
    select exists (select 1 from loans.reminders
                   where org_id = ${orgId} and instalment_id = ${instalmentId}) as found
  `);
  return rows[0]?.found === true;
}

export async function insertReminder(
  tx: Tx,
  row: {
    readonly orgId: string;
    readonly loanId: string;
    readonly instalmentId: string;
    readonly remindedOn: string;
    readonly smsState: 'queued' | 'suppressed' | 'no_phone' | 'failed';
    readonly messageId: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into loans.reminders (org_id, loan_id, instalment_id, reminded_on, sms_state, message_id)
    values (${row.orgId}, ${row.loanId}, ${row.instalmentId}, ${row.remindedOn}::date,
            ${row.smsState}, ${row.messageId}::uuid)
  `);
}

/**
 * What this module's schedules say the brand still owes one lender, across all their
 * loans: Σ principal less Σ posted principal. The statement puts it beside the ledger's
 * `loan_payable` balance for the same party.
 */
export async function lenderOutstanding(tx: Tx, orgId: string, lenderId: string): Promise<bigint> {
  const rows = await tx.execute<{ owed: string }>(sql`
    select (
      coalesce((select sum(principal_poisha) from loans.loans
                where org_id = ${orgId} and lender_id = ${lenderId}), 0)
      - coalesce((select sum(p.principal_poisha) from loans.payments p
                  join loans.loans l on l.org_id = p.org_id and l.id = p.loan_id
                  where p.org_id = ${orgId} and l.lender_id = ${lenderId}
                    and p.status = 'posted'), 0)
    )::text as owed
  `);
  return BigInt(rows[0]?.owed ?? '0');
}
