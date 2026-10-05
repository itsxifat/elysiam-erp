import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { marketplaceSettingsSchema } from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { MarketplaceSettingsService } from './marketplace-settings.service.js';

const idSchema = z.string().uuid('No such record.');
const holdQuerySchema = z
  .object({ state: z.enum(['held', 'released', 'converted']).optional() })
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
 * Website → Marketplace (M35b, D-553): the ncom.bd connection.
 *
 * Reading is the Website section's `read Storefront`. Changing the connection, and giving back a
 * hold ncom never released, is `update WebsiteCredentials`, org_admin only (D-528's reasoning:
 * the secrets let ncom take orders and hold stock).
 */
@Controller('v1/marketplace')
export class MarketplaceController {
  constructor(private readonly settings: MarketplaceSettingsService) {}

  @RequireAbility('read', 'Storefront')
  @Get('ncom')
  async view(@Req() request: FastifyRequest) {
    return this.settings.view(requireContext(request));
  }

  @RequireAbility('update', 'WebsiteCredentials')
  @Put('ncom')
  async save(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(marketplaceSettingsSchema, body);
    return this.settings.save(requireContext(request), input);
  }

  @RequireAbility('read', 'Storefront')
  @Get('ncom/holds')
  async holds(@Req() request: FastifyRequest, @Query() query: unknown) {
    const { state } = parse(holdQuerySchema, query);
    return this.settings.holds(requireContext(request), state);
  }

  @RequireAbility('update', 'WebsiteCredentials')
  @Post('ncom/holds/:id/release')
  async releaseHold(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.settings.releaseHold(requireContext(request), parse(idSchema, id));
  }

  @RequireAbility('read', 'Storefront')
  @Get('ncom/orders')
  async orders(@Req() request: FastifyRequest) {
    return this.settings.handedOver(requireContext(request));
  }
}
