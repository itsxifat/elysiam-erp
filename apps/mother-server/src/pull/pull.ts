import { addDays, businessDate, type IsoDate } from '@elysium/domain';
import { snapshotMoneyFrom } from '@elysium/mother-shared';
import type { Logger } from 'pino';
import type { TransactionSql } from 'postgres';

import type { BrandPools } from '../brands/pools.js';
import {
  classifyBrandError,
  expectedBrandSchema,
  firstRollupDay,
  readOnly,
  readOrg,
  readRollups,
  readSnapshot,
  readVersion,
  sameSchema,
  type BrandErrorCode,
  type Rollups,
  type SchemaVersion,
  type SnapshotDbRows,
} from '../brands/reader.js';
import { findBrand, type BrandRow } from '../brands/registry.js';
import { inMother, motherSql } from '../db/client.js';

/**
 * Pulling one brand's figures into the mother (D-484, D-485, D-486).
 *
 * Two halves, never interleaved (invariant 6's spirit: no network inside a transaction):
 *
 * 1. **Read** the brand, in one read-only, repeatable-read transaction on its database:
 *    check its schema version first and stop on a mismatch; find its org by slug; read the
 *    rollups for the window, the income and expense flows, and the snapshot positions.
 * 2. **Write** the mother, in one transaction on its own database: delete the window's rows
 *    and insert what was read (a replace, as the brand's own rollup job does), add the
 *    snapshot, and mark the brand's figures as of now.
 *
 * A brand that cannot be read keeps the figures it had, with their age, and records a short
 * error code; the other brands are pulled independently (D-486).
 */

export type PullTrigger = 'schedule' | 'nightly' | 'owner' | 'first';

export interface PullOptions {
  readonly trigger: PullTrigger;
  /** Every day the brand has, rather than the recent window. */
  readonly full: boolean;
}

export type PullOutcome =
  | { readonly status: 'ok'; readonly from: string; readonly to: string; readonly days: number }
  | { readonly status: 'version_mismatch'; readonly brand: SchemaVersion | null }
  | { readonly status: 'failed'; readonly code: BrandErrorCode }
  | { readonly status: 'skipped'; readonly reason: 'not_found' | 'inactive' };

type ReadResult =
  | { readonly kind: 'mismatch'; readonly version: SchemaVersion | null }
  | { readonly kind: 'error'; readonly code: BrandErrorCode }
  | {
      readonly kind: 'ok';
      readonly version: SchemaVersion;
      readonly orgId: string;
      readonly from: IsoDate;
      readonly to: IsoDate;
      readonly rollups: Rollups;
      readonly snapshot: SnapshotDbRows;
    };

const ROWS_PER_INSERT = 500;

function chunks<T>(rows: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let start = 0; start < rows.length; start += ROWS_PER_INSERT) {
    out.push(rows.slice(start, start + ROWS_PER_INSERT));
  }
  return out;
}

function isPermissionError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === '42501' || code === '42P01' || code === '3F000';
}

export class PullService {
  constructor(
    private readonly pools: BrandPools,
    private readonly windowDays: number,
    private readonly logger: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async pull(brandId: string, options: PullOptions): Promise<PullOutcome> {
    const brand = await findBrand(brandId);
    if (brand === undefined) return { status: 'skipped', reason: 'not_found' };
    if (!brand.is_active) return { status: 'skipped', reason: 'inactive' };

    const full = options.full || brand.figures_at === null;
    const [run] = await motherSql()<{ id: string }[]>`
      insert into mother.pull_runs (brand_id, trigger, is_full)
      values (${brand.id}, ${options.trigger}, ${full})
      returning id
    `;
    const runId = run?.id ?? '';
    await motherSql()`update mother.brands set last_attempt_at = now() where id = ${brand.id}`;

    let result: ReadResult;
    try {
      result = await this.read(brand, full);
    } catch (error) {
      result = { kind: 'error', code: classifyBrandError(error) };
    }

    if (result.kind === 'mismatch') {
      await this.recordFailure(brand, runId, 'version_mismatch', result.version);
      this.logger.warn(
        { brand: brand.slug, brandMigrations: result.version?.count ?? null },
        'brand schema version does not match this build; not read',
      );
      return { status: 'version_mismatch', brand: result.version };
    }
    if (result.kind === 'error') {
      await this.recordFailure(brand, runId, result.code, null);
      this.logger.warn({ brand: brand.slug, code: result.code }, 'brand pull failed');
      return { status: 'failed', code: result.code };
    }

    const days = await this.write(brand, runId, result);
    this.logger.info(
      { brand: brand.slug, from: result.from, to: result.to, days, trigger: options.trigger },
      'brand pulled',
    );
    return { status: 'ok', from: result.from, to: result.to, days };
  }

  private async read(brand: BrandRow, full: boolean): Promise<ReadResult> {
    const sql = this.pools.for(brand);
    const expected = expectedBrandSchema();
    const today = businessDate(this.clock());
    return readOnly(sql, async (tx) => {
      let version: SchemaVersion;
      try {
        version = await readVersion(tx);
      } catch (error) {
        // A database too old to let this role see its version is one this build cannot read.
        if (isPermissionError(error)) return { kind: 'mismatch', version: null };
        throw error;
      }
      if (!sameSchema(version, expected)) return { kind: 'mismatch', version };

      const org = await readOrg(tx, brand.slug);
      if (org === undefined) return { kind: 'error', code: 'brand_not_found' };
      if (org.isTraining) return { kind: 'error', code: 'training_org' };

      const from = full
        ? (((await firstRollupDay(tx, org.id)) as IsoDate | null) ?? today)
        : addDays(today, -(this.windowDays - 1));
      const start = from > today ? today : from;
      const rollups = await readRollups(tx, org.id, { from: start, to: today });
      const snapshot = await readSnapshot(tx, org.id, today);
      return { kind: 'ok', version, orgId: org.id, from: start, to: today, rollups, snapshot };
    });
  }

  private async write(
    brand: BrandRow,
    runId: string,
    read: Extract<ReadResult, { kind: 'ok' }>,
  ): Promise<number> {
    const pulledAt = this.clock();
    const money = snapshotMoneyFrom(
      read.snapshot.balances.map((row) => ({
        subtype: row.subtype,
        normalBalance: row.normal_balance,
        debitPoisha: BigInt(row.debit_poisha),
        creditPoisha: BigInt(row.credit_poisha),
      })),
    );
    const openOrders = Object.fromEntries(
      read.snapshot.openOrders.map((row) => [row.status, row.count]),
    );

    return inMother(async (tx) => {
      await this.replaceWindow(tx, brand.id, read, pulledAt);
      await tx`
        insert into mother.brand_snapshots
          (brand_id, taken_at, as_of, cash_hand_poisha, cash_bank_poisha, cash_bkash_poisha,
           cash_mfs_other_poisha, stock_value_poisha, goods_in_transit_poisha, cod_held_poisha,
           supplier_payables_poisha, receivables_poisha, open_orders, staff_headcount,
           active_skus, low_stock_skus)
        values
          (${brand.id}, ${pulledAt}, ${read.to},
           ${money.cashByKind.wallet_cash.toString()}, ${money.cashByKind.wallet_bank.toString()},
           ${money.cashByKind.wallet_bkash.toString()},
           ${money.cashByKind.wallet_mfs_other.toString()},
           ${money.stockValuePoisha.toString()}, ${money.goodsInTransitPoisha.toString()},
           ${money.codHeldPoisha.toString()}, ${money.supplierPayablesPoisha.toString()},
           ${money.receivablesPoisha.toString()}, ${tx.json(openOrders)},
           ${read.snapshot.staffHeadcount}, ${read.snapshot.activeSkus},
           ${read.snapshot.lowStockSkus})
      `;
      await tx`
        update mother.brands set
          brand_org_id = ${read.orgId},
          schema_status = 'ok',
          brand_migrations = ${read.version.count},
          figures_at = ${pulledAt},
          last_error_code = null,
          last_error_at = null,
          updated_at = now()
        where id = ${brand.id}
      `;
      await tx`
        update mother.pull_runs set
          status = 'ok', finished_at = now(), from_date = ${read.from}, to_date = ${read.to},
          days = ${read.rollups.org.length}
        where id = ${runId}
      `;
      return read.rollups.org.length;
    });
  }

  /** Delete the window's rows for the brand, then insert what was read: a replace. */
  private async replaceWindow(
    tx: TransactionSql,
    brandId: string,
    read: Extract<ReadResult, { kind: 'ok' }>,
    pulledAt: Date,
  ): Promise<void> {
    for (const table of [
      'brand_daily',
      'brand_daily_channel',
      'brand_daily_campaign',
      'brand_daily_ledger',
    ] as const) {
      await tx`
        delete from ${tx(`mother.${table}`)}
        where brand_id = ${brandId}
          and business_date between ${read.from}::date and ${read.to}::date
      `;
    }

    const daily = read.rollups.org.map((row) => ({
      brand_id: brandId,
      business_date: row.business_date,
      orders_placed: row.orders_placed,
      orders_confirmed: row.orders_confirmed,
      orders_delivered: row.orders_delivered,
      orders_returned: row.orders_returned,
      orders_cancelled: row.orders_cancelled,
      delivered_revenue_poisha: row.delivered_revenue_poisha,
      gross_profit_poisha: row.gross_profit_poisha,
      delivered_outside_dhaka: row.delivered_outside_dhaka,
      returned_outside_dhaka: row.returned_outside_dhaka,
      spend_poisha: row.spend_poisha,
      pickup_count: row.pickup_count,
      pickup_seconds: row.pickup_seconds,
      computed_at: row.computed_at,
      pulled_at: pulledAt,
    }));
    for (const part of chunks(daily)) await tx`insert into mother.brand_daily ${tx(part)}`;

    const channel = read.rollups.channel.map((row) => ({
      brand_id: brandId,
      business_date: row.business_date,
      channel: row.channel,
      orders_placed: row.orders_placed,
      orders_confirmed: row.orders_confirmed,
      orders_delivered: row.orders_delivered,
      orders_returned: row.orders_returned,
      orders_cancelled: row.orders_cancelled,
      delivered_revenue_poisha: row.delivered_revenue_poisha,
      gross_profit_poisha: row.gross_profit_poisha,
      delivered_outside_dhaka: row.delivered_outside_dhaka,
      returned_outside_dhaka: row.returned_outside_dhaka,
      pulled_at: pulledAt,
    }));
    for (const part of chunks(channel)) {
      await tx`insert into mother.brand_daily_channel ${tx(part)}`;
    }

    const campaign = read.rollups.campaign.map((row) => ({
      brand_id: brandId,
      business_date: row.business_date,
      campaign_key: row.campaign_id ?? 'none',
      campaign_name: row.campaign_name,
      spend_poisha: row.spend_poisha,
      orders_confirmed: row.orders_confirmed,
      orders_delivered: row.orders_delivered,
      orders_returned: row.orders_returned,
      delivered_revenue_poisha: row.delivered_revenue_poisha,
      placed_revenue_poisha: row.placed_revenue_poisha,
      pulled_at: pulledAt,
    }));
    for (const part of chunks(campaign)) {
      await tx`insert into mother.brand_daily_campaign ${tx(part)}`;
    }

    const ledger = read.rollups.ledger.map((row) => ({
      brand_id: brandId,
      business_date: row.business_date,
      subtype: row.subtype,
      account_class: row.account_class,
      debit_poisha: row.debit_poisha,
      credit_poisha: row.credit_poisha,
      pulled_at: pulledAt,
    }));
    for (const part of chunks(ledger)) {
      await tx`insert into mother.brand_daily_ledger ${tx(part)}`;
    }
  }

  private async recordFailure(
    brand: BrandRow,
    runId: string,
    code: BrandErrorCode,
    version: SchemaVersion | null,
  ): Promise<void> {
    await inMother(async (tx) => {
      await tx`
        update mother.brands set
          last_error_code = ${code},
          last_error_at = now(),
          schema_status = ${code === 'version_mismatch' ? 'version_mismatch' : brand.schema_status},
          brand_migrations = ${version?.count ?? brand.brand_migrations},
          updated_at = now()
        where id = ${brand.id}
      `;
      await tx`
        update mother.pull_runs set
          status = ${code === 'version_mismatch' ? 'version_mismatch' : 'failed'},
          error_code = ${code}, finished_at = now()
        where id = ${runId}
      `;
    });
  }
}
