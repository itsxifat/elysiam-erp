import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Every SQL statement the ledger module runs (tenancy rules: raw SQL lives in
 * repositories, parameterised, never interpolated).
 *
 * All of it runs inside a caller's `withOrg()` transaction, so RLS already
 * confines every query to the active org; the explicit `org_id` filters are
 * there for the planner and for the reader, not as the control.
 */

export interface AccountRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly class: string;
  readonly subtype: string;
  readonly normal_balance: 'debit' | 'credit';
  readonly branch_id: string | null;
  readonly party_type: string | null;
  readonly is_system: boolean;
  readonly is_active: boolean;
}

const ACCOUNT_COLUMNS = sql`a.id, a.code, a.name, a.class::text as class, a.subtype::text as subtype,
  a.normal_balance::text as normal_balance, a.branch_id, a.party_type::text as party_type,
  a.is_system, a.is_active`;

export async function accountsByIds(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
): Promise<AccountRow[]> {
  if (ids.length === 0) return [];
  const rows = await tx.execute<AccountRow>(sql`
    select ${ACCOUNT_COLUMNS}
    from ledger.accounts a
    where a.org_id = ${orgId}
      and a.id in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})
  `);
  return [...rows];
}

export async function listAccounts(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly excludeSubtypes: readonly string[];
    readonly walletsOnly?: boolean;
  },
): Promise<AccountRow[]> {
  const rows = await tx.execute<AccountRow>(sql`
    select ${ACCOUNT_COLUMNS}
    from ledger.accounts a
    where a.org_id = ${orgId}
      and ${filters.scope}
      and ${excludeSubtypes(sql`a.subtype`, filters.excludeSubtypes)}
      and ${filters.walletsOnly === true ? sql`a.subtype::text like 'wallet\\_%'` : sql`true`}
    order by a.code
  `);
  return [...rows];
}

function excludeSubtypes(column: SQL, subtypes: readonly string[]): SQL {
  if (subtypes.length === 0) return sql`true`;
  return sql`${column}::text <> all (${sql.param([...subtypes])}::text[])`;
}

export async function journalIdByKey(
  tx: Tx,
  orgId: string,
  key: string,
): Promise<{ id: string; content_hash: string } | undefined> {
  const rows = await tx.execute<{ id: string; content_hash: string }>(sql`
    select id, content_hash from ledger.journals
    where org_id = ${orgId} and idempotency_key = ${key}
  `);
  return rows[0];
}

export async function closedPeriodFor(tx: Tx, orgId: string, startsOn: string): Promise<boolean> {
  const rows = await tx.execute<{ closed: boolean }>(sql`
    select status = 'closed' as closed from ledger.periods
    where org_id = ${orgId} and starts_on = ${startsOn}
  `);
  return rows[0]?.closed === true;
}

export interface NewJournal {
  readonly orgId: string;
  readonly businessDate: string;
  readonly sourceType: string;
  readonly sourceId: string;
  readonly idempotencyKey: string;
  readonly memo: string | null;
  readonly reversesJournalId: string | null;
  readonly contentHash: string;
  readonly createdBy: string;
}

/**
 * Insert a journal unless its key exists. Returns its id, or undefined when a
 * concurrent post with the same key got there first (which this statement
 * waited for).
 */
export async function insertJournal(tx: Tx, journal: NewJournal): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into ledger.journals
      (org_id, business_date, source_type, source_id, idempotency_key, memo,
       reverses_journal_id, content_hash, created_by, created_txid)
    values (
      ${journal.orgId}, ${journal.businessDate}, ${journal.sourceType}, ${journal.sourceId},
      ${journal.idempotencyKey}, ${journal.memo}, ${journal.reversesJournalId}::uuid,
      ${journal.contentHash}, ${journal.createdBy},
      -- Overwritten by the trigger; a column default would do, but NOT NULL
      -- wants a value and this keeps the statement honest about it.
      pg_current_xact_id()
    )
    on conflict (org_id, idempotency_key) do nothing
    returning id
  `);
  return rows[0]?.id;
}

export interface NewLine {
  readonly accountId: string;
  readonly branchId: string | null;
  readonly partyType: string | null;
  readonly partyId: string | null;
  readonly debitPoisha: bigint;
  readonly creditPoisha: bigint;
  readonly memo: string | null;
}

export async function insertLines(
  tx: Tx,
  orgId: string,
  journalId: string,
  lines: readonly NewLine[],
): Promise<void> {
  await tx.execute(sql`
    insert into ledger.journal_lines
      (org_id, journal_id, line_no, account_id, branch_id, party_type, party_id,
       debit_poisha, credit_poisha, memo)
    values ${sql.join(
      lines.map(
        (line, index) => sql`(
          ${orgId}, ${journalId}, ${index + 1}, ${line.accountId}, ${line.branchId}::uuid,
          ${line.partyType}::ledger.party_type, ${line.partyId}::uuid,
          ${line.debitPoisha.toString()}::bigint, ${line.creditPoisha.toString()}::bigint,
          ${line.memo}
        )`,
      ),
      sql`, `,
    )}
  `);
}

export interface JournalRow extends Record<string, unknown> {
  readonly id: string;
  readonly business_date: string;
  readonly source_type: string;
  readonly source_id: string;
  readonly idempotency_key: string;
  readonly memo: string | null;
  readonly reverses_journal_id: string | null;
  readonly created_by: string;
  readonly created_at: string;
}

export interface LineRow extends Record<string, unknown> {
  readonly journal_id: string;
  readonly line_no: number;
  readonly account_id: string;
  readonly account_code: string;
  readonly account_name: string;
  readonly subtype: string;
  readonly branch_id: string | null;
  readonly party_type: string | null;
  readonly party_id: string | null;
  readonly debit_poisha: string;
  readonly credit_poisha: string;
  readonly memo: string | null;
}

const JOURNAL_COLUMNS = sql`j.id, to_char(j.business_date, 'YYYY-MM-DD') as business_date,
  j.source_type, j.source_id, j.idempotency_key, j.memo, j.reverses_journal_id, j.created_by,
  j.created_at::text as created_at`;

const LINE_COLUMNS = sql`l.journal_id, l.line_no, l.account_id, a.code as account_code,
  a.name as account_name, a.subtype::text as subtype, l.branch_id, l.party_type::text as party_type,
  l.party_id, l.debit_poisha::text as debit_poisha, l.credit_poisha::text as credit_poisha, l.memo`;

export async function journalById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<JournalRow | undefined> {
  const rows = await tx.execute<JournalRow>(sql`
    select ${JOURNAL_COLUMNS} from ledger.journals j where j.org_id = ${orgId} and j.id = ${id}
  `);
  return rows[0];
}

export async function reversalOf(tx: Tx, orgId: string, id: string): Promise<string | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from ledger.journals where org_id = ${orgId} and reverses_journal_id = ${id}
  `);
  return rows[0]?.id;
}

export async function linesOfJournals(
  tx: Tx,
  orgId: string,
  journalIds: readonly string[],
  filters: {
    readonly scope: SQL;
    readonly excludeSubtypes: readonly string[];
    readonly limit?: number;
  } = {
    scope: sql`true`,
    excludeSubtypes: [],
  },
): Promise<LineRow[]> {
  if (journalIds.length === 0) return [];
  const rows = await tx.execute<LineRow>(sql`
    select ${LINE_COLUMNS}
    from ledger.journal_lines l
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and l.journal_id = any (${sql.param([...journalIds])}::uuid[])
      and ${filters.scope}
      and ${excludeSubtypes(sql`a.subtype`, filters.excludeSubtypes)}
    order by array_position(${sql.param([...journalIds])}::uuid[], l.journal_id), l.line_no
    ${filters.limit === undefined ? sql`` : sql`limit ${filters.limit}`}
  `);
  return [...rows];
}

export interface BalanceRow extends Record<string, unknown> {
  readonly account_id: string;
  readonly code: string;
  readonly name: string;
  readonly class: string;
  readonly subtype: string;
  readonly normal_balance: 'debit' | 'credit';
  readonly branch_id: string | null;
  readonly debit_poisha: string;
  readonly credit_poisha: string;
}

/** Σ debit and Σ credit per account, for lines dated on or before `asOf`. */
export async function balancesAsOf(
  tx: Tx,
  orgId: string,
  asOf: string,
  filters: { readonly lineScope: SQL; readonly excludeSubtypes: readonly string[] },
): Promise<BalanceRow[]> {
  const rows = await tx.execute<BalanceRow>(sql`
    select a.id as account_id, a.code, a.name, a.class::text as class, a.subtype::text as subtype,
           a.normal_balance::text as normal_balance, a.branch_id,
           sum(l.debit_poisha)::text as debit_poisha, sum(l.credit_poisha)::text as credit_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and j.business_date <= ${asOf}
      and ${filters.lineScope}
      and ${excludeSubtypes(sql`a.subtype`, filters.excludeSubtypes)}
    group by a.id, a.code, a.name, a.class, a.subtype, a.normal_balance, a.branch_id
    order by a.code
  `);
  return [...rows];
}

/** Σ debit and Σ credit for one account before a date (the opening balance). */
export async function accountTotalsBefore(
  tx: Tx,
  orgId: string,
  accountId: string,
  before: string | undefined,
  lineScope: SQL,
): Promise<{ debit: bigint; credit: bigint }> {
  if (before === undefined) return { debit: 0n, credit: 0n };
  const rows = await tx.execute<{ debit: string | null; credit: string | null }>(sql`
    select sum(l.debit_poisha)::text as debit, sum(l.credit_poisha)::text as credit
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    where l.org_id = ${orgId} and l.account_id = ${accountId}
      and j.business_date < ${before}
      and ${lineScope}
  `);
  return { debit: BigInt(rows[0]?.debit ?? '0'), credit: BigInt(rows[0]?.credit ?? '0') };
}

export interface AccountLineRow extends Record<string, unknown> {
  readonly journal_id: string;
  readonly line_no: number;
  readonly business_date: string;
  readonly source_type: string;
  readonly journal_memo: string | null;
  readonly line_memo: string | null;
  readonly branch_id: string | null;
  readonly party_type: string | null;
  readonly party_id: string | null;
  readonly debit_poisha: string;
  readonly credit_poisha: string;
  readonly created_at: string;
}

/** An account's lines in a date range, oldest first, capped. */
export async function accountLines(
  tx: Tx,
  orgId: string,
  accountId: string,
  range: { readonly from: string | undefined; readonly to: string },
  lineScope: SQL,
  limit: number,
): Promise<AccountLineRow[]> {
  const rows = await tx.execute<AccountLineRow>(sql`
    select l.journal_id, l.line_no, to_char(j.business_date, 'YYYY-MM-DD') as business_date,
           j.source_type, j.memo as journal_memo, l.memo as line_memo, l.branch_id,
           l.party_type::text as party_type, l.party_id,
           l.debit_poisha::text as debit_poisha, l.credit_poisha::text as credit_poisha,
           j.created_at::text as created_at
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    where l.org_id = ${orgId} and l.account_id = ${accountId}
      and j.business_date <= ${range.to}
      and ${range.from === undefined ? sql`true` : sql`j.business_date >= ${range.from}`}
      and ${lineScope}
    order by j.business_date, j.created_at, l.journal_id, l.line_no
    limit ${limit}
  `);
  return [...rows];
}

/** The other accounts on each journal, by code and name only — never amounts. */
export async function counterAccounts(
  tx: Tx,
  orgId: string,
  journalIds: readonly string[],
  excludeAccountId: string,
): Promise<Map<string, { code: string; name: string }[]>> {
  const result = new Map<string, { code: string; name: string }[]>();
  if (journalIds.length === 0) return result;
  const rows = await tx.execute<{ journal_id: string; code: string; name: string }>(sql`
    select distinct l.journal_id, a.code, a.name
    from ledger.journal_lines l
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and l.journal_id = any (${sql.param([...journalIds])}::uuid[])
      and l.account_id <> ${excludeAccountId}
    order by l.journal_id, a.code
  `);
  for (const row of rows) {
    const list = result.get(row.journal_id) ?? [];
    list.push({ code: row.code, name: row.name });
    result.set(row.journal_id, list);
  }
  return result;
}

/**
 * Journals with a business date in the range that have a line the caller may
 * see — in scope, and not on a withheld subtype — capped.
 */
export async function journalsInRange(
  tx: Tx,
  orgId: string,
  range: { readonly from: string; readonly to: string },
  filters: { readonly lineScope: SQL; readonly excludeSubtypes: readonly string[] },
  limit: number,
): Promise<JournalRow[]> {
  const rows = await tx.execute<JournalRow>(sql`
    select ${JOURNAL_COLUMNS}
    from ledger.journals j
    where j.org_id = ${orgId}
      and j.business_date between ${range.from} and ${range.to}
      and exists (
        select 1 from ledger.journal_lines l
        join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
        where l.org_id = j.org_id and l.journal_id = j.id and ${filters.lineScope}
          and ${excludeSubtypes(sql`a.subtype`, filters.excludeSubtypes)}
      )
    order by j.business_date, j.created_at, j.id
    limit ${limit}
  `);
  return [...rows];
}

export interface PartyBalanceRow extends Record<string, unknown> {
  readonly party_type: string;
  readonly party_id: string;
  readonly account_id: string;
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  readonly normal_balance: 'debit' | 'credit';
  readonly debit_poisha: string;
  readonly credit_poisha: string;
}

export async function partyBalances(
  tx: Tx,
  orgId: string,
  filters: {
    readonly asOf: string;
    readonly partyType: string | undefined;
    readonly partyId: string | undefined;
    readonly lineScope: SQL;
    readonly excludeSubtypes: readonly string[];
    readonly excludePartyTypes: readonly string[];
  },
): Promise<PartyBalanceRow[]> {
  const rows = await tx.execute<PartyBalanceRow>(sql`
    select l.party_type::text as party_type, l.party_id, a.id as account_id, a.code, a.name,
           a.subtype::text as subtype, a.normal_balance::text as normal_balance,
           sum(l.debit_poisha)::text as debit_poisha, sum(l.credit_poisha)::text as credit_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and l.party_type is not null
      and j.business_date <= ${filters.asOf}
      and ${filters.partyType === undefined ? sql`true` : sql`l.party_type::text = ${filters.partyType}`}
      and ${filters.partyId === undefined ? sql`true` : sql`l.party_id = ${filters.partyId}`}
      and ${filters.lineScope}
      and ${excludeSubtypes(sql`a.subtype`, filters.excludeSubtypes)}
      and ${
        filters.excludePartyTypes.length === 0
          ? sql`true`
          : sql`l.party_type::text <> all (${sql.param([...filters.excludePartyTypes])}::text[])`
      }
    group by l.party_type, l.party_id, a.id, a.code, a.name, a.subtype, a.normal_balance
    order by l.party_type, l.party_id, a.code
  `);
  return [...rows];
}

export interface PeriodRow extends Record<string, unknown> {
  readonly id: string;
  readonly starts_on: string;
  readonly ends_on: string;
  readonly status: 'open' | 'closed';
  readonly closed_at: string | null;
  readonly closed_by: string | null;
  readonly reopened_at: string | null;
  readonly reopen_approval_id: string | null;
}

const PERIOD_COLUMNS = sql`id, to_char(starts_on, 'YYYY-MM-DD') as starts_on,
  to_char(ends_on, 'YYYY-MM-DD') as ends_on, status::text as status, closed_at::text as closed_at,
  closed_by, reopened_at::text as reopened_at, reopen_approval_id`;

export async function listPeriods(tx: Tx, orgId: string): Promise<PeriodRow[]> {
  const rows = await tx.execute<PeriodRow>(sql`
    select ${PERIOD_COLUMNS} from ledger.periods where org_id = ${orgId} order by starts_on desc
  `);
  return [...rows];
}

export async function periodByStart(
  tx: Tx,
  orgId: string,
  startsOn: string,
  lock = false,
): Promise<PeriodRow | undefined> {
  const rows = await tx.execute<PeriodRow>(sql`
    select ${PERIOD_COLUMNS} from ledger.periods
    where org_id = ${orgId} and starts_on = ${startsOn}
    ${lock ? sql`for update` : sql``}
  `);
  return rows[0];
}

export async function periodById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<PeriodRow | undefined> {
  const rows = await tx.execute<PeriodRow>(sql`
    select ${PERIOD_COLUMNS} from ledger.periods where org_id = ${orgId} and id = ${id} for update
  `);
  return rows[0];
}

/** Close a month: create its row, or move an existing open row to closed. */
export async function closePeriod(
  tx: Tx,
  input: { orgId: string; startsOn: string; endsOn: string; closedBy: string },
): Promise<PeriodRow | undefined> {
  const rows = await tx.execute<PeriodRow>(sql`
    insert into ledger.periods (org_id, starts_on, ends_on, status, closed_at, closed_by)
    values (${input.orgId}, ${input.startsOn}, ${input.endsOn}, 'closed', now(), ${input.closedBy})
    on conflict (org_id, starts_on) do update
      set status = 'closed', closed_at = now(), closed_by = excluded.closed_by, updated_at = now()
      where ledger.periods.status = 'open'
    returning ${PERIOD_COLUMNS}
  `);
  return rows[0];
}

export async function reopenPeriod(
  tx: Tx,
  input: { orgId: string; periodId: string; approvalId: string },
): Promise<void> {
  await tx.execute(sql`
    update ledger.periods
    set status = 'open', reopened_at = now(), reopen_approval_id = ${input.approvalId},
        updated_at = now()
    where org_id = ${input.orgId} and id = ${input.periodId}
  `);
}
