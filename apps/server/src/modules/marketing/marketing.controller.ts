import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { mapMarketingErrors } from './marketing.errors.js';
import {
  campaignListSchema,
  campaignRefSchema,
  capiListSchema,
  createCampaignSchema,
  createLeadSchema,
  idParamSchema,
  leadListSchema,
  metaConnectionSchema,
  metaImportSchema,
  periodSchema,
  segmentQuerySchema,
  spendListSchema,
  updateCampaignSchema,
  updateLeadSchema,
  upsertSpendSchema,
} from './marketing.schemas.js';
import { MarketingService } from './marketing.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Marketing over HTTP (architecture §11, §23; M18).
 *
 * Two subjects, as §6's row has two cells (D-260):
 *
 * - **`Campaign`** — campaigns, leads, the dashboard, the Meta link and the conversion
 *   log. org_admin and marketing, both at `org`.
 * - **`CampaignSpend`** — the spend figures, the campaign picker that entering one needs,
 *   and asking for a Meta import. org_admin, marketing and accounts ("spend entry").
 *
 * Every holder of either subject holds it at `org`, so no route here narrows by branch,
 * owner or assignee: a campaign is the brand's.
 */
@Controller('v1/marketing')
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  // --- campaigns -------------------------------------------------------------------

  @RequireAbility('read', 'Campaign')
  @Get('campaigns')
  async listCampaigns(@Req() request: FastifyRequest, @Query() query: unknown) {
    const filter = parse(campaignListSchema, query ?? {});
    return mapMarketingErrors(() =>
      this.marketing.listCampaigns(requireContext(request), filter.status),
    );
  }

  @RequireAbility('create', 'Campaign')
  @Post('campaigns')
  async createCampaign(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createCampaignSchema, body);
    return mapMarketingErrors(() =>
      this.marketing.createCampaign(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('update', 'Campaign')
  @Patch('campaigns/:id')
  async updateCampaign(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const campaignId = parse(idParamSchema, id);
    const input = parse(updateCampaignSchema, body);
    return mapMarketingErrors(() =>
      this.marketing.updateCampaign(requireContext(request), auditable(request), campaignId, input),
    );
  }

  /** Map a Meta campaign id, a Meta ad id or a `utm_campaign` value to the campaign. */
  @RequireAbility('update', 'Campaign')
  @Post('campaigns/:id/refs')
  async addRef(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const campaignId = parse(idParamSchema, id);
    const input = parse(campaignRefSchema, body);
    return mapMarketingErrors(() =>
      this.marketing.addRef(requireContext(request), auditable(request), campaignId, input),
    );
  }

  @RequireAbility('update', 'Campaign')
  @Delete('campaigns/:id/refs/:refId')
  async removeRef(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('refId') refId: string,
  ) {
    const campaignId = parse(idParamSchema, id);
    const ref = parse(idParamSchema, refId);
    return mapMarketingErrors(() =>
      this.marketing.removeRef(requireContext(request), auditable(request), campaignId, ref),
    );
  }

  // --- spend -----------------------------------------------------------------------

  @RequireAbility('read', 'CampaignSpend')
  @Get('spend')
  async listSpend(@Req() request: FastifyRequest, @Query() query: unknown) {
    const filter = parse(spendListSchema, query ?? {});
    return mapMarketingErrors(() => this.marketing.listSpend(requireContext(request), filter));
  }

  /** The campaigns a spend figure can be entered against: ids and names, nothing else. */
  @RequireAbility('read', 'CampaignSpend')
  @Get('spend/campaigns')
  async spendCampaigns(@Req() request: FastifyRequest) {
    return mapMarketingErrors(() => this.marketing.campaignChoices(requireContext(request)));
  }

  /** One campaign's figure for one day; entering it again replaces it. */
  @RequireAbility('create', 'CampaignSpend')
  @Put('spend')
  async upsertSpend(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(upsertSpendSchema, body);
    return mapMarketingErrors(() =>
      this.marketing.upsertSpend(requireContext(request), auditable(request), input),
    );
  }

  /** Queue a Meta Insights import for a date range (the daily schedule covers the rest). */
  @RequireAbility('create', 'CampaignSpend')
  @Post('meta/import')
  async requestImport(@Req() request: FastifyRequest, @Body() body: unknown) {
    const period = parse(metaImportSchema, body);
    return mapMarketingErrors(() =>
      this.marketing.requestImport(requireContext(request), auditable(request), period),
    );
  }

  // --- the Meta link ---------------------------------------------------------------

  @RequireAbility('read', 'Campaign')
  @Get('meta-connection')
  async getConnection(@Req() request: FastifyRequest) {
    return mapMarketingErrors(() => this.marketing.getConnection(requireContext(request)));
  }

  /** The token is write-only: sealed on arrival, never returned, never logged. */
  @RequireAbility('update', 'Campaign')
  @Put('meta-connection')
  async saveConnection(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(metaConnectionSchema, body);
    return mapMarketingErrors(() =>
      this.marketing.saveConnection(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('read', 'Campaign')
  @Get('capi-events')
  async listConversions(@Req() request: FastifyRequest, @Query() query: unknown) {
    const filter = parse(capiListSchema, query ?? {});
    return mapMarketingErrors(() =>
      this.marketing.listConversions(requireContext(request), filter),
    );
  }

  // --- the dashboard ---------------------------------------------------------------

  @RequireAbility('read', 'Campaign')
  @Get('dashboard')
  async dashboard(@Req() request: FastifyRequest, @Query() query: unknown) {
    const period = parse(periodSchema, query ?? {});
    return mapMarketingErrors(() => this.marketing.dashboard(requireContext(request), period));
  }

  // --- leads -----------------------------------------------------------------------

  @RequireAbility('read', 'Campaign')
  @Get('leads')
  async listLeads(@Req() request: FastifyRequest, @Query() query: unknown) {
    const filter = parse(leadListSchema, query ?? {});
    return mapMarketingErrors(() => this.marketing.listLeads(requireContext(request), filter));
  }

  @RequireAbility('read', 'Campaign')
  @Get('leads/segments')
  async segments(@Req() request: FastifyRequest, @Query() query: unknown) {
    const input = parse(segmentQuerySchema, query ?? {});
    return mapMarketingErrors(() => this.marketing.segments(requireContext(request), input));
  }

  @RequireAbility('create', 'Campaign')
  @Post('leads')
  async createLead(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createLeadSchema, body);
    return mapMarketingErrors(() =>
      this.marketing.createLead(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('update', 'Campaign')
  @Patch('leads/:id')
  async updateLead(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const leadId = parse(idParamSchema, id);
    const input = parse(updateLeadSchema, body);
    return mapMarketingErrors(() =>
      this.marketing.updateLead(requireContext(request), auditable(request), leadId, input),
    );
  }
}
