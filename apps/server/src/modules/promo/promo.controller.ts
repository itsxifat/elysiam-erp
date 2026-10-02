import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { requireContext } from '../../platform/http/context.js';
import { mapPromoErrors } from './promo.errors.js';
import {
  createPromoCodeSchema,
  promoCheckSchema,
  promoIdParamSchema,
  promoListSchema,
  promoStatusSchema,
} from './promo.schemas.js';
import { PromoService } from './promo.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Promo codes over HTTP (architecture §10, §23; M16).
 *
 * **The subject is `LandingPage`**, and that is a decision rather than a transcription.
 * §6 has one row covering both — "Landing pages, promo codes" — so a brand's marketing
 * people hold the same grant for the thing and the codes that promote it, and inventing a
 * `PromoCode` subject would mean editing the permission matrix and its spec fixture as a
 * side effect of this milestone instead of as a decision (D-203).
 *
 * That row also distinguishes *applying* a code from *editing* one: §6 gives sales
 * `read LandingPage` — "apply codes", not edit pages — which is why the live check below
 * is a read and every write needs `update`. A desk agent can tell a buyer whether a code
 * works; only marketing can decide what it is worth.
 */
/** Why the promo routes apply no §6 row filter. */
const PROMO_HAS_NO_ROW_DIMENSION =
  'a promo code is the brand’s: it has no branch, owner or assignee to narrow by';

@Controller('v1/promo')
export class PromoController {
  constructor(private readonly promo: PromoService) {}

  @RequireAbility('read', 'LandingPage')
  @Get('codes')
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    // `branch_manager` holds `read LandingPage` at branch scope (§6); a code is not a
    // branch's, so the scope is satisfied by saying so rather than by a filter that would
    // 500 at the backstop (ledger audit W6).
    scopeHasNoRowDimension(request, PROMO_HAS_NO_ROW_DIMENSION);
    const filters = parse(promoListSchema, query);
    return mapPromoErrors(() =>
      this.promo.list(requireContext(request), {
        ...(filters.status === undefined ? {} : { status: filters.status }),
        limit: filters.limit,
      }),
    );
  }

  @RequireAbility('create', 'LandingPage')
  @Post('codes')
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createPromoCodeSchema, body);
    return mapPromoErrors(() =>
      this.promo.create(requireContext(request), auditable(request), input),
    );
  }

  /**
   * Pause, resume or archive. The terms never change after a code exists: they are what
   * buyers were told, and a redemption already recorded was computed from them.
   */
  @RequireAbility('update', 'LandingPage')
  @Patch('codes/:id')
  async setStatus(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const codeId = parse(promoIdParamSchema, id);
    const { status } = parse(promoStatusSchema, body);
    return mapPromoErrors(() =>
      this.promo.setStatus(requireContext(request), auditable(request), codeId, status),
    );
  }

  @RequireAbility('read', 'LandingPage')
  @Get('codes/:id/redemptions')
  async redemptions(@Req() request: FastifyRequest, @Param('id') id: string) {
    scopeHasNoRowDimension(request, PROMO_HAS_NO_ROW_DIMENSION);
    const codeId = parse(promoIdParamSchema, id);
    return mapPromoErrors(() => this.promo.redemptionsOf(requireContext(request), codeId, 100));
  }

  /**
   * The desk's live check: would this code work on this basket, and for how much.
   *
   * A POST because the basket is the question and a basket does not belong in a query
   * string, and a read because it changes nothing — no use is claimed here. The order's
   * own transaction asks again and redeems there, so a code that runs out between the
   * two is refused at the point that matters rather than at this one.
   */
  @RequireAbility('read', 'LandingPage')
  @Post('check')
  async check(@Req() request: FastifyRequest, @Body() body: unknown) {
    scopeHasNoRowDimension(request, PROMO_HAS_NO_ROW_DIMENSION);
    const input = parse(promoCheckSchema, body);
    return mapPromoErrors(() =>
      this.promo.check(requireContext(request), {
        code: input.code,
        lines: input.lines,
        deliveryChargePoisha: input.deliveryChargePoisha,
        channel: input.channel,
        customerId: input.customerId ?? null,
      }),
    );
  }
}
