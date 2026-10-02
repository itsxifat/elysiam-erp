import { Inject, Injectable } from '@nestjs/common';
import { withOrg, type Tx } from '@elysium/db';
import { businessDate, normalizeBdPhone, poisha, toIsoDate, type IsoDate } from '@elysium/domain';
import {
  aggregateFacts,
  ATTRIBUTION_RULES,
  campaignIndex,
  campaignMetrics,
  dailySeries,
  EMPTY_INPUTS,
  normaliseRefValue,
  resolveAttribution,
  segmentReport,
  type AgeBand,
  type AttributionRule,
  type CampaignMetrics,
  type LeadFact,
  type LeadStatus,
  type OrderFact,
  type SpendFact,
} from '@elysium/domain/marketing';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { PROMO_API, type PromoApi } from '../promo/promo.api.js';
import { sealToken } from './credentials.js';
import { MARKETING_CONFIG, type MarketingConfig } from './marketing.config.js';
import { MarketingError } from './marketing.errors.js';
import { MARKETING_QUEUES } from './marketing.queues.js';
import * as repo from './marketing.repository.js';
import type {
  CampaignRefInput,
  CreateCampaignInput,
  CreateLeadInput,
  MetaConnectionInput,
  PeriodInput,
  SegmentQueryInput,
  SpendListInput,
  UpdateCampaignInput,
  UpdateLeadInput,
  UpsertSpendInput,
} from './marketing.schemas.js';
import { META_GATEWAY, type MetaGateway } from './providers/meta-gateway.js';

/**
 * Campaigns, spend, leads, the Meta link and the dashboard (architecture §11; M18).
 *
 * Every write records its own audit entry in its own transaction. Money here is ad spend,
 * which the ledger already knows as a cash out with the `ad_spend` category (M08): these
 * figures feed §11's ratios and post nothing (D-253).
 */

const json = (value: bigint | null): string | null => (value === null ? null : value.toString());

function metricsView(metrics: CampaignMetrics) {
  return {
    spendPoisha: metrics.spendPoisha.toString(),
    confirmedOrders: metrics.confirmedOrders,
    deliveredOrders: metrics.deliveredOrders,
    returnedOrders: metrics.returnedOrders,
    deliveredRevenuePoisha: metrics.deliveredRevenuePoisha.toString(),
    placedRevenuePoisha: metrics.placedRevenuePoisha.toString(),
    cpoPoisha: json(metrics.cpoPoisha),
    cpdoPoisha: json(metrics.cpdoPoisha),
    roasBps: json(metrics.roasBps),
    placedRoasBps: json(metrics.placedRoasBps),
    returnRateBps: json(metrics.returnRateBps),
  };
}

function campaignView(row: repo.CampaignRow, refs: readonly repo.RefRow[]) {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    productIds: Array.isArray(row.product_ids) ? (row.product_ids as string[]) : [],
    startsOn: row.starts_on,
    endsOn: row.ends_on,
    status: row.status,
    origin: row.origin,
    refs: refs
      .filter((ref) => ref.campaign_id === row.id)
      .map((ref) => ({ id: ref.id, kind: ref.kind, value: ref.value })),
  };
}

function leadView(row: repo.LeadRow) {
  return {
    id: row.id,
    phone: row.phone_e164,
    name: row.name,
    channel: row.channel,
    campaignId: row.campaign_id,
    skuId: row.sku_id,
    size: row.size,
    ageBand: row.age_band,
    profession: row.profession,
    status: row.status,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

function dhaka(instant: Date | null): IsoDate | null {
  return instant === null ? null : businessDate(instant);
}

@Injectable()
export class MarketingService {
  constructor(
    private readonly audit: AuditService,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(PROMO_API) private readonly promo: PromoApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    @Inject(MARKETING_CONFIG) private readonly config: MarketingConfig,
    @Inject(META_GATEWAY) private readonly gateway: MetaGateway,
  ) {}

  private tx<T>(context: ActiveContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, work);
  }

  // --- campaigns -------------------------------------------------------------------

  async listCampaigns(context: ActiveContext, status: string | undefined) {
    return this.tx(context, async (tx) => {
      const [rows, refs] = [
        await repo.listCampaigns(tx, context.orgId, status),
        await repo.listRefs(tx, context.orgId),
      ];
      return { items: rows.map((row) => campaignView(row, refs)) };
    });
  }

  /** The spend screen's picker: ids and names only, for a role that cannot manage campaigns. */
  async campaignChoices(context: ActiveContext) {
    return this.tx(context, async (tx) => {
      const rows = await repo.listCampaigns(tx, context.orgId, undefined);
      return {
        items: rows.map((row) => ({
          id: row.id,
          name: row.name,
          platform: row.platform,
          status: row.status,
        })),
      };
    });
  }

  private async refreshed(tx: Tx, orgId: string, id: string) {
    const row = await repo.campaignById(tx, orgId, id);
    if (row === undefined) throw new Error('a campaign vanished inside its own transaction');
    return campaignView(row, await repo.listRefs(tx, orgId));
  }

  private async mustHaveCampaign(tx: Tx, orgId: string, id: string, lock = false) {
    const row = await repo.campaignById(tx, orgId, id, lock);
    if (row === undefined) {
      throw new MarketingError('MARKETING_CAMPAIGN_NOT_FOUND', 'No such campaign in this brand.');
    }
    return row;
  }

  /** One ref, idempotent for the same campaign and refused when another holds the value. */
  private async addRefIn(
    tx: Tx,
    orgId: string,
    campaignId: string,
    ref: CampaignRefInput,
    actor: string,
  ): Promise<void> {
    const value = normaliseRefValue(ref.kind, ref.value);
    const inserted = await repo.insertRef(tx, {
      orgId,
      campaignId,
      kind: ref.kind,
      value,
      createdBy: actor,
    });
    if (inserted !== undefined) return;
    const owner = await repo.refOwner(tx, orgId, ref.kind, value);
    if (owner !== campaignId) {
      throw new MarketingError(
        'MARKETING_REF_TAKEN',
        `That ${ref.kind === 'utm_campaign' ? 'utm_campaign' : 'Meta id'} already names another campaign.`,
      );
    }
  }

  async createCampaign(
    context: ActiveContext,
    request: AuditableRequest,
    input: CreateCampaignInput,
  ) {
    return this.tx(context, async (tx) => {
      const id = await repo.insertCampaign(tx, {
        orgId: context.orgId,
        name: input.name,
        platform: input.platform,
        productIds: input.productIds ?? [],
        startsOn: input.startsOn ?? null,
        endsOn: input.endsOn ?? null,
        origin: 'manual',
        createdBy: context.userId,
      });
      for (const ref of input.refs ?? []) {
        await this.addRefIn(tx, context.orgId, id, ref, context.userId);
      }
      const view = await this.refreshed(tx, context.orgId, id);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'marketing.campaign.created',
        entityType: 'Campaign',
        entityId: id,
        before: null,
        after: { name: view.name, platform: view.platform, refs: view.refs.length },
        requestId: context.requestId,
        request,
      });
      return view;
    });
  }

  async updateCampaign(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: UpdateCampaignInput,
  ) {
    return this.tx(context, async (tx) => {
      const before = await this.mustHaveCampaign(tx, context.orgId, id, true);
      const next = {
        name: input.name ?? before.name,
        platform: input.platform ?? before.platform,
        productIds:
          input.productIds ??
          (Array.isArray(before.product_ids) ? (before.product_ids as string[]) : []),
        startsOn: input.startsOn === undefined ? before.starts_on : input.startsOn,
        endsOn: input.endsOn === undefined ? before.ends_on : input.endsOn,
        status: input.status ?? before.status,
      };
      if (next.startsOn !== null && next.endsOn !== null && next.startsOn > next.endsOn) {
        throw new MarketingError('MARKETING_INVALID', 'The campaign ends before it starts.');
      }
      await repo.updateCampaign(tx, context.orgId, id, next);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'marketing.campaign.updated',
        entityType: 'Campaign',
        entityId: id,
        before: { name: before.name, status: before.status },
        after: { name: next.name, status: next.status },
        requestId: context.requestId,
        request,
      });
      return this.refreshed(tx, context.orgId, id);
    });
  }

  async addRef(
    context: ActiveContext,
    request: AuditableRequest,
    campaignId: string,
    input: CampaignRefInput,
  ) {
    return this.tx(context, async (tx) => {
      await this.mustHaveCampaign(tx, context.orgId, campaignId, true);
      await this.addRefIn(tx, context.orgId, campaignId, input, context.userId);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'marketing.campaign.ref_added',
        entityType: 'Campaign',
        entityId: campaignId,
        before: null,
        after: { kind: input.kind, value: normaliseRefValue(input.kind, input.value) },
        requestId: context.requestId,
        request,
      });
      return this.refreshed(tx, context.orgId, campaignId);
    });
  }

  /** Removing a ref un-attributes exactly what it attributed: attribution is read-time (D-250). */
  async removeRef(
    context: ActiveContext,
    request: AuditableRequest,
    campaignId: string,
    refId: string,
  ) {
    return this.tx(context, async (tx) => {
      await this.mustHaveCampaign(tx, context.orgId, campaignId, true);
      const removed = await repo.deleteRef(tx, context.orgId, campaignId, refId);
      if (removed !== undefined) {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'delete',
          action: 'marketing.campaign.ref_removed',
          entityType: 'Campaign',
          entityId: campaignId,
          before: { kind: removed.kind, value: removed.value },
          after: null,
          requestId: context.requestId,
          request,
        });
      }
      return this.refreshed(tx, context.orgId, campaignId);
    });
  }

  // --- spend -----------------------------------------------------------------------

  async listSpend(context: ActiveContext, filter: SpendListInput) {
    return this.tx(context, async (tx) => {
      const rows = await repo.spendInPeriod(tx, context.orgId, filter);
      return {
        items: rows.map((row) => ({
          id: row.id,
          campaignId: row.campaign_id,
          spendDate: row.spend_date,
          amountPoisha: row.amount_poisha,
          source: row.source,
          note: row.note,
          updatedAt: row.updated_at,
        })),
      };
    });
  }

  /** A person's figure for a day: replaces whatever the day held, an import included. */
  async upsertSpend(context: ActiveContext, request: AuditableRequest, input: UpsertSpendInput) {
    return this.tx(context, async (tx) => {
      await this.mustHaveCampaign(tx, context.orgId, input.campaignId);
      const before = await repo.spendFor(tx, context.orgId, input.campaignId, input.spendDate);
      const id = await repo.upsertManualSpend(tx, {
        orgId: context.orgId,
        campaignId: input.campaignId,
        spendDate: input.spendDate,
        amountPoisha: BigInt(input.amountPoisha),
        note: input.note ?? null,
        enteredBy: context.userId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: before === undefined ? 'create' : 'update',
        action: 'marketing.spend.entered',
        entityType: 'CampaignSpend',
        entityId: id,
        before:
          before === undefined
            ? null
            : { amountPoisha: before.amount_poisha, source: before.source },
        after: {
          campaignId: input.campaignId,
          spendDate: input.spendDate,
          amountPoisha: input.amountPoisha,
          source: 'manual',
        },
        requestId: context.requestId,
        request,
      });
      return {
        id,
        campaignId: input.campaignId,
        spendDate: input.spendDate,
        amountPoisha: input.amountPoisha,
        source: 'manual' as const,
      };
    });
  }

  /** Queue an import of a date range now; the 06:00 schedule does the last three days. */
  async requestImport(context: ActiveContext, request: AuditableRequest, period: PeriodInput) {
    return this.tx(context, async (tx) => {
      const link = await repo.connection(tx, context.orgId);
      if (link?.ad_account_id == null || link.token === null) {
        throw new MarketingError(
          'MARKETING_META_NOT_CONNECTED',
          'Set this brand’s Meta ad account and token before importing spend.',
        );
      }
      const jobId = await enqueue(
        tx,
        MARKETING_QUEUES.importSpend,
        { from: period.from, to: period.to },
        {
          orgId: context.orgId,
          requestId: context.requestId,
          singletonKey: `spend:${context.orgId}:${period.from}:${period.to}`,
        },
      );
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'marketing.spend.import_requested',
        entityType: 'CampaignSpend',
        entityId: link.id,
        before: null,
        after: { from: period.from, to: period.to },
        requestId: context.requestId,
        request,
      });
      return { queued: jobId !== null, from: period.from, to: period.to };
    });
  }

  // --- the Meta link ---------------------------------------------------------------

  private connectionView(row: repo.ConnectionRow | undefined) {
    return {
      provider: this.gateway.provider,
      adAccountId: row?.ad_account_id ?? null,
      pixelId: row?.pixel_id ?? null,
      tokenConfigured: row?.token != null,
      tokenFingerprint: row?.token_fingerprint ?? null,
      spendImportEnabled: row?.spend_import_enabled ?? false,
      capiEnabled: row?.capi_enabled ?? false,
      sendNameAndCity: row?.send_name_and_city ?? false,
      testEventCode: row?.test_event_code ?? null,
      lastImportAt: row?.last_import_at ?? null,
      lastImportStatus: row?.last_import_status ?? null,
      lastImportError: row?.last_import_error ?? null,
    };
  }

  async getConnection(context: ActiveContext) {
    return this.tx(context, async (tx) =>
      this.connectionView(await repo.connection(tx, context.orgId)),
    );
  }

  async saveConnection(
    context: ActiveContext,
    request: AuditableRequest,
    input: MetaConnectionInput,
  ) {
    return this.tx(context, async (tx) => {
      const before = await repo.connection(tx, context.orgId, true);
      let token: Buffer | null =
        before?.token == null ? null : Buffer.from(before.token as Uint8Array);
      let keyId = before?.token_key_id ?? null;
      let fingerprint = before?.token_fingerprint ?? null;
      if (input.clearToken === true) {
        token = null;
        keyId = null;
        fingerprint = null;
      } else if (input.token !== undefined) {
        const sealed = sealToken(input.token, context.orgId, {
          key: this.config.MARKETING_CREDENTIALS_KEY,
          keyId: this.config.MARKETING_CREDENTIALS_KEY_ID,
        });
        token = sealed.ciphertext;
        keyId = sealed.keyId;
        fingerprint = sealed.fingerprint;
      }

      const next: repo.ConnectionValues = {
        adAccountId:
          input.adAccountId === undefined ? (before?.ad_account_id ?? null) : input.adAccountId,
        pixelId: input.pixelId === undefined ? (before?.pixel_id ?? null) : input.pixelId,
        token,
        tokenKeyId: keyId,
        tokenFingerprint: fingerprint,
        spendImportEnabled: input.spendImportEnabled ?? before?.spend_import_enabled ?? false,
        capiEnabled: input.capiEnabled ?? before?.capi_enabled ?? false,
        sendNameAndCity: input.sendNameAndCity ?? before?.send_name_and_city ?? false,
        testEventCode:
          input.testEventCode === undefined
            ? (before?.test_event_code ?? null)
            : input.testEventCode,
      };
      if (next.spendImportEnabled && (next.adAccountId === null || next.token === null)) {
        throw new MarketingError(
          'MARKETING_META_NOT_CONNECTED',
          'The daily spend import needs the ad account id and a token.',
        );
      }
      if (next.capiEnabled && (next.pixelId === null || next.token === null)) {
        throw new MarketingError(
          'MARKETING_META_NOT_CONNECTED',
          'Sending conversions needs the pixel (dataset) id and a token.',
        );
      }

      await repo.saveConnection(tx, context.orgId, next, context.userId);
      const saved = await repo.connection(tx, context.orgId);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: before === undefined ? 'create' : 'update',
        action: 'marketing.meta_connection.saved',
        entityType: 'MetaConnection',
        entityId: saved?.id ?? context.orgId,
        // The fingerprint says which token; the token itself never reaches the log.
        before:
          before === undefined
            ? null
            : {
                adAccountId: before.ad_account_id,
                pixelId: before.pixel_id,
                tokenFingerprint: before.token_fingerprint,
                spendImportEnabled: before.spend_import_enabled,
                capiEnabled: before.capi_enabled,
                sendNameAndCity: before.send_name_and_city,
              },
        after: {
          adAccountId: next.adAccountId,
          pixelId: next.pixelId,
          tokenFingerprint: next.tokenFingerprint,
          spendImportEnabled: next.spendImportEnabled,
          capiEnabled: next.capiEnabled,
          sendNameAndCity: next.sendNameAndCity,
        },
        requestId: context.requestId,
        request,
      });
      return this.connectionView(saved);
    });
  }

  // --- the dashboard ---------------------------------------------------------------

  /**
   * §11's metrics for a period, per campaign and in total, with a daily series.
   *
   * Attribution is resolved here, now, from each order's own recorded source and the
   * brand's current mappings (D-250); `resolveAttribution` is the only place that decides.
   */
  async dashboard(context: ActiveContext, period: PeriodInput) {
    const range = { from: toIsoDate(period.from), to: toIsoDate(period.to) };
    return this.tx(context, async (tx) => {
      const facts = await this.orders.marketingFacts(tx, context.orgId, period);
      const campaigns = await repo.listCampaigns(tx, context.orgId, undefined);
      const refs = await repo.listRefs(tx, context.orgId);
      const spendRows = await repo.spendInPeriod(tx, context.orgId, period);
      const codeIds = [
        ...new Set(facts.flatMap((fact) => (fact.promoCodeId === null ? [] : [fact.promoCodeId]))),
      ];
      const promoCampaigns = await this.promo.campaignsOfCodes(tx, context.orgId, codeIds);

      const index = campaignIndex(
        campaigns.map((row) => row.id),
        refs.map((ref) => ({ campaignId: ref.campaign_id, kind: ref.kind, value: ref.value })),
      );
      const rules = Object.fromEntries(ATTRIBUTION_RULES.map((rule) => [rule, 0])) as Record<
        AttributionRule,
        number
      >;
      const orders: OrderFact[] = facts.map((fact) => {
        const attribution = resolveAttribution(
          {
            campaignId: fact.source.campaignId,
            promoCampaignId:
              fact.promoCodeId === null ? null : (promoCampaigns.get(fact.promoCodeId) ?? null),
            adId: fact.source.adId,
            utmCampaign: fact.source.utmCampaign,
          },
          index,
        );
        rules[attribution.rule] += 1;
        return {
          orderId: fact.orderId,
          campaignId: attribution.campaignId,
          confirmedOn: dhaka(fact.confirmedAt),
          deliveredOn: dhaka(fact.deliveredAt),
          returnedOn: dhaka(fact.returnedAt),
          deliveredRevenuePoisha: fact.deliveredRevenuePoisha,
          placedRevenuePoisha: fact.placedRevenuePoisha,
        };
      });
      const spend: SpendFact[] = spendRows.map((row) => ({
        campaignId: row.campaign_id,
        spendOn: toIsoDate(row.spend_date),
        amountPoisha: poisha(row.amount_poisha),
      }));

      const aggregated = aggregateFacts(orders, spend, range);
      const rows = campaigns
        .map((campaign) => ({ campaign, inputs: aggregated.byCampaign.get(campaign.id) }))
        // An archived campaign with nothing in the period is not a row; an active one is,
        // with zeros, so a campaign that spent nothing yet is still on the board.
        .filter((entry) => entry.inputs !== undefined || entry.campaign.status === 'active')
        .map(({ campaign, inputs }) => ({
          campaignId: campaign.id,
          name: campaign.name,
          platform: campaign.platform,
          status: campaign.status,
          metrics: metricsView(campaignMetrics(inputs ?? EMPTY_INPUTS)),
        }));
      const unattributed = aggregated.byCampaign.get(null);

      return {
        from: period.from,
        to: period.to,
        total: metricsView(campaignMetrics(aggregated.total)),
        campaigns: rows,
        unattributed:
          unattributed === undefined ? null : metricsView(campaignMetrics(unattributed)),
        attribution: rules,
        series: dailySeries(orders, spend, range).map((point) => ({
          date: point.date,
          spendPoisha: point.spendPoisha.toString(),
          deliveredRevenuePoisha: point.deliveredRevenuePoisha.toString(),
        })),
      };
    });
  }

  // --- leads -----------------------------------------------------------------------

  async listLeads(context: ActiveContext, filter: { status?: string | undefined; limit: number }) {
    return this.tx(context, async (tx) => ({
      items: (await repo.listLeads(tx, context.orgId, filter)).map(leadView),
    }));
  }

  private async checkLeadRefs(
    tx: Tx,
    orgId: string,
    campaignId: string | null | undefined,
    skuId: string | null | undefined,
  ): Promise<void> {
    if (typeof campaignId === 'string') await this.mustHaveCampaign(tx, orgId, campaignId);
    if (typeof skuId === 'string') {
      const found = await this.catalog.skusByIds(tx, orgId, [skuId]);
      if (found.length === 0) {
        throw new MarketingError('MARKETING_INVALID', 'No such SKU in this brand.');
      }
    }
  }

  async createLead(context: ActiveContext, request: AuditableRequest, input: CreateLeadInput) {
    let phone: string;
    try {
      phone = normalizeBdPhone(input.phone);
    } catch (cause) {
      throw new MarketingError(
        'MARKETING_INVALID',
        cause instanceof Error ? cause.message : 'That is not a Bangladeshi mobile number.',
      );
    }
    return this.tx(context, async (tx) => {
      await this.checkLeadRefs(tx, context.orgId, input.campaignId, input.skuId);
      const id = await repo.insertLead(tx, {
        orgId: context.orgId,
        phoneE164: phone,
        channel: input.channel,
        name: input.name ?? null,
        campaignId: input.campaignId ?? null,
        skuId: input.skuId ?? null,
        size: input.size ?? null,
        ageBand: input.ageBand ?? null,
        profession: input.profession ?? null,
        status: input.status ?? 'new',
        notes: input.notes ?? null,
        createdBy: context.userId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'marketing.lead.created',
        entityType: 'Lead',
        entityId: id,
        before: null,
        // The phone stays in the tenant's own table; the log needs only that a lead exists.
        after: { channel: input.channel, status: input.status ?? 'new' },
        requestId: context.requestId,
        request,
      });
      const row = await repo.leadById(tx, context.orgId, id);
      if (row === undefined) throw new Error('a lead vanished inside its own transaction');
      return leadView(row);
    });
  }

  async updateLead(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: UpdateLeadInput,
  ) {
    return this.tx(context, async (tx) => {
      const before = await repo.leadById(tx, context.orgId, id);
      if (before === undefined) {
        throw new MarketingError('MARKETING_LEAD_NOT_FOUND', 'No such lead in this brand.');
      }
      await this.checkLeadRefs(tx, context.orgId, input.campaignId, input.skuId);
      // `undefined` keeps the current value; `null` clears it.
      const pick = <T>(value: T | undefined, current: T): T => {
        if (value === undefined) return current;
        return value;
      };
      await repo.updateLead(tx, context.orgId, id, {
        name: pick(input.name, before.name),
        campaignId: pick(input.campaignId, before.campaign_id),
        skuId: pick(input.skuId, before.sku_id),
        size: pick(input.size, before.size),
        ageBand: pick(input.ageBand, before.age_band),
        profession: pick(input.profession, before.profession),
        status: input.status ?? before.status,
        notes: pick(input.notes, before.notes),
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'marketing.lead.updated',
        entityType: 'Lead',
        entityId: id,
        before: { status: before.status },
        after: { status: input.status ?? before.status },
        requestId: context.requestId,
        request,
      });
      const row = await repo.leadById(tx, context.orgId, id);
      if (row === undefined) throw new Error('a lead vanished inside its own transaction');
      return leadView(row);
    });
  }

  /** Leads grouped by one of the client's four dimensions (D-258). */
  async segments(context: ActiveContext, query: SegmentQueryInput) {
    return this.tx(context, async (tx) => {
      const rows = await repo.leadsForSegments(tx, context.orgId, query);
      const skuIds = [...new Set(rows.flatMap((row) => (row.sku_id === null ? [] : [row.sku_id])))];
      const skus = new Map(
        (await this.catalog.skusByIds(tx, context.orgId, skuIds)).map((sku) => [sku.id, sku]),
      );
      const facts: LeadFact[] = rows.map((row) => {
        const sku = row.sku_id === null ? undefined : skus.get(row.sku_id);
        return {
          product: sku === undefined ? null : { id: sku.productId, name: sku.productName },
          size: row.size,
          ageBand: row.age_band as AgeBand | null,
          profession: row.profession,
          status: row.status as LeadStatus,
        };
      });
      return {
        dimension: query.dimension,
        total: facts.length,
        rows: segmentReport(facts, query.dimension).map((row) => ({
          key: row.key,
          label: row.label,
          leads: row.leads,
          converted: row.converted,
          conversionBps: row.conversionBps.toString(),
        })),
      };
    });
  }

  // --- the conversion log ----------------------------------------------------------

  async listConversions(
    context: ActiveContext,
    filter: { status?: string | undefined; limit: number },
  ) {
    return this.tx(context, async (tx) => ({
      items: (await repo.listCapiEvents(tx, context.orgId, filter)).map((row) => ({
        id: row.id,
        orderId: row.order_id,
        eventName: row.event_name,
        eventId: row.event_id,
        status: row.status,
        attempts: row.attempts,
        valuePoisha: row.value_poisha,
        eventTime: row.event_time,
        response: row.response,
        lastError: row.last_error,
        sentAt: row.sent_at,
        createdAt: row.created_at,
      })),
    }));
  }
}
