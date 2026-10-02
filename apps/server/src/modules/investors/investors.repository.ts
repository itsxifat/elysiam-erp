import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * Every SQL statement the investors module runs (tenancy rules: raw SQL lives in
 * repositories, parameterised, never built by string interpolation).
 *
 * All of it runs inside a caller's `withOrg()` transaction, so RLS applies to
 * every row read here. There is no analytics read in this file and there is not
 * meant to be: `erp_analytics` bypasses org isolation, and one investor's capital
 * and KYC is the last thing that should be reachable through a role that does.
 *
 * **Nothing here reads a stored balance, because there is not one.** A position is
 * derived from the contributions, distribution lines and paid withdrawals below,
 * each of which names the immutable journal that moved the money. The arithmetic
 * itself is in `packages/domain/src/investors` — this file only fetches rows.
 */

// --- investors ---------------------------------------------------------------

export interface InvestorRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly user_id: string | null;
  readonly phone_masked: string | null;
  readonly email: string | null;
  readonly share_bps: number;
  readonly status: string;
  readonly joined_on: string;
  readonly notes: string | null;
  readonly created_by: string;
}

const INVESTOR_COLUMNS = sql`i.id, i.code, i.name, i.user_id, i.phone_masked, i.email,
  i.share_bps, i.status::text as status, i.joined_on, i.notes, i.created_by`;

export async function listInvestors(
  tx: Tx,
  orgId: string,
  filters: { readonly scope: SQL; readonly includeExited: boolean },
): Promise<InvestorRow[]> {
  const rows = await tx.execute<InvestorRow>(sql`
    select ${INVESTOR_COLUMNS}
    from investors.investors i
    where i.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.includeExited ? sql`true` : sql`i.status = 'active'`}
    order by i.code
  `);
  return [...rows];
}

export async function investorById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<InvestorRow | undefined> {
  const rows = await tx.execute<InvestorRow>(sql`
    select ${INVESTOR_COLUMNS}
    from investors.investors i
    where i.org_id = ${orgId} and i.id = ${id}
  `);
  return rows[0];
}

export interface NewInvestor {
  readonly orgId: string;
  readonly code: string;
  readonly name: string;
  readonly userId: string | null;
  readonly phoneMasked: string | null;
  readonly email: string | null;
  readonly shareBps: number;
  readonly joinedOn: string;
  readonly notes: string | null;
  readonly createdBy: string;
}

export async function insertInvestor(tx: Tx, investor: NewInvestor): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into investors.investors
      (org_id, code, name, user_id, phone_masked, email, share_bps, joined_on, notes, created_by)
    values (${investor.orgId}, ${investor.code}, ${investor.name}, ${investor.userId},
            ${investor.phoneMasked}, ${investor.email}, ${investor.shareBps},
            ${investor.joinedOn}::date, ${investor.notes}, ${investor.createdBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting an investor returned no id');
  return id;
}

export async function updateInvestor(
  tx: Tx,
  orgId: string,
  id: string,
  patch: {
    readonly name?: string;
    readonly userId?: string;
    readonly phoneMasked?: string | null;
    readonly email?: string | null;
    readonly shareBps?: number;
    readonly notes?: string | null;
    readonly status?: 'active' | 'exited';
  },
): Promise<void> {
  await tx.execute(sql`
    update investors.investors
    set name = ${patch.name === undefined ? sql`name` : sql`${patch.name}`},
        user_id = ${patch.userId === undefined ? sql`user_id` : sql`${patch.userId}`},
        phone_masked = ${
          patch.phoneMasked === undefined ? sql`phone_masked` : sql`${patch.phoneMasked}`
        },
        email = ${patch.email === undefined ? sql`email` : sql`${patch.email}`},
        share_bps = ${patch.shareBps === undefined ? sql`share_bps` : sql`${patch.shareBps}`},
        notes = ${patch.notes === undefined ? sql`notes` : sql`${patch.notes}`},
        status = ${
          patch.status === undefined ? sql`status` : sql`${patch.status}::investors.investor_status`
        },
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

/**
 * Take the investor's row lock, so one investor's money is decided one caller at
 * a time.
 *
 * Every check that bounds a withdrawal — the position, the lock-in, and the sum of
 * what is already in flight — is a read followed by a write, and PostgreSQL's
 * default isolation lets two of those interleave. Two ৳8,00,000 requests against
 * ৳10,00,000 of capital each see an empty queue, both pass, and the pair now
 * exceeds the position; two approved withdrawals paid at the same instant each read
 * the pre-payment position and jointly overdraw an equity account, which is
 * perfectly willing to go negative with nothing complaining.
 *
 * So the investor row is the lock for everything about that investor's money, taken
 * before the first read in `request`, `review` and `pay`. It is the narrowest lock
 * that works: two *different* investors never contend, and a stale read cannot
 * survive the transaction that took it.
 */
export async function lockInvestor(tx: Tx, orgId: string, investorId: string): Promise<void> {
  await tx.execute(sql`
    select 1 from investors.investors
    where org_id = ${orgId} and id = ${investorId}
    for update
  `);
}

/**
 * The investor row a login belongs to, for `own` scope.
 *
 * The unique index in 0058 makes this at most one row per org, which is what
 * makes "an investor sees only their own data" a question with one answer.
 */
export async function investorForUser(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<InvestorRow | undefined> {
  const rows = await tx.execute<InvestorRow>(sql`
    select ${INVESTOR_COLUMNS}
    from investors.investors i
    where i.org_id = ${orgId} and i.user_id = ${userId}
  `);
  return rows[0];
}

/**
 * Does this user hold an `investor` membership of this org?
 *
 * A read of `iam.memberships`, which is identity rather than another module's
 * business data — the same kind of read `files` and `ledger` are used for here.
 * It is what makes linking a login safe: without it, an investor row could be
 * pointed at any user id, and `own` scope would then hand that person an
 * investor's capital, distributions and KYC without them holding the role at all.
 */
export async function hasInvestorMembership(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const rows = await tx.execute<{ found: boolean }>(sql`
    select exists (
      select 1 from iam.memberships
      where org_id = ${orgId} and user_id = ${userId}
        and role = 'investor'::iam.membership_role
    ) as found
  `);
  return rows[0]?.found === true;
}

// --- investments -------------------------------------------------------------

export interface InvestmentRow extends Record<string, unknown> {
  readonly id: string;
  readonly investor_id: string;
  readonly amount_poisha: string;
  readonly wallet_account_id: string;
  readonly occurred_at: string;
  readonly business_date: string;
  readonly lock_in_until: string | null;
  readonly terms: string | null;
  readonly memo: string | null;
  readonly journal_id: string;
}

const INVESTMENT_COLUMNS = sql`v.id, v.investor_id, v.amount_poisha::text as amount_poisha,
  v.wallet_account_id, v.occurred_at, v.business_date, v.lock_in_until, v.terms, v.memo,
  v.journal_id`;

export async function listInvestments(
  tx: Tx,
  orgId: string,
  filters: { readonly scope: SQL; readonly investorId?: string | undefined },
): Promise<InvestmentRow[]> {
  const rows = await tx.execute<InvestmentRow>(sql`
    select ${INVESTMENT_COLUMNS}
    from investors.investments v
    join investors.investors i on i.org_id = v.org_id and i.id = v.investor_id
    where v.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.investorId === undefined ? sql`true` : sql`v.investor_id = ${filters.investorId}`}
    order by v.business_date desc, v.created_at desc
  `);
  return [...rows];
}

export async function investmentById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<InvestmentRow | undefined> {
  const rows = await tx.execute<InvestmentRow>(sql`
    select ${INVESTMENT_COLUMNS}
    from investors.investments v
    where v.org_id = ${orgId} and v.id = ${id}
  `);
  return rows[0];
}

export interface NewInvestment {
  readonly orgId: string;
  readonly id: string;
  readonly investorId: string;
  readonly amountPoisha: bigint;
  readonly walletAccountId: string;
  readonly occurredAt: Date;
  readonly businessDate: string;
  readonly lockInUntil: string | null;
  readonly terms: string | null;
  readonly memo: string | null;
  readonly journalId: string;
  readonly createdBy: string;
}

export async function insertInvestment(tx: Tx, investment: NewInvestment): Promise<void> {
  await tx.execute(sql`
    insert into investors.investments
      (org_id, id, investor_id, amount_poisha, wallet_account_id, occurred_at, business_date,
       lock_in_until, terms, memo, journal_id, created_by)
    values (${investment.orgId}, ${investment.id}, ${investment.investorId},
            ${investment.amountPoisha.toString()}, ${investment.walletAccountId},
            ${investment.occurredAt.toISOString()}::timestamptz, ${investment.businessDate}::date,
            ${investment.lockInUntil}::date, ${investment.terms}, ${investment.memo},
            ${investment.journalId}, ${investment.createdBy})
  `);
}

// --- distributions -----------------------------------------------------------

export interface DistributionRow extends Record<string, unknown> {
  readonly id: string;
  readonly period_starts_on: string;
  readonly period_ends_on: string;
  readonly total_poisha: string;
  readonly basis: string;
  readonly status: string;
  readonly approval_request_id: string | null;
  readonly journal_id: string | null;
  readonly declared_on: string | null;
  readonly memo: string | null;
  readonly created_by: string;
}

const DISTRIBUTION_COLUMNS = sql`d.id, d.period_starts_on, d.period_ends_on,
  d.total_poisha::text as total_poisha, d.basis::text as basis, d.status::text as status,
  d.approval_request_id, d.journal_id, d.declared_on, d.memo, d.created_by`;

export async function listDistributions(tx: Tx, orgId: string): Promise<DistributionRow[]> {
  const rows = await tx.execute<DistributionRow>(sql`
    select ${DISTRIBUTION_COLUMNS}
    from investors.distributions d
    where d.org_id = ${orgId}
    order by d.period_ends_on desc, d.created_at desc
  `);
  return [...rows];
}

export async function distributionById(
  tx: Tx,
  orgId: string,
  id: string,
  forUpdate = false,
): Promise<DistributionRow | undefined> {
  const rows = await tx.execute<DistributionRow>(sql`
    select ${DISTRIBUTION_COLUMNS}
    from investors.distributions d
    where d.org_id = ${orgId} and d.id = ${id}
    ${forUpdate ? sql`for update` : sql``}
  `);
  return rows[0];
}

/**
 * A distribution for this period that has not been rejected.
 *
 * The unique index in 0058 refuses a second one, but a constraint violation
 * reaches a caller as a 409 with no explanation and leaves behind an approval
 * request nobody will decide. Checked first so the refusal names the period.
 */
export async function livePeriodDistribution(
  tx: Tx,
  orgId: string,
  period: { readonly startsOn: string; readonly endsOn: string },
): Promise<DistributionRow | undefined> {
  const rows = await tx.execute<DistributionRow>(sql`
    select ${DISTRIBUTION_COLUMNS}
    from investors.distributions d
    where d.org_id = ${orgId} and d.period_starts_on = ${period.startsOn}::date
      and d.period_ends_on = ${period.endsOn}::date and d.status <> 'rejected'
  `);
  return rows[0];
}

export interface NewDistribution {
  readonly orgId: string;
  readonly id: string;
  readonly periodStartsOn: string;
  readonly periodEndsOn: string;
  readonly totalPoisha: bigint;
  readonly basis: 'share_bps' | 'capital';
  readonly approvalRequestId: string;
  readonly memo: string | null;
  readonly createdBy: string;
}

export async function insertDistribution(tx: Tx, input: NewDistribution): Promise<void> {
  await tx.execute(sql`
    insert into investors.distributions
      (org_id, id, period_starts_on, period_ends_on, total_poisha, basis, status,
       approval_request_id, memo, created_by)
    values (${input.orgId}, ${input.id}, ${input.periodStartsOn}::date, ${input.periodEndsOn}::date,
            ${input.totalPoisha.toString()}, ${input.basis}::investors.distribution_basis,
            'pending_approval', ${input.approvalRequestId}, ${input.memo}, ${input.createdBy})
  `);
}

export interface NewDistributionLine {
  readonly orgId: string;
  readonly distributionId: string;
  readonly investorId: string;
  readonly weight: bigint;
  readonly amountPoisha: bigint;
}

/**
 * The lines of one distribution, in one statement.
 *
 * One INSERT rather than a loop, because the deferred trigger in 0060 checks the
 * sum at commit and a partial write would be a transaction that fails for the
 * arithmetic rather than for whatever actually went wrong.
 */
export async function insertDistributionLines(
  tx: Tx,
  lines: readonly NewDistributionLine[],
): Promise<void> {
  if (lines.length === 0) return;
  const values = lines.map(
    (line) =>
      sql`(${line.orgId}, ${line.distributionId}, ${line.investorId}, ${line.weight.toString()},
           ${line.amountPoisha.toString()})`,
  );
  await tx.execute(sql`
    insert into investors.distribution_lines (org_id, distribution_id, investor_id, weight, amount_poisha)
    values ${sql.join(values, sql`, `)}
  `);
}

export interface DistributionLineRow extends Record<string, unknown> {
  readonly id: string;
  readonly distribution_id: string;
  readonly investor_id: string;
  readonly investor_code: string;
  readonly investor_name: string;
  readonly weight: string;
  readonly amount_poisha: string;
  readonly payable_account_id: string;
}

/**
 * The lines of one distribution, with each investor's payable account.
 *
 * The account is joined rather than passed in, because the posting rule needs one
 * `investor_payable` account per line and an org has exactly one — looking it up
 * per line is what keeps the rule honest if an org ever adds a second.
 */
export async function distributionLines(
  tx: Tx,
  orgId: string,
  distributionId: string,
): Promise<DistributionLineRow[]> {
  const rows = await tx.execute<DistributionLineRow>(sql`
    select l.id, l.distribution_id, l.investor_id, i.code as investor_code, i.name as investor_name,
           l.weight::text as weight, l.amount_poisha::text as amount_poisha,
           (select a.id from ledger.accounts a
             where a.org_id = l.org_id and a.subtype = 'investor_payable' and a.is_active
             order by a.code limit 1) as payable_account_id
    from investors.distribution_lines l
    join investors.investors i on i.org_id = l.org_id and i.id = l.investor_id
    where l.org_id = ${orgId} and l.distribution_id = ${distributionId}
    order by i.code
  `);
  return [...rows];
}

export interface DeclaredLineRow extends Record<string, unknown> {
  readonly distribution_id: string;
  readonly declared_on: string;
  readonly amount_poisha: string;
  readonly journal_id: string | null;
  readonly memo: string | null;
}

/**
 * One investor's declared shares inside a range of business dates, for a statement.
 *
 * Filtered on `declared_on` rather than on the period the distribution is *for*: a
 * statement is a record of what moved, and what moved is the journal, which is
 * dated the day the declaration was approved.
 */
export async function declaredLinesFor(
  tx: Tx,
  orgId: string,
  investorId: string,
  range: { readonly from: string; readonly to: string },
): Promise<DeclaredLineRow[]> {
  const rows = await tx.execute<DeclaredLineRow>(sql`
    select l.distribution_id, d.declared_on, l.amount_poisha::text as amount_poisha,
           d.journal_id, d.memo
    from investors.distribution_lines l
    join investors.distributions d on d.org_id = l.org_id and d.id = l.distribution_id
    where l.org_id = ${orgId} and l.investor_id = ${investorId} and d.status = 'declared'
      and d.declared_on between ${range.from}::date and ${range.to}::date
      and l.amount_poisha > 0
    order by d.declared_on
  `);
  return [...rows];
}

export async function settleDistribution(
  tx: Tx,
  orgId: string,
  id: string,
  outcome: {
    readonly status: 'declared' | 'rejected';
    readonly journalId: string | null;
    readonly declaredOn: string | null;
  },
): Promise<void> {
  await tx.execute(sql`
    update investors.distributions
    set status = ${outcome.status}::investors.distribution_status,
        journal_id = ${outcome.journalId}::uuid,
        declared_on = ${outcome.declaredOn}::date,
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

// --- withdrawals -------------------------------------------------------------

export interface WithdrawalRow extends Record<string, unknown> {
  readonly id: string;
  readonly investor_id: string;
  readonly investor_code: string;
  readonly investor_name: string;
  readonly kind: string;
  readonly amount_poisha: string;
  readonly status: string;
  readonly reason: string | null;
  readonly requested_by: string;
  readonly requested_at: string;
  readonly reviewed_by: string | null;
  readonly wallet_account_id: string | null;
  readonly approval_request_id: string | null;
  readonly journal_id: string | null;
  readonly paid_on: string | null;
  /** The login of the investor being paid, so nobody signs for money paid to themselves. */
  readonly investor_user_id: string | null;
}

const WITHDRAWAL_COLUMNS = sql`w.id, w.investor_id, i.code as investor_code, i.name as investor_name,
  i.user_id as investor_user_id,
  w.kind::text as kind, w.amount_poisha::text as amount_poisha, w.status::text as status, w.reason,
  w.requested_by, w.requested_at, w.reviewed_by, w.wallet_account_id, w.approval_request_id,
  w.journal_id, w.paid_on`;

export async function listWithdrawals(
  tx: Tx,
  orgId: string,
  filters: {
    readonly scope: SQL;
    readonly investorId?: string | undefined;
    readonly status?: string | undefined;
  },
): Promise<WithdrawalRow[]> {
  const rows = await tx.execute<WithdrawalRow>(sql`
    select ${WITHDRAWAL_COLUMNS}
    from investors.withdrawals w
    join investors.investors i on i.org_id = w.org_id and i.id = w.investor_id
    where w.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.investorId === undefined ? sql`true` : sql`w.investor_id = ${filters.investorId}`}
      and ${
        filters.status === undefined
          ? sql`true`
          : sql`w.status = ${filters.status}::investors.withdrawal_status`
      }
    order by w.requested_at desc
  `);
  return [...rows];
}

export async function withdrawalById(
  tx: Tx,
  orgId: string,
  id: string,
  forUpdate = false,
): Promise<WithdrawalRow | undefined> {
  const rows = await tx.execute<WithdrawalRow>(sql`
    select ${WITHDRAWAL_COLUMNS}
    from investors.withdrawals w
    join investors.investors i on i.org_id = w.org_id and i.id = w.investor_id
    where w.org_id = ${orgId} and w.id = ${id}
    ${forUpdate ? sql`for update of w` : sql``}
  `);
  return rows[0];
}

export interface NewWithdrawal {
  readonly orgId: string;
  readonly id: string;
  readonly investorId: string;
  readonly kind: 'capital' | 'profit';
  readonly amountPoisha: bigint;
  readonly reason: string | null;
  readonly requestedBy: string;
}

export async function insertWithdrawal(tx: Tx, input: NewWithdrawal): Promise<void> {
  await tx.execute(sql`
    insert into investors.withdrawals
      (org_id, id, investor_id, kind, amount_poisha, status, reason, requested_by)
    values (${input.orgId}, ${input.id}, ${input.investorId},
            ${input.kind}::investors.withdrawal_kind, ${input.amountPoisha.toString()},
            'requested', ${input.reason}, ${input.requestedBy})
  `);
}

export async function reviewWithdrawal(
  tx: Tx,
  orgId: string,
  id: string,
  input: {
    readonly reviewedBy: string;
    readonly walletAccountId: string;
    readonly approvalRequestId: string;
  },
): Promise<void> {
  await tx.execute(sql`
    update investors.withdrawals
    set status = 'reviewed',
        reviewed_by = ${input.reviewedBy},
        reviewed_at = now(),
        wallet_account_id = ${input.walletAccountId},
        approval_request_id = ${input.approvalRequestId},
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function decideWithdrawal(
  tx: Tx,
  orgId: string,
  id: string,
  status: 'approved' | 'rejected',
): Promise<void> {
  await tx.execute(sql`
    update investors.withdrawals
    set status = ${status}::investors.withdrawal_status, updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

export async function payWithdrawal(
  tx: Tx,
  orgId: string,
  id: string,
  input: { readonly journalId: string; readonly paidOn: string; readonly paidBy: string },
): Promise<void> {
  await tx.execute(sql`
    update investors.withdrawals
    set status = 'paid',
        journal_id = ${input.journalId},
        paid_on = ${input.paidOn}::date,
        paid_by = ${input.paidBy},
        updated_at = now()
    where org_id = ${orgId} and id = ${id}
  `);
}

/** A withdrawal already asking for money the position has not yet released. */
export async function openWithdrawnPoisha(
  tx: Tx,
  orgId: string,
  investorId: string,
  kind: 'capital' | 'profit',
): Promise<bigint> {
  const rows = await tx.execute<{ total: string }>(sql`
    select coalesce(sum(amount_poisha), 0)::text as total
    from investors.withdrawals
    where org_id = ${orgId} and investor_id = ${investorId}
      and kind = ${kind}::investors.withdrawal_kind
      and status in ('requested', 'reviewed', 'approved')
  `);
  return BigInt(rows[0]?.total ?? '0');
}

// --- the numbers a position is derived from ----------------------------------

export interface PositionRows {
  readonly lots: readonly { amount_poisha: string; lock_in_until: string | null }[];
  readonly capitalPaid: readonly string[];
  readonly declared: readonly string[];
  readonly profitPaid: readonly string[];
}

/**
 * Everything one investor's position is computed from, in four reads.
 *
 * Deliberately raw rows rather than four `sum()`s. `investorPosition` needs the
 * lots individually — lock-in is per contribution (§15) — and once the lots are
 * coming back one by one there is no reason to sum the rest in SQL and put the
 * arithmetic in two places. The domain adds them up (invariant 11).
 */
export async function positionRows(
  tx: Tx,
  orgId: string,
  investorId: string,
): Promise<PositionRows> {
  const lots = await tx.execute<{ amount_poisha: string; lock_in_until: string | null }>(sql`
    select amount_poisha::text as amount_poisha, lock_in_until
    from investors.investments
    where org_id = ${orgId} and investor_id = ${investorId}
  `);
  const paid = await tx.execute<{ kind: string; amount_poisha: string }>(sql`
    select kind::text as kind, amount_poisha::text as amount_poisha
    from investors.withdrawals
    where org_id = ${orgId} and investor_id = ${investorId} and status = 'paid'
  `);
  const declared = await tx.execute<{ amount_poisha: string }>(sql`
    select l.amount_poisha::text as amount_poisha
    from investors.distribution_lines l
    join investors.distributions d on d.org_id = l.org_id and d.id = l.distribution_id
    where l.org_id = ${orgId} and l.investor_id = ${investorId} and d.status = 'declared'
  `);

  return {
    lots: [...lots],
    capitalPaid: paid.filter((row) => row.kind === 'capital').map((row) => row.amount_poisha),
    declared: declared.map((row) => row.amount_poisha),
    profitPaid: paid.filter((row) => row.kind === 'profit').map((row) => row.amount_poisha),
  };
}

/**
 * The same rows for several investors at once, grouped by investor.
 *
 * The list screen needs a position per investor, and `positionRows` is four queries
 * each: twenty investors is eighty round trips for one page. These are the same
 * three reads bounded by the ids the caller may see — not by the whole org, so an
 * investor's own request does not fetch everybody else's lots on the way to
 * discarding them.
 */
export async function positionRowsFor(
  tx: Tx,
  orgId: string,
  investorIds: readonly string[],
): Promise<Map<string, PositionRows>> {
  const grouped = new Map<
    string,
    {
      lots: PositionRows['lots'][number][];
      capitalPaid: string[];
      declared: string[];
      profitPaid: string[];
    }
  >();
  for (const id of investorIds) {
    grouped.set(id, { lots: [], capitalPaid: [], declared: [], profitPaid: [] });
  }
  if (investorIds.length === 0) return new Map();

  const ids = sql.join(
    investorIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );

  const lots = await tx.execute<{
    investor_id: string;
    amount_poisha: string;
    lock_in_until: string | null;
  }>(sql`
    select investor_id, amount_poisha::text as amount_poisha, lock_in_until
    from investors.investments
    where org_id = ${orgId} and investor_id in (${ids})
  `);
  for (const row of lots) {
    grouped
      .get(row.investor_id)
      ?.lots.push({ amount_poisha: row.amount_poisha, lock_in_until: row.lock_in_until });
  }

  const paid = await tx.execute<{ investor_id: string; kind: string; amount_poisha: string }>(sql`
    select investor_id, kind::text as kind, amount_poisha::text as amount_poisha
    from investors.withdrawals
    where org_id = ${orgId} and investor_id in (${ids}) and status = 'paid'
  `);
  for (const row of paid) {
    const entry = grouped.get(row.investor_id);
    if (entry === undefined) continue;
    if (row.kind === 'capital') entry.capitalPaid.push(row.amount_poisha);
    else entry.profitPaid.push(row.amount_poisha);
  }

  const declared = await tx.execute<{ investor_id: string; amount_poisha: string }>(sql`
    select l.investor_id, l.amount_poisha::text as amount_poisha
    from investors.distribution_lines l
    join investors.distributions d on d.org_id = l.org_id and d.id = l.distribution_id
    where l.org_id = ${orgId} and l.investor_id in (${ids}) and d.status = 'declared'
  `);
  for (const row of declared) {
    grouped.get(row.investor_id)?.declared.push(row.amount_poisha);
  }

  return new Map([...grouped].map(([id, rows]) => [id, rows]));
}

/** Every active investor's agreed share and contributed capital, for a split. */
export interface ParticipantRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly share_bps: number;
  readonly capital_poisha: string;
}

/**
 * Every active investor's agreed share, and the capital they held **at the end of
 * the period being distributed**.
 *
 * `asOf` is the period's last day, not today, and the arithmetic is contributions
 * on or before it less capital returned on or before it. Three wrong answers follow
 * from the obvious "sum every contribution row" version, and all three pay real
 * money to the wrong people: a contribution made in September earns a share of
 * August's profit; an investor who has since taken all their capital back keeps
 * their full weight; and a capital return is invisible, so the weights no longer
 * describe who was funding the company while it earned that profit.
 *
 * Only `active` investors take part. An investor who has exited was settled when
 * they left, and reinstating them into a later declaration would pay them twice.
 */
export async function distributionParticipants(
  tx: Tx,
  orgId: string,
  asOf: string,
): Promise<ParticipantRow[]> {
  const rows = await tx.execute<ParticipantRow>(sql`
    select i.id, i.code, i.name, i.share_bps,
           greatest(
             coalesce((
               select sum(v.amount_poisha) from investors.investments v
               where v.org_id = i.org_id and v.investor_id = i.id
                 and v.business_date <= ${asOf}::date
             ), 0)
             - coalesce((
               select sum(w.amount_poisha) from investors.withdrawals w
               where w.org_id = i.org_id and w.investor_id = i.id
                 and w.kind = 'capital' and w.status = 'paid'
                 and w.paid_on <= ${asOf}::date
             ), 0),
             0
           )::text as capital_poisha
    from investors.investors i
    where i.org_id = ${orgId} and i.status = 'active'
    order by i.id
  `);
  return [...rows];
}

// --- documents ---------------------------------------------------------------

export interface DocumentRow extends Record<string, unknown> {
  readonly id: string;
  readonly investor_id: string;
  readonly investment_id: string | null;
  readonly kind: string;
  readonly title: string;
  readonly file_id: string;
  readonly uploaded_by: string;
  readonly created_at: string;
}

export async function listDocuments(
  tx: Tx,
  orgId: string,
  filters: { readonly scope: SQL; readonly investorId?: string | undefined },
): Promise<DocumentRow[]> {
  const rows = await tx.execute<DocumentRow>(sql`
    select o.id, o.investor_id, o.investment_id, o.kind::text as kind, o.title, o.file_id,
           o.uploaded_by, o.created_at
    from investors.documents o
    join investors.investors i on i.org_id = o.org_id and i.id = o.investor_id
    where o.org_id = ${orgId}
      and ${filters.scope}
      and ${filters.investorId === undefined ? sql`true` : sql`o.investor_id = ${filters.investorId}`}
    order by o.created_at desc
  `);
  return [...rows];
}

export interface DocumentWithOwner extends DocumentRow {
  readonly investor_user_id: string | null;
}

export async function documentById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<DocumentWithOwner | undefined> {
  const rows = await tx.execute<DocumentWithOwner>(sql`
    select o.id, o.investor_id, o.investment_id, o.kind::text as kind, o.title, o.file_id,
           o.uploaded_by, o.created_at, i.user_id as investor_user_id
    from investors.documents o
    join investors.investors i on i.org_id = o.org_id and i.id = o.investor_id
    where o.org_id = ${orgId} and o.id = ${id}
  `);
  return rows[0];
}

export interface NewDocument {
  readonly orgId: string;
  readonly investorId: string;
  readonly investmentId: string | null;
  readonly kind: 'kyc' | 'agreement' | 'other';
  readonly title: string;
  readonly fileId: string;
  readonly uploadedBy: string;
}

export async function insertDocument(tx: Tx, input: NewDocument): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into investors.documents
      (org_id, investor_id, investment_id, kind, title, file_id, uploaded_by)
    values (${input.orgId}, ${input.investorId}, ${input.investmentId}::uuid,
            ${input.kind}::investors.investor_document_kind, ${input.title}, ${input.fileId},
            ${input.uploadedBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting an investor document returned no id');
  return id;
}

/** The uploaded file behind a document, for the checks in §22 and check 3. */
export interface DocumentFileRow extends Record<string, unknown> {
  readonly status: string;
  readonly purpose: string;
  readonly visibility: string;
}

export async function documentFile(
  tx: Tx,
  orgId: string,
  fileId: string,
): Promise<DocumentFileRow | undefined> {
  const rows = await tx.execute<DocumentFileRow>(sql`
    select status::text as status, purpose, visibility::text as visibility
    from files.objects
    where org_id = ${orgId} and id = ${fileId}
  `);
  return rows[0];
}

// --- accounts the posting rules need ----------------------------------------

export interface AccountRow extends Record<string, unknown> {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly subtype: string;
  readonly branch_id: string | null;
  readonly is_active: boolean;
}

export async function accountById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<AccountRow | undefined> {
  const rows = await tx.execute<AccountRow>(sql`
    select id, code, name, subtype::text as subtype, branch_id, is_active
    from ledger.accounts
    where org_id = ${orgId} and id = ${id}
  `);
  return rows[0];
}

/**
 * The org's account of one subtype, by code.
 *
 * The chart is seeded from one template per org (D-084), so there is exactly one
 * `investor_capital`, one `investor_payable` and one `profit_distribution`. Read
 * rather than configured: a module that let a caller name the equity account it
 * posts to would let a caller post equity anywhere.
 */
export async function accountBySubtype(
  tx: Tx,
  orgId: string,
  subtype: string,
): Promise<AccountRow | undefined> {
  const rows = await tx.execute<AccountRow>(sql`
    select id, code, name, subtype::text as subtype, branch_id, is_active
    from ledger.accounts
    where org_id = ${orgId} and subtype = ${subtype}::ledger.account_subtype and is_active
    order by code
    limit 1
  `);
  return rows[0];
}

/** Which investor, if any, each of these logins is linked to (D-419). */
export async function investorsByUsers(
  tx: Tx,
  orgId: string,
  userIds: readonly string[],
): Promise<{ id: string; user_id: string }[]> {
  if (userIds.length === 0) return [];
  const rows = await tx.execute<{ id: string; user_id: string }>(sql`
    select i.id, i.user_id from investors.investors i
    where i.org_id = ${orgId} and i.user_id = any (${sql.param([...userIds])}::text[])
  `);
  return [...rows];
}

/** The org's wallet accounts, for the screens that pick one. */
export async function walletAccounts(tx: Tx, orgId: string): Promise<AccountRow[]> {
  const rows = await tx.execute<AccountRow>(sql`
    select id, code, name, subtype::text as subtype, branch_id, is_active
    from ledger.accounts
    where org_id = ${orgId} and is_active and subtype::text like 'wallet\\_%'
    order by code
  `);
  return [...rows];
}
