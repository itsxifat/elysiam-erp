import { createHash, randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { canReadCost, ORDER_CHANNELS } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import {
  addDays,
  businessDate,
  periodForMonth,
  poisha,
  takaParts,
  toIsoDate,
  WALLET_SUBTYPES,
} from '@elysium/domain';
import {
  assertNarrativePayloadSafe,
  BASELINE_MONTHS,
  buildNarrativePayload,
  insightBaseline,
  insights,
  kpis,
  narrativePrompt,
  pickupMeanSeconds,
  returnRateBps,
  type Insight,
  type InsightMonth,
  type Kpis,
} from '@elysium/domain/analytics';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { FlagsService } from '../../platform/flags/flags.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { HR_API, type HrApi } from '../hr/hr.api.js';
import { INVENTORY_API, type InventoryApi } from '../inventory/inventory.api.js';
import { LEDGER_API, type LedgerApi } from '../ledger/ledger.api.js';
import { MARKETING_API, type MarketingApi } from '../marketing/marketing.api.js';
import {
  CSV_CONTENT_TYPE,
  toCsv,
  toXlsx,
  XLSX_CONTENT_TYPE,
  type TabularColumn,
  type TabularCell,
} from '../orders/export/tabular.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { AnalyticsError } from './analytics.errors.js';
import * as repo from './analytics.repository.js';
import type { DashboardQuery, ExportQuery, MonthQuery, RefreshInput } from './analytics.schemas.js';
import { NARRATIVE_PROVIDER, type NarrativeProvider } from './providers/narrative.provider.js';
import { daysOf, RollupService } from './rollup.service.js';

/**
 * The brand's dashboard, insights, the narrative and exports (architecture §18; M24).
 *
 * Everything reads the caller's own brand through **`withOrg()`**: RLS makes the brand the
 * only one there is. A brand's ERP runs on its own database and knows no other brand
 * (D-469), so the cross-brand reads (the leaderboard, the consolidated view, the insight
 * rules' group medians) left with M31 (D-471): the insight rules now measure a month
 * against the brand's own recent months.
 */

const text = (value: bigint | null): string | null => (value === null ? null : value.toString());

/** Taka with two decimals, from poisha, for a spreadsheet cell. Never a float (invariant 1). */
function takaText(value: bigint): string {
  const parts = takaParts(poisha(value));
  return `${parts.negative ? '-' : ''}${parts.taka.toString()}.${parts.poisha.toString().padStart(2, '0')}`;
}

function kpisView(values: Kpis) {
  return {
    aovPoisha: text(values.aovPoisha),
    returnRateBps: text(values.returnRateBps),
    deliverySuccessBps: text(values.deliverySuccessBps),
    cpoPoisha: text(values.cpoPoisha),
    cpdoPoisha: text(values.cpdoPoisha),
    roasBps: text(values.roasBps),
    pickupMeanSeconds: values.pickupMeanSeconds,
  };
}

function metricsView(row: repo.MetricSumRow) {
  return {
    ordersPlaced: row.orders_placed,
    ordersConfirmed: row.orders_confirmed,
    ordersDelivered: row.orders_delivered,
    ordersReturned: row.orders_returned,
    ordersCancelled: row.orders_cancelled,
    deliveredRevenuePoisha: row.delivered_revenue_poisha,
    // Cost-derived: `serializeFor` strips it for every role without `read Cost`.
    grossProfitPoisha: row.gross_profit_poisha,
    returnRateBps: text(returnRateBps(row.orders_delivered, row.orders_returned)),
  };
}

/** A brand's month for the insight rules and the narrative, from one sums row. */
function insightMonth(row: repo.RateFigures): InsightMonth {
  return {
    ordersConfirmed: row.orders_confirmed,
    ordersDelivered: row.orders_delivered,
    ordersReturned: row.orders_returned,
    ordersCancelled: row.orders_cancelled,
    deliveredRevenuePoisha: BigInt(row.delivered_revenue_poisha),
    spendPoisha: BigInt(row.spend_poisha),
    pickupCount: row.pickup_count,
    pickupSeconds: Number(row.pickup_seconds),
    deliveredOutsideDhaka: row.delivered_outside_dhaka,
    returnedOutsideDhaka: row.returned_outside_dhaka,
  };
}

function previousMonth(month: string): string {
  const start = periodForMonth(month).startsOn;
  return addDays(start, -1).slice(0, 7);
}

/** The `count` months before `month`, nearest first. */
function monthsBefore(month: string, count: number): string[] {
  const months: string[] = [];
  let cursor = month;
  for (let index = 0; index < count; index += 1) {
    cursor = previousMonth(cursor);
    months.push(cursor);
  }
  return months;
}

@Injectable()
export class AnalyticsService {
  /** The clock "today" is read from; a field so a suite can stand on a fixed day. */
  now: () => Date = () => new Date();

  constructor(
    private readonly rollup: RollupService,
    private readonly audit: AuditService,
    private readonly flags: FlagsService,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(MARKETING_API) private readonly marketing: MarketingApi,
    @Inject(HR_API) private readonly hr: HrApi,
    @Inject(LEDGER_API) private readonly ledger: LedgerApi,
    @Inject(INVENTORY_API) private readonly inventory: InventoryApi,
    @Inject(NARRATIVE_PROVIDER) private readonly provider: NarrativeProvider,
  ) {}

  private tx<T>(context: ActiveContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, work);
  }

  // --- the org dashboard (withOrg) ------------------------------------------------

  async dashboard(context: ActiveContext, query: DashboardQuery) {
    const range = { from: query.from, to: query.to };
    const today = businessDate(this.now());
    return this.tx(context, async (tx) => {
      const days = await repo.orgDays(tx, context.orgId, range.from, range.to);
      const totals = repo.sumTotals(days);
      const byDay = new Map(days.map((day) => [day.business_date, day]));
      const channels = await repo.channelSums(tx, context.orgId, range.from, range.to);
      const branches = await repo.branchSums(tx, context.orgId, range.from, range.to);
      const campaigns = await repo.campaignSums(tx, context.orgId, range.from, range.to);
      const campaignNames = await this.marketing.campaignNames(
        tx,
        context.orgId,
        campaigns.flatMap((row) => (row.campaign_id === null ? [] : [row.campaign_id])),
      );
      const agents = await repo.agentSums(tx, context.orgId, range.from, range.to);
      const people = await this.hr.employeesForUsers(
        tx,
        context.orgId,
        agents.map((row) => row.user_id),
      );
      const topSkus = await this.orders.topSkus(tx, context.orgId, range, 10);
      const balances = await this.ledger.balancesAsOf(tx, context.orgId, today, WALLET_SUBTYPES);
      const stock = await this.inventory.valuation(tx, context.orgId);

      const computedAt = days
        .map((day) => (day.computed_at === null ? null : new Date(day.computed_at)))
        .filter((value): value is Date => value !== null)
        .sort((a, b) => b.getTime() - a.getTime())[0];

      return {
        from: range.from,
        to: range.to,
        coverage: {
          days: daysOf(toIsoDate(range.from), toIsoDate(range.to)).length,
          computedDays: days.length,
          computedAt: computedAt?.toISOString() ?? null,
        },
        totals: {
          ...metricsView(totals),
          spendPoisha: totals.spend_poisha,
          pickupCount: totals.pickup_count,
          ...kpisView(kpis(kpiInputs(totals))),
        },
        series: daysOf(toIsoDate(range.from), toIsoDate(range.to)).map((date) => {
          const day = byDay.get(date);
          return {
            date,
            ordersConfirmed: day?.orders_confirmed ?? 0,
            ordersDelivered: day?.orders_delivered ?? 0,
            deliveredRevenuePoisha: day?.delivered_revenue_poisha ?? '0',
            spendPoisha: day?.spend_poisha ?? '0',
          };
        }),
        byChannel: channels.map((row) => ({ channel: row.key, ...metricsView(row) })),
        byBranch: branches.map((row) => ({
          branchId: row.key,
          name: row.name,
          ...metricsView(row),
        })),
        byCampaign: campaigns.map((row) => {
          const spend = BigInt(row.spend_poisha);
          const revenue = BigInt(row.delivered_revenue_poisha);
          const ratios = kpis({
            ordersConfirmed: row.orders_confirmed,
            ordersDelivered: row.orders_delivered,
            ordersReturned: row.orders_returned,
            ordersCancelled: 0,
            deliveredRevenuePoisha: revenue,
            spendPoisha: spend,
            pickupCount: 0,
            pickupSeconds: 0,
          });
          return {
            campaignId: row.campaign_id,
            name: row.campaign_id === null ? null : (campaignNames.get(row.campaign_id) ?? null),
            spendPoisha: row.spend_poisha,
            ordersConfirmed: row.orders_confirmed,
            ordersDelivered: row.orders_delivered,
            deliveredRevenuePoisha: row.delivered_revenue_poisha,
            cpdoPoisha: text(ratios.cpdoPoisha),
            roasBps: text(ratios.roasBps),
          };
        }),
        agents: agents.map((row) => {
          const person = people.get(row.user_id);
          return {
            userId: row.user_id,
            name: person?.fullName ?? null,
            employeeCode: person?.code ?? null,
            ordersConfirmed: row.orders_confirmed,
            ordersDelivered: row.orders_delivered,
            deliveredRevenuePoisha: row.delivered_revenue_poisha,
            pickupCount: row.pickup_count,
            pickupMeanSeconds: pickupMeanSeconds(row.pickup_count, Number(row.pickup_seconds)),
          };
        }),
        topSkus,
        cashPoisha: balances
          .reduce((total, line) => total + line.debitPoisha - line.creditPoisha, 0n)
          .toString(),
        cashAsOf: today,
        // Purchase cost (invariant 5): stripped by `serializeFor` for a role without it.
        stockValuePoisha: stock.stockValuePoisha.toString(),
      };
    });
  }

  // --- insights ----------------------------------------------------------------------

  private async insightsFor(context: ActiveContext, month: string) {
    const current = periodForMonth(month);
    const previous = periodForMonth(previousMonth(month));
    const own = await this.tx(context, async (tx) => {
      const sums = async (period: { startsOn: string; endsOn: string }) =>
        repo.sumTotals(await repo.orgDays(tx, context.orgId, period.startsOn, period.endsOn));
      // The brand's usual: its own three months before this one (D-471).
      const baseline: repo.OrgTotals[] = [];
      for (const earlier of monthsBefore(month, BASELINE_MONTHS)) {
        baseline.push(await sums(periodForMonth(earlier)));
      }
      return {
        current: await sums(current),
        previous: await sums(previous),
        baseline,
        channels: await repo.channelSums(tx, context.orgId, current.startsOn, current.endsOn),
        campaigns: await repo.campaignSums(tx, context.orgId, current.startsOn, current.endsOn),
      };
    });
    const found = insights({
      current: insightMonth(own.current),
      previous: insightMonth(own.previous),
      baseline: insightBaseline(own.baseline.map((row) => insightMonth(row))),
      channels: own.channels.map((row) => ({
        channel: row.key,
        ordersDelivered: row.orders_delivered,
        ordersReturned: row.orders_returned,
      })),
      campaigns: own.campaigns.flatMap((row) =>
        row.campaign_id === null
          ? []
          : [
              {
                campaignId: row.campaign_id,
                spendPoisha: BigInt(row.spend_poisha),
                deliveredRevenuePoisha: BigInt(row.delivered_revenue_poisha),
              },
            ],
      ),
    });
    return { own, found };
  }

  async insights(context: ActiveContext, query: MonthQuery) {
    const { found } = await this.insightsFor(context, query.month);
    const campaignIds = found.flatMap((insight) =>
      insight.params.campaignId === undefined ? [] : [insight.params.campaignId],
    );
    const names = await this.tx(context, (tx) =>
      this.marketing.campaignNames(tx, context.orgId, campaignIds),
    );
    return {
      month: query.month,
      items: found.map((insight: Insight) => ({
        code: insight.code,
        severity: insight.severity,
        params: insight.params,
        campaignName:
          insight.params.campaignId === undefined
            ? null
            : (names.get(insight.params.campaignId) ?? null),
      })),
    };
  }

  // --- the narrative (flag `analytics.llm_narrative`, D-327) ---------------------------

  async narrative(context: ActiveContext, query: MonthQuery) {
    if (!(await this.flags.isEnabled(context.orgId, 'analytics.llm_narrative'))) {
      return { enabled: false as const, month: query.month };
    }
    const today = businessDate(this.now());
    const cached = await this.tx(context, (tx) =>
      repo.narrativeFor(tx, context.orgId, query.month, today),
    );
    if (cached !== undefined) return narrativeView(query.month, cached, true);

    const { own, found } = await this.insightsFor(context, query.month);
    const payload = buildNarrativePayload({
      month: query.month,
      current: insightMonth(own.current),
      previous: insightMonth(own.previous),
      insights: found,
      channelCodes: ORDER_CHANNELS,
    });
    // Every time, before anything leaves: a payload outside the allow-list is refused.
    assertNarrativePayloadSafe(payload, ORDER_CHANNELS);
    const prompt = narrativePrompt(payload);

    // Outside any transaction (invariant 6): the provider is an external call.
    let body: string;
    try {
      body = (await this.provider.generate(prompt, payload)).trim().slice(0, 8_000);
    } catch {
      throw new AnalyticsError(
        'ANALYTICS_NARRATIVE_FAILED',
        'The narrative could not be written just now. The figures above are unaffected.',
      );
    }
    if (body === '') {
      throw new AnalyticsError('ANALYTICS_NARRATIVE_FAILED', 'The narrative came back empty.');
    }

    const stored = await this.tx(context, async (tx) => {
      await repo.insertNarrative(tx, {
        orgId: context.orgId,
        month: query.month,
        generatedOn: today,
        provider: this.provider.name,
        payloadSha256: createHash('sha256').update(prompt.user).digest('hex'),
        body,
        createdBy: context.userId,
      });
      return repo.narrativeFor(tx, context.orgId, query.month, today);
    });
    if (stored === undefined) {
      throw new AnalyticsError('ANALYTICS_NARRATIVE_FAILED', 'The narrative was not saved.');
    }
    return narrativeView(query.month, stored, false);
  }

  // --- refresh and export (withOrg) --------------------------------------------------

  async refresh(context: ActiveContext, request: AuditableRequest, input: RefreshInput) {
    return this.tx(context, async (tx) => {
      const result = await this.rollup.recomputeIn(tx, context.orgId, input);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'analytics.rollups_refreshed',
        entityType: 'analytics_rollup',
        entityId: `${input.from}..${input.to}`,
        after: { from: input.from, to: input.to, days: result.days },
        requestId: context.requestId,
        request,
      });
      return { from: input.from, to: input.to, days: result.days };
    });
  }

  async export(
    context: ActiveContext,
    request: AuditableRequest,
    query: ExportQuery,
  ): Promise<{ bytes: Buffer; filename: string; contentType: string; rows: number }> {
    const seesCost = canReadCost(context.roles, context.isSuperAdmin);
    const days = await this.tx(context, async (tx) => {
      const found = await repo.orgDays(tx, context.orgId, query.from, query.to);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'analytics.exported',
        entityType: 'analytics_export',
        entityId: randomUUID(),
        after: { from: query.from, to: query.to, format: query.format, rows: found.length },
        requestId: context.requestId,
        request,
      });
      return found;
    });

    const columns: TabularColumn[] = [
      { header: 'Date', kind: 'date' },
      { header: 'Orders placed', kind: 'number' },
      { header: 'Orders confirmed', kind: 'number' },
      { header: 'Orders delivered', kind: 'number' },
      { header: 'Orders returned', kind: 'number' },
      { header: 'Cancelled after confirmation', kind: 'number' },
      { header: 'Delivered revenue (Tk)', kind: 'number' },
      ...(seesCost ? [{ header: 'Gross profit (Tk)', kind: 'number' as const }] : []),
      { header: 'Ad spend (Tk)', kind: 'number' },
      { header: 'Delivered outside Dhaka', kind: 'number' },
      { header: 'Returned outside Dhaka', kind: 'number' },
      { header: 'Desk pickups', kind: 'number' },
    ];
    const rows: TabularCell[][] = days.map((day) => [
      day.business_date,
      day.orders_placed,
      day.orders_confirmed,
      day.orders_delivered,
      day.orders_returned,
      day.orders_cancelled,
      takaText(BigInt(day.delivered_revenue_poisha)),
      ...(seesCost ? [takaText(BigInt(day.gross_profit_poisha))] : []),
      takaText(BigInt(day.spend_poisha)),
      day.delivered_outside_dhaka,
      day.returned_outside_dhaka,
      day.pickup_count,
    ]);
    const stem = `analytics-${query.from}-to-${query.to}`;
    return query.format === 'xlsx'
      ? {
          bytes: toXlsx('Daily', columns, rows),
          filename: `${stem}.xlsx`,
          contentType: XLSX_CONTENT_TYPE,
          rows: rows.length,
        }
      : {
          bytes: toCsv(columns, rows),
          filename: `${stem}.csv`,
          contentType: CSV_CONTENT_TYPE,
          rows: rows.length,
        };
  }
}

function kpiInputs(row: repo.RateFigures) {
  return {
    ordersConfirmed: row.orders_confirmed,
    ordersDelivered: row.orders_delivered,
    ordersReturned: row.orders_returned,
    ordersCancelled: row.orders_cancelled,
    deliveredRevenuePoisha: BigInt(row.delivered_revenue_poisha),
    spendPoisha: BigInt(row.spend_poisha),
    pickupCount: row.pickup_count,
    pickupSeconds: Number(row.pickup_seconds),
  };
}

function narrativeView(month: string, row: repo.NarrativeRow, cached: boolean) {
  return {
    enabled: true as const,
    month,
    text: row.body,
    provider: row.provider,
    generatedOn: row.generated_on,
    cached,
  };
}
