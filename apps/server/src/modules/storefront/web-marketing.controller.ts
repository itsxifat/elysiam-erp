import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  campaignLinkSchema,
  trackingEventsSchema,
  trackingSettingsSchema,
} from '@elysium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AuditExempt } from '../../platform/audit/audit.interceptor.js';
import { Public, RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { CampaignLinksService } from './campaign-links.service.js';
import { StorefrontSignatureGuard, storefrontSiteOf } from './signature.guard.js';
import { answer, cached } from './storefront-buying.controller.js';
import { mapStorefrontErrors } from './storefront.errors.js';
import { TrackingService } from './tracking.service.js';

const idSchema = z.string().uuid('No such record.');
const logQuerySchema = z
  .object({
    status: z.enum(['waiting', 'queued', 'success', 'partial', 'error', 'skipped']).optional(),
    eventName: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)
      .optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message:
        issue === undefined
          ? 'That is not valid.'
          : `${issue.path.join('.') || 'body'}: ${issue.message}`,
    });
  }
  return parsed.data;
}

/**
 * The console's campaign links and tracking (M35b, D-551, D-552), under the Website section's
 * subject (`Storefront`, D-508): org_admin and marketing change them, sales reads them. The
 * tracking token and API secret are written here too: the pixel is marketing's to run, and the
 * audit's redaction keeps both out of the log.
 */
@Controller('v1/storefront')
export class WebMarketingController {
  constructor(
    private readonly links: CampaignLinksService,
    private readonly tracking: TrackingService,
  ) {}

  // --- campaign links -------------------------------------------------------------------------

  @RequireAbility('read', 'Storefront')
  @Get('campaign-links')
  async listLinks(@Req() request: FastifyRequest) {
    return mapStorefrontErrors(() => this.links.list(requireContext(request)));
  }

  @RequireAbility('read', 'Storefront')
  @Get('campaign-links/:id')
  async getLink(@Req() request: FastifyRequest, @Param('id') id: string) {
    const linkId = parse(idSchema, id);
    return mapStorefrontErrors(() => this.links.get(requireContext(request), linkId));
  }

  @RequireAbility('create', 'Storefront')
  @Post('campaign-links')
  async createLink(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(campaignLinkSchema, body);
    return mapStorefrontErrors(() => this.links.create(requireContext(request), input));
  }

  @RequireAbility('update', 'Storefront')
  @Put('campaign-links/:id')
  async updateLink(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const linkId = parse(idSchema, id);
    const input = parse(campaignLinkSchema, body);
    return mapStorefrontErrors(() => this.links.update(requireContext(request), linkId, input));
  }

  @RequireAbility('delete', 'Storefront')
  @Delete('campaign-links/:id')
  async deleteLink(@Req() request: FastifyRequest, @Param('id') id: string) {
    const linkId = parse(idSchema, id);
    return mapStorefrontErrors(() => this.links.remove(requireContext(request), linkId));
  }

  // --- tracking -------------------------------------------------------------------------------

  @RequireAbility('read', 'Storefront')
  @Get('tracking')
  async trackingSettings(@Req() request: FastifyRequest) {
    return mapStorefrontErrors(() => this.tracking.settings(requireContext(request)));
  }

  @RequireAbility('update', 'Storefront')
  @Put('tracking')
  async saveTracking(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(trackingSettingsSchema, body);
    return mapStorefrontErrors(() => this.tracking.save(requireContext(request), input));
  }

  @RequireAbility('read', 'Storefront')
  @Get('tracking/events')
  async trackingLog(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(logQuerySchema, query);
    return mapStorefrontErrors(() =>
      this.tracking.eventLog(requireContext(request), {
        limit: parsed.limit,
        ...(parsed.status === undefined ? {} : { status: parsed.status }),
        ...(parsed.eventName === undefined ? {} : { eventName: parsed.eventName }),
        ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
      }),
    );
  }
}

const SIGNED =
  'The brand website’s server has no session: a website key and an HMAC over the timestamp, method, path, query, idempotency key and body authenticate it (D-506, M35b).';

/**
 * Campaign links and tracking for the website's server (M35b, D-551, D-552;
 * `docs/storefront-api.md`), signed like every storefront route. The reads are cached like
 * the catalog's; the counters and the events are personal or moving and never cached.
 */
@Controller('storefront/v1')
@UseGuards(StorefrontSignatureGuard)
export class WebMarketingPublicController {
  constructor(
    private readonly links: CampaignLinksService,
    private readonly tracking: TrackingService,
  ) {}

  @Public(SIGNED)
  @Get('custom-links/:code')
  async customLink(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('code') code: string,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await cached(request, reply, () => this.links.forWebsite(orgId, code));
  }

  @Public(SIGNED)
  @AuditExempt('A view counter: one more view of a campaign link, nothing a person decided.')
  @Post('custom-links/:code/views')
  @HttpCode(200)
  async customLinkView(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('code') code: string,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () => this.links.countView(orgId, code));
  }

  @Public(SIGNED)
  @Get('tracking/config')
  async trackingConfig(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await cached(request, reply, () => this.tracking.clientConfig(orgId));
  }

  @Public(SIGNED)
  @AuditExempt('Browser events forwarded for Meta and GA4: logged in their own table (D-552).')
  @Post('events')
  @HttpCode(200)
  async events(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.tracking.ingest(orgId, parse(trackingEventsSchema, request.body)),
    );
  }
}
