import type { Tx } from '@elysium/db';
import { sql, type SQL } from 'drizzle-orm';

/**
 * The SQL behind advances and return reasons (M17, D-230 to D-234).
 *
 * Only `sales.*`, `org.settings` and `ledger.accounts` (to name a wallet), which is the
 * orders module's existing reach (`module-boundaries.test.ts`). Every status move is a
 * conditional UPDATE on the status it expects, so two people deciding one claim at once
 * get one success and one refusal, and migration 0088's trigger is the floor under both.
 */

export interface AdvanceRow extends Record<string, unknown> {
  readonly id: string;
  readonly order_id: string;
  readonly method: string;
  readonly transaction_ref: string;
  readonly amount_poisha: string;
  readonly applied_poisha: string;
  readonly status: string;
  readonly note: string | null;
  readonly recorded_by: string;
  readonly recorded_at: string;
  readonly decided_by: string | null;
  readonly decided_at: string | null;
  readonly reject_reason: string | null;
  readonly wallet_account_id: string | null;
  readonly received_journal_id: string | null;
  readonly kept_poisha: string;
  readonly kept_journal_id: string | null;
  readonly settled_by: string | null;
  readonly settled_at: string | null;
  readonly refund_journal_id: string | null;
  readonly refund_wallet_account_id: string | null;
  readonly refund_ref: string | null;
  readonly void_journal_id: string | null;
  readonly void_reason: string | null;
  readonly voided_at: string | null;
}

const ADVANCE_COLUMNS = sql`a.id, a.order_id, a.method, a.transaction_ref,
  a.amount_poisha::text as amount_poisha, a.applied_poisha::text as applied_poisha, a.status,
  a.note, a.recorded_by, a.recorded_at, a.decided_by, a.decided_at, a.reject_reason,
  a.wallet_account_id, a.received_journal_id, a.kept_poisha::text as kept_poisha,
  a.kept_journal_id, a.settled_by, a.settled_at, a.refund_journal_id,
  a.refund_wallet_account_id, a.refund_ref, a.void_journal_id, a.void_reason, a.voided_at`;

export async function insertClaim(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly method: string;
    readonly transactionRef: string;
    readonly amountPoisha: bigint;
    readonly note: string | null;
    readonly recordedBy: string;
  },
): Promise<string> {
  const rows = await tx.execute<{ id: string }>(sql`
    insert into sales.order_advances
      (org_id, order_id, method, transaction_ref, amount_poisha, note, recorded_by)
    values (${input.orgId}, ${input.orderId}, ${input.method}, ${input.transactionRef},
            ${input.amountPoisha.toString()}::bigint, ${input.note}, ${input.recordedBy})
    returning id
  `);
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('inserting an advance claim returned no id');
  return id;
}

/**
 * A live claim on this reference, if there is one: anything but a rejected or voided one.
 * Whatever method it was typed under: one payment is one payment.
 */
export async function liveClaimFor(
  tx: Tx,
  orgId: string,
  transactionRef: string,
): Promise<{ id: string } | undefined> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from sales.order_advances
    where org_id = ${orgId} and transaction_ref = ${transactionRef}
      and status not in ('rejected', 'voided')
    limit 1
  `);
  return rows[0];
}

/** An order's advances, oldest first (the order the buyer paid in). */
export async function advancesOfOrder(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<AdvanceRow[]> {
  return tx.execute<AdvanceRow>(sql`
    select ${ADVANCE_COLUMNS} from sales.order_advances a
    where a.org_id = ${orgId} and a.order_id = ${orderId}
    order by a.recorded_at, a.id
  `);
}

/** The order's held advances, locked, oldest first: what a delivery or an ending acts on. */
export async function lockHeldAdvances(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<AdvanceRow[]> {
  return tx.execute<AdvanceRow>(sql`
    select ${ADVANCE_COLUMNS} from sales.order_advances a
    where a.org_id = ${orgId} and a.order_id = ${orderId} and a.status = 'verified'
    order by a.recorded_at, a.id
    for update
  `);
}

export async function lockAdvance(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<AdvanceRow | undefined> {
  const rows = await tx.execute<AdvanceRow>(sql`
    select ${ADVANCE_COLUMNS} from sales.order_advances a
    where a.org_id = ${orgId} and a.id = ${id}
    for update
  `);
  return rows[0];
}

export async function advanceById(
  tx: Tx,
  orgId: string,
  id: string,
): Promise<AdvanceRow | undefined> {
  const rows = await tx.execute<AdvanceRow>(sql`
    select ${ADVANCE_COLUMNS} from sales.order_advances a
    where a.org_id = ${orgId} and a.id = ${id}
  `);
  return rows[0];
}

export interface QueueRow extends AdvanceRow {
  readonly order_no: string;
  readonly order_status: string;
  readonly order_branch_id: string | null;
  readonly cod_amount_poisha: string;
  readonly wallet_name: string | null;
}

/** The accounts queue (D-235): claims in these statuses, oldest first, in the caller's scope. */
export async function advanceQueue(
  tx: Tx,
  orgId: string,
  statuses: readonly string[],
  scope: SQL,
): Promise<QueueRow[]> {
  return tx.execute<QueueRow>(sql`
    select ${ADVANCE_COLUMNS}, o.order_no, o.status::text as order_status,
           o.branch_id as order_branch_id, o.cod_amount_poisha::text as cod_amount_poisha,
           w.name as wallet_name
    from sales.order_advances a
    join sales.orders o on o.org_id = a.org_id and o.id = a.order_id
    left join ledger.accounts w on w.org_id = a.org_id and w.id = a.wallet_account_id
    where a.org_id = ${orgId}
      and a.status in (${sql.join(
        statuses.map((status) => sql`${status}`),
        sql`, `,
      )})
      and ${scope}
    order by a.recorded_at, a.id
    limit 500
  `);
}

/** pending → verified, once, by somebody other than the recorder (the CHECK says so too). */
export async function markVerified(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly decidedBy: string;
    readonly walletAccountId: string;
    readonly journalId: string;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.order_advances set
      status = 'verified', decided_by = ${input.decidedBy}, decided_at = now(),
      wallet_account_id = ${input.walletAccountId}, received_journal_id = ${input.journalId},
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and status = 'pending'
    returning id
  `);
  return rows.length > 0;
}

export async function markRejected(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly decidedBy: string;
    readonly reason: string;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.order_advances set
      status = 'rejected', decided_by = ${input.decidedBy}, decided_at = now(),
      reject_reason = ${input.reason}, updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and status = 'pending'
    returning id
  `);
  return rows.length > 0;
}

/** A delivery used `appliedPoisha` more of a held advance; all of it makes it `applied`. */
export async function addApplied(
  tx: Tx,
  input: { readonly orgId: string; readonly id: string; readonly appliedPoisha: bigint },
): Promise<boolean> {
  const amount = input.appliedPoisha.toString();
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.order_advances set
      applied_poisha = applied_poisha + ${amount}::bigint,
      status = case when applied_poisha + ${amount}::bigint = amount_poisha
                    then 'applied' else 'verified' end,
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and status = 'verified'
      and applied_poisha + ${amount}::bigint <= amount_poisha
    returning id
  `);
  return rows.length > 0;
}

/**
 * verified → refund_due (D-232): something is owed back, still a liability with no refund
 * journal yet. The part the brand kept, if any, is recorded with the journal that kept it.
 */
export async function markRefundDue(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly keptPoisha: bigint;
    readonly keptJournalId: string | null;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.order_advances set
      status = 'refund_due', kept_poisha = ${input.keptPoisha.toString()}::bigint,
      kept_journal_id = ${input.keptJournalId}, updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and status = 'verified'
    returning id
  `);
  return rows.length > 0;
}

/** verified → forfeited: all of what was left kept, with the journal that made it income. */
export async function markForfeited(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly keptPoisha: bigint;
    readonly keptJournalId: string;
    readonly settledBy: string;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.order_advances set
      status = 'forfeited', kept_poisha = ${input.keptPoisha.toString()}::bigint,
      kept_journal_id = ${input.keptJournalId}, settled_by = ${input.settledBy},
      settled_at = now(), updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and status = 'verified'
    returning id
  `);
  return rows.length > 0;
}

/** refund_due → refunded, with the journal and the wallet the money went out of. */
export async function markRefunded(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly settledBy: string;
    readonly journalId: string;
    readonly walletAccountId: string;
    readonly refundRef: string | null;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.order_advances set
      status = 'refunded', settled_by = ${input.settledBy}, settled_at = now(),
      refund_journal_id = ${input.journalId},
      refund_wallet_account_id = ${input.walletAccountId}, refund_ref = ${input.refundRef},
      updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and status = 'refund_due'
    returning id
  `);
  return rows.length > 0;
}

/** verified → voided (D-236): the verification undone, with its reversal journal. */
export async function markVoided(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly id: string;
    readonly voidedBy: string;
    readonly reason: string;
    readonly journalId: string;
  },
): Promise<boolean> {
  const rows = await tx.execute<{ id: string }>(sql`
    update sales.order_advances set
      status = 'voided', void_journal_id = ${input.journalId}, void_reason = ${input.reason},
      voided_by = ${input.voidedBy}, voided_at = now(), updated_at = now()
    where org_id = ${input.orgId} and id = ${input.id} and status = 'verified'
      and applied_poisha = 0
    returning id
  `);
  return rows.length > 0;
}

/**
 * The most a brand may still keep of this order's advances (D-232): the delivery charge, less
 * what its advances already kept, and nothing at all once any unit was delivered (the
 * delivery journal earned the charge).
 */
export async function keepCap(tx: Tx, orgId: string, orderId: string): Promise<bigint> {
  const rows = await tx.execute<{ cap: string }>(sql`
    select greatest(
      case when exists (
             select 1 from sales.order_lines l
             where l.org_id = o.org_id and l.order_id = o.id and l.delivered_qty > 0
           ) then 0
           else o.delivery_charge_poisha end
      - coalesce((select sum(a.kept_poisha) from sales.order_advances a
                  where a.org_id = o.org_id and a.order_id = o.id), 0),
      0)::text as cap
    from sales.orders o
    where o.org_id = ${orgId} and o.id = ${orderId}
  `);
  return BigInt(rows[0]?.cap ?? '0');
}

/** A brand's advance policy keys (D-232); null when unset. */
export async function advancePolicySettings(
  tx: Tx,
  orgId: string,
): Promise<{ onCancel: unknown; onReturn: unknown }> {
  const rows = await tx.execute<{ key: string; value: unknown }>(sql`
    select key, value from org.settings
    where org_id = ${orgId} and key in ('orders.advance_on_cancel', 'orders.advance_on_return')
  `);
  const of = (key: string) => rows.find((row) => row.key === key)?.value ?? null;
  return { onCancel: of('orders.advance_on_cancel'), onReturn: of('orders.advance_on_return') };
}

// --- return reasons ----------------------------------------------------------------

export async function insertReturnReason(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly orderId: string;
    readonly kind: 'return' | 'exchange';
    readonly reasonCode: string;
    readonly note: string | null;
    readonly businessDate: string;
    readonly recordedBy: string;
  },
): Promise<void> {
  await tx.execute(sql`
    insert into sales.order_returns
      (org_id, order_id, kind, reason_code, note, business_date, recorded_by)
    values (${input.orgId}, ${input.orderId}, ${input.kind}, ${input.reasonCode}, ${input.note},
            ${input.businessDate}::date, ${input.recordedBy})
  `);
}

export async function returnReasonOf(
  tx: Tx,
  orgId: string,
  orderId: string,
): Promise<{ kind: string; reason_code: string; note: string | null } | undefined> {
  const rows = await tx.execute<{ kind: string; reason_code: string; note: string | null }>(sql`
    select kind, reason_code, note from sales.order_returns
    where org_id = ${orgId} and order_id = ${orderId}
  `);
  return rows[0];
}

/** Recorded returns per reason and kind, over business dates, in the caller's order scope. */
export async function returnReasonCounts(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly from: string;
    readonly to: string;
    readonly scope: SQL;
  },
): Promise<{ reason_code: string; kind: string; count: number }[]> {
  return tx.execute<{ reason_code: string; kind: string; count: number }>(sql`
    select r.reason_code, r.kind, count(*)::int as count
    from sales.order_returns r
    join sales.orders o on o.org_id = r.org_id and o.id = r.order_id
    where r.org_id = ${input.orgId}
      and r.business_date between ${input.from}::date and ${input.to}::date
      and ${input.scope}
    group by r.reason_code, r.kind
  `);
}
