import { Controller, Get, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { serializeForStorefront } from '@elysium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Public } from '../../platform/auth/abilities.js';
import { mapStorefrontErrors } from './storefront.errors.js';
import { StorefrontPublicService } from './storefront-public.service.js';
import { SiteCache } from './site-cache.js';
import { StorefrontSignatureGuard, storefrontSiteOf } from './signature.guard.js';
import { etagOf } from './signature.js';

const SIGNED =
  'The brand website’s server has no session: a website key and an HMAC over the timestamp, method, path and query authenticate it (D-506).';

/**
 * The signed storefront read API, `/storefront/v1/*` (M33, D-506; `docs/storefront-api.md`).
 *
 * Server to server only: the brand's website calls it from its own server with a website key,
 * and shoppers' browsers never do (they get pages and `/media/` images). `@Public` because
 * there is no session; `StorefrontSignatureGuard` is what authenticates, before any handler.
 *
 * Every answer leaves through `serializeForStorefront` — an allow-list at every depth, then
 * the cost deny-list — with a strong `ETag` over the bytes and `Cache-Control: private,
 * max-age=30, stale-while-revalidate=300`. Private, because the answer is to a signed request
 * and a shared cache in front of the ERP would hand it to anyone without one (D-506). A
 * matching `If-None-Match` is a 304 with no body.
 */
@Controller('storefront/v1')
@UseGuards(StorefrontSignatureGuard)
export class StorefrontPublicController {
  constructor(
    private readonly storefront: StorefrontPublicService,
    private readonly cache: SiteCache,
  ) {}

  @Public(SIGNED)
  @Get('catalog/products')
  async products(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query() query: Record<string, string | undefined>,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    const payload = await mapStorefrontErrors(() => this.storefront.products(orgId, query));
    await send(request, reply, render(payload));
  }

  @Public(SIGNED)
  @Get('catalog/products/:slug')
  async product(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('slug') slug: string,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    const payload = await mapStorefrontErrors(() => this.storefront.product(orgId, slug));
    await send(request, reply, render(payload));
  }

  @Public(SIGNED)
  @Get('catalog/categories')
  async categories(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    const payload = await mapStorefrontErrors(() => this.storefront.categories(orgId));
    await send(request, reply, render(payload));
  }

  @Public(SIGNED)
  @Get('catalog/search')
  async search(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('q') q: string | undefined,
    @Query('limit') limit: string | undefined,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    const payload = await mapStorefrontErrors(() => this.storefront.search(orgId, q, limit));
    await send(request, reply, render(payload));
  }

  /** Cached for thirty seconds per brand in the process (`SiteCache`), forgotten on a write. */
  @Public(SIGNED)
  @Get('site')
  async site(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    let body = this.cache.get(orgId);
    if (body === undefined) {
      body = render(await mapStorefrontErrors(() => this.storefront.site(orgId)));
      this.cache.set(orgId, body);
    }
    await send(request, reply, body);
  }

  @Public(SIGNED)
  @Get('size-charts/:id')
  async sizeChart(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    const payload = await mapStorefrontErrors(() => this.storefront.sizeChart(orgId, id));
    await send(request, reply, render(payload));
  }

  /** For M34's checkout: the district and thana pickers couriers need. */
  @Public(SIGNED)
  @Get('geo/districts')
  async districts(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    const payload = await mapStorefrontErrors(() => this.storefront.districts(orgId));
    await send(request, reply, render(payload));
  }

  @Public(SIGNED)
  @Get('geo/thanas')
  async thanas(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('districtId') districtId: string | undefined,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    const payload = await mapStorefrontErrors(() => this.storefront.thanas(orgId, districtId));
    await send(request, reply, render(payload));
  }
}

/** The one way an answer leaves: the storefront allow-list, then JSON. */
function render(payload: unknown): string {
  return JSON.stringify(serializeForStorefront(payload));
}

async function send(request: FastifyRequest, reply: FastifyReply, body: string): Promise<void> {
  const etag = etagOf(body);
  void reply
    .header('cache-control', 'private, max-age=30, stale-while-revalidate=300')
    .header('etag', etag)
    .header('vary', 'x-api-key');
  const asked = request.headers['if-none-match'];
  const matches =
    typeof asked === 'string' &&
    asked.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag);
  if (matches) {
    await reply.code(304).send();
    return;
  }
  await reply.header('content-type', 'application/json; charset=utf-8').send(body);
}
