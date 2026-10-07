import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { CLOSED_ORDER_STATUSES, READ_ROLE, SNAPSHOT_SUBTYPES } from '@elysium/mother-shared';
import postgres, { type Sql, type TransactionSql } from 'postgres';

/**
 * Reading one brand's database (D-481, D-483, D-485).
 *
 * Through the brand's `erp_analytics` role only: SELECT on what migration 0131 opened, and
 * no write anywhere. Every read here runs inside one `read only` transaction, so a mistake
 * that tries to write fails twice over (the grant and the transaction), and inside
 * `repeatable read`, so the figures of one pull describe one moment.
 *
 * Raw parameterised SQL through postgres.js: every value is a bind parameter. The org is
 * always named — a brand database also holds its training org (D-223), and the mother
 * reads only the org whose slug is the brand's.
 *
 * Nothing in here names the mother to the brand: the connection's `application_name` is
 * `reporting`, which is what a brand's DBA would see in `pg_stat_activity`.
 */

// --- the schema version this build can read ------------------------------------------------

export interface SchemaVersion {
  readonly count: number;
  /** drizzle's hash of the latest migration's file: sha256 of its text. */
  readonly lastHash: string | null;
}

let expected: SchemaVersion | undefined;

/** `@elysium/db`'s migrations folder: in the workspace, and in the image's node_modules. */
function brandMigrationsFolder(): string {
  // Node's own resolution (not a bundler's): the package's entry, wherever it is installed.
  const entry = createRequire(import.meta.url).resolve('@elysium/db');
  return path.resolve(path.dirname(entry), '../migrations');
}

/**
 * What this build expects a brand to hold: the migrations `@elysium/db` ships with, counted
 * from its journal, and the hash of the last one, computed the way drizzle records it.
 */
export function expectedBrandSchema(): SchemaVersion {
  if (expected !== undefined) return expected;
  const folder = brandMigrationsFolder();
  const journal = JSON.parse(readFileSync(path.join(folder, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const last = journal.entries.at(-1);
  const lastHash =
    last === undefined
      ? null
      : createHash('sha256')
          .update(readFileSync(path.join(folder, `${last.tag}.sql`)).toString())
          .digest('hex');
  expected = { count: journal.entries.length, lastHash };
  return expected;
}

export function sameSchema(brand: SchemaVersion, build: SchemaVersion): boolean {
  return brand.count === build.count && brand.lastHash === build.lastHash;
}

// --- connections ------------------------------------------------------------------------

export interface BrandConnectionOptions {
  readonly connectTimeoutSeconds: number;
  readonly statementTimeoutMs: number;
}

/** Notices can echo row values; they go nowhere (invariant 10). */
const silence = (): void => undefined;

export function connectBrand(url: string, options: BrandConnectionOptions): Sql {
  return postgres(url, {
    max: 2,
    idle_timeout: 60,
    max_lifetime: 60 * 30,
    connect_timeout: options.connectTimeoutSeconds,
    onnotice: silence,
    // The brand's server only ever sees a reporting client that reads.
    connection: {
      application_name: 'reporting',
      statement_timeout: options.statementTimeoutMs,
      default_transaction_read_only: true,
    },
  });
}

/** Signed in as anything but the plain reporting role: refused as a sign-in failure. */
export class WrongRoleError extends Error {
  readonly code = 'WRONG_ROLE';
  constructor() {
    super('the brand connection is not the reporting role');
  }
}

/**
 * One read-only, consistent transaction, as `erp_analytics` and nothing stronger.
 *
 * The registry checks the connection string's user, but the server decides who the session
 * is; a role that bypasses row security or is a superuser would read zero tenant rows (no
 * org set) or everything, either way a misread, so it is refused before any read.
 */
export async function readOnly<T>(sql: Sql, work: (tx: TransactionSql) => Promise<T>): Promise<T> {
  return (await sql.begin('isolation level repeatable read read only', async (tx) => {
    const [role] = await tx<{ name: string; is_super: boolean; bypasses: boolean }[]>`
      select r.rolname as name, r.rolsuper as is_super, r.rolbypassrls as bypasses
      from pg_roles r where r.rolname = current_user
    `;
    if (role?.name !== READ_ROLE || role.is_super || role.bypasses) throw new WrongRoleError();
    return work(tx);
  })) as T;
}

// --- what the brand is ----------------------------------------------------------------

export async function readVersion(tx: TransactionSql): Promise<SchemaVersion> {
  const [row] = await tx<{ count: number; last_hash: string | null }[]>`
    select count(*)::int as count,
           (select hash from drizzle.__drizzle_migrations
            order by created_at desc, id desc limit 1) as last_hash
    from drizzle.__drizzle_migrations
  `;
  return { count: row?.count ?? 0, lastHash: row?.last_hash ?? null };
}

export interface BrandOrg {
  readonly id: string;
  readonly displayName: string;
  readonly isTraining: boolean;
  readonly isActive: boolean;
}

export async function readOrg(tx: TransactionSql, slug: string): Promise<BrandOrg | undefined> {
  const [row] = await tx<
    { id: string; display_name: string; is_training: boolean; is_active: boolean }[]
  >`
    select id::text as id, display_name, is_training, is_active
    from org.organizations where slug = ${slug}
  `;
  return row === undefined
    ? undefined
    : {
        id: row.id,
        displayName: row.display_name,
        isTraining: row.is_training,
        isActive: row.is_active,
      };
}

// --- the rollups (D-484) ----------------------------------------------------------------

export interface DailyRow {
  readonly business_date: string;
  readonly orders_placed: number;
  readonly orders_confirmed: number;
  readonly orders_delivered: number;
  readonly orders_returned: number;
  readonly orders_cancelled: number;
  readonly delivered_revenue_poisha: string;
  readonly gross_profit_poisha: string;
  readonly delivered_outside_dhaka: number;
  readonly returned_outside_dhaka: number;
}

export interface OrgDailyRow extends DailyRow {
  readonly spend_poisha: string;
  readonly pickup_count: number;
  readonly pickup_seconds: string;
  readonly computed_at: Date | null;
}

export interface ChannelDailyRow extends DailyRow {
  readonly channel: string;
}

export interface CampaignDailyRow {
  readonly business_date: string;
  readonly campaign_id: string | null;
  readonly campaign_name: string | null;
  readonly spend_poisha: string;
  readonly orders_confirmed: number;
  readonly orders_delivered: number;
  readonly orders_returned: number;
  readonly delivered_revenue_poisha: string;
  readonly placed_revenue_poisha: string;
}

export interface LedgerFlowDbRow {
  readonly business_date: string;
  readonly subtype: string;
  readonly account_class: 'income' | 'expense';
  readonly debit_poisha: string;
  readonly credit_poisha: string;
}

export interface Rollups {
  readonly org: readonly OrgDailyRow[];
  readonly channel: readonly ChannelDailyRow[];
  readonly campaign: readonly CampaignDailyRow[];
  readonly ledger: readonly LedgerFlowDbRow[];
}

export async function readRollups(
  tx: TransactionSql,
  orgId: string,
  range: { readonly from: string; readonly to: string },
): Promise<Rollups> {
  const org = await tx<OrgDailyRow[]>`
    select business_date::text as business_date,
           orders_placed, orders_confirmed, orders_delivered, orders_returned, orders_cancelled,
           delivered_revenue_poisha::text as delivered_revenue_poisha,
           gross_profit_poisha::text as gross_profit_poisha,
           delivered_outside_dhaka, returned_outside_dhaka,
           spend_poisha::text as spend_poisha, pickup_count,
           pickup_seconds::text as pickup_seconds, computed_at
    from analytics.daily_org
    where org_id = ${orgId}
      and business_date between ${range.from}::date and ${range.to}::date
    order by business_date
  `;
  const channel = await tx<ChannelDailyRow[]>`
    select business_date::text as business_date, channel,
           orders_placed, orders_confirmed, orders_delivered, orders_returned, orders_cancelled,
           delivered_revenue_poisha::text as delivered_revenue_poisha,
           gross_profit_poisha::text as gross_profit_poisha,
           delivered_outside_dhaka, returned_outside_dhaka
    from analytics.daily_channel
    where org_id = ${orgId}
      and business_date between ${range.from}::date and ${range.to}::date
    order by business_date, channel
  `;
  const campaign = await tx<CampaignDailyRow[]>`
    select d.business_date::text as business_date, d.campaign_id::text as campaign_id,
           c.name as campaign_name,
           d.spend_poisha::text as spend_poisha, d.orders_confirmed, d.orders_delivered,
           d.orders_returned,
           d.delivered_revenue_poisha::text as delivered_revenue_poisha,
           d.placed_revenue_poisha::text as placed_revenue_poisha
    from analytics.daily_campaign d
    left join marketing.campaigns c on c.org_id = d.org_id and c.id = d.campaign_id
    where d.org_id = ${orgId}
      and d.business_date between ${range.from}::date and ${range.to}::date
    order by d.business_date, d.campaign_id nulls last
  `;
  const ledger = await tx<LedgerFlowDbRow[]>`
    select j.business_date::text as business_date, a.subtype::text as subtype,
           a.class::text as account_class,
           sum(l.debit_poisha)::text as debit_poisha, sum(l.credit_poisha)::text as credit_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and j.business_date between ${range.from}::date and ${range.to}::date
      and a.class::text in ('income', 'expense')
    group by j.business_date, a.subtype, a.class
    order by 1, 3, 2
  `;
  return { org, channel, campaign, ledger };
}

/** The first day the brand has a rollup for, so a full pull knows where to start. */
export async function firstRollupDay(tx: TransactionSql, orgId: string): Promise<string | null> {
  const [row] = await tx<{ first: string | null }[]>`
    select least(
      (select min(business_date) from analytics.daily_org where org_id = ${orgId}),
      (select min(business_date) from ledger.journals where org_id = ${orgId})
    )::text as first
  `;
  return row?.first ?? null;
}

// --- the snapshot (D-485) --------------------------------------------------------------

export interface SnapshotDbRows {
  readonly balances: readonly {
    readonly subtype: string;
    readonly normal_balance: 'debit' | 'credit';
    readonly debit_poisha: string;
    readonly credit_poisha: string;
  }[];
  readonly openOrders: readonly { readonly status: string; readonly count: number }[];
  readonly staffHeadcount: number;
  readonly activeSkus: number;
  readonly lowStockSkus: number;
}

export async function readSnapshot(
  tx: TransactionSql,
  orgId: string,
  asOf: string,
): Promise<SnapshotDbRows> {
  const balances = await tx<SnapshotDbRows['balances'][number][]>`
    select a.subtype::text as subtype, a.normal_balance::text as normal_balance,
           sum(l.debit_poisha)::text as debit_poisha, sum(l.credit_poisha)::text as credit_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    where l.org_id = ${orgId}
      and j.business_date <= ${asOf}::date
      and a.subtype::text = any(${[...SNAPSHOT_SUBTYPES]}::text[])
    group by a.subtype, a.normal_balance
  `;
  const openOrders = await tx<{ status: string; count: number }[]>`
    select status::text as status, count(*)::int as count
    from sales.orders
    where org_id = ${orgId} and status::text <> all(${[...CLOSED_ORDER_STATUSES]}::text[])
    group by status
    order by status
  `;
  const [counts] = await tx<{ staff: number; skus: number; low: number }[]>`
    select
      (select count(*)::int from hr.employees
        where org_id = ${orgId} and status::text = 'active') as staff,
      (select count(*)::int from catalog.skus
        where org_id = ${orgId} and status::text = 'active') as skus,
      (select count(distinct sl.sku_id)::int
         from inventory.stock_levels sl
         join catalog.skus s on s.org_id = sl.org_id and s.id = sl.sku_id
        where sl.org_id = ${orgId} and s.status::text = 'active'
          and sl.reorder_level > 0 and sl.on_hand - sl.reserved <= sl.reorder_level) as low
  `;
  return {
    balances,
    openOrders,
    staffHeadcount: counts?.staff ?? 0,
    activeSkus: counts?.skus ?? 0,
    lowStockSkus: counts?.low ?? 0,
  };
}

// --- the live lists on a brand's page ------------------------------------------------------

export interface LiveRows {
  readonly latestOrders: readonly {
    readonly order_no: string;
    readonly status: string;
    readonly channel: string;
    readonly created_at: Date;
    readonly total_poisha: string;
  }[];
  readonly topProducts: readonly {
    readonly sku_code: string;
    readonly product_name: string;
    readonly units: number;
  }[];
  readonly lowStock: readonly {
    readonly sku_code: string;
    readonly product_name: string;
    readonly location: string;
    readonly available: number;
    readonly reorder_level: number;
  }[];
  readonly wallets: readonly {
    readonly code: string;
    readonly name: string;
    readonly subtype: string;
    readonly balance_poisha: string;
  }[];
  readonly courierCod: readonly { readonly courier: string | null; readonly held_poisha: string }[];
  readonly staffHeadcount: number;
  readonly staff: readonly {
    readonly code: string;
    readonly full_name: string;
    readonly designation: string | null;
    readonly branch: string | null;
    readonly status: string;
  }[];
}

/** What a brand's page lists, read when the page opens. `from` bounds "top products". */
export async function readLive(
  tx: TransactionSql,
  orgId: string,
  window: { readonly from: string; readonly asOf: string },
): Promise<LiveRows> {
  const latestOrders = await tx<LiveRows['latestOrders'][number][]>`
    select order_no, status::text as status, channel::text as channel, created_at,
           (items_poisha - discount_poisha + delivery_charge_poisha)::text as total_poisha
    from sales.orders
    where org_id = ${orgId}
    order by created_at desc, order_no desc
    limit 15
  `;
  const topProducts = await tx<LiveRows['topProducts'][number][]>`
    select l.sku_code, min(l.product_name) as product_name, sum(l.delivered_qty)::int as units
    from sales.order_lines l
    join sales.orders o on o.org_id = l.org_id and o.id = l.order_id
    where l.org_id = ${orgId}
      and l.delivered_qty > 0
      and o.delivered_at >= (${window.from}::date::timestamp at time zone 'Asia/Dhaka')
      and o.delivered_at < ((${window.asOf}::date + 1)::timestamp at time zone 'Asia/Dhaka')
    group by l.sku_id, l.sku_code
    order by units desc, l.sku_code
    limit 10
  `;
  const lowStock = await tx<LiveRows['lowStock'][number][]>`
    select s.code as sku_code, p.name as product_name,
           coalesce(loc.name, loc.code, '') as location,
           (sl.on_hand - sl.reserved)::int as available, sl.reorder_level
    from inventory.stock_levels sl
    join catalog.skus s on s.org_id = sl.org_id and s.id = sl.sku_id
    join catalog.products p on p.org_id = s.org_id and p.id = s.product_id
    left join org.locations loc on loc.org_id = sl.org_id and loc.id = sl.location_id
    where sl.org_id = ${orgId} and s.status::text = 'active'
      and sl.reorder_level > 0 and sl.on_hand - sl.reserved <= sl.reorder_level
    order by (sl.on_hand - sl.reserved) - sl.reorder_level, s.code
    limit 25
  `;
  const wallets = await tx<LiveRows['wallets'][number][]>`
    select a.code, a.name, a.subtype::text as subtype,
           coalesce((
             select sum(l.debit_poisha) - sum(l.credit_poisha)
             from ledger.journal_lines l
             join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
             where l.org_id = a.org_id and l.account_id = a.id
               and j.business_date <= ${window.asOf}::date
           ), 0)::text as balance_poisha
    from ledger.accounts a
    where a.org_id = ${orgId} and a.subtype::text like 'wallet\\_%'
    order by a.code
  `;
  const courierCod = await tx<LiveRows['courierCod'][number][]>`
    select c.name as courier,
           (sum(l.debit_poisha) - sum(l.credit_poisha))::text as held_poisha
    from ledger.journal_lines l
    join ledger.journals j on j.org_id = l.org_id and j.id = l.journal_id
    join ledger.accounts a on a.org_id = l.org_id and a.id = l.account_id
    left join sales.couriers c on c.org_id = l.org_id and c.id = l.party_id
    where l.org_id = ${orgId} and a.subtype::text = 'courier_receivable'
      and j.business_date <= ${window.asOf}::date
    group by c.id, c.name
    having sum(l.debit_poisha) - sum(l.credit_poisha) <> 0
    order by sum(l.debit_poisha) - sum(l.credit_poisha) desc
  `;
  const [headcount] = await tx<{ count: number }[]>`
    select count(*)::int as count from hr.employees
    where org_id = ${orgId} and status::text = 'active'
  `;
  const staff = await tx<LiveRows['staff'][number][]>`
    select e.code, e.full_name, e.designation, b.name as branch, e.status::text as status
    from hr.employees e
    left join org.branches b on b.org_id = e.org_id and b.id = e.branch_id
    where e.org_id = ${orgId} and e.status::text in ('active', 'suspended')
    order by e.full_name, e.code
    limit 100
  `;
  return {
    latestOrders,
    topProducts,
    lowStock,
    wallets,
    courierCod,
    staffHeadcount: headcount?.count ?? 0,
    staff,
  };
}

// --- what went wrong, as a code (D-486) ------------------------------------------------------

export type BrandErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'auth_failed'
  | 'database_missing'
  | 'permission_denied'
  | 'version_mismatch'
  | 'brand_not_found'
  | 'training_org'
  | 'secrets_key'
  | 'read_failed';

/**
 * A failure as a short code, never as the driver's message: a connection error can quote
 * the host and user, and a query error the values it was given. The screens and the audit
 * log carry the code only.
 */
export function classifyBrandError(error: unknown): BrandErrorCode {
  const record = (error ?? {}) as { code?: unknown; errno?: unknown; message?: unknown };
  const code = typeof record.code === 'string' ? record.code : '';
  const message = typeof record.message === 'string' ? record.message : '';
  if (code === 'SECRETS_KEY_INVALID') return 'secrets_key';
  if (code === 'WRONG_ROLE') return 'auth_failed';
  if (code === '28P01' || code === '28000') return 'auth_failed';
  if (code === '3D000') return 'database_missing';
  if (code === '42501' || code === '42P01' || code === '3F000') return 'permission_denied';
  if (code === '57014' || code === 'CONNECT_TIMEOUT' || /timeout/i.test(message)) return 'timeout';
  if (
    ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(
      code,
    ) ||
    code === 'CONNECTION_CLOSED' ||
    code === 'CONNECTION_ENDED' ||
    code === 'CONNECTION_DESTROYED'
  ) {
    return 'unreachable';
  }
  return 'read_failed';
}
