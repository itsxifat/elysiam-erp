import { BadRequestException, Body, Controller, Put, Req } from '@nestjs/common';
import { bulkProductWebFieldsSchema } from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';

import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { mapStorefrontErrors } from './storefront.errors.js';
import { StorefrontService } from './storefront.service.js';

/**
 * The product list's website switches for many products at once (M39b, D-642): show or hide
 * them, or give them one size chart. `update Storefront`, like one product's Website card
 * (D-508): marketing decides what the website shows.
 */
@Controller('v1/storefront')
export class StorefrontBulkController {
  constructor(private readonly storefront: StorefrontService) {}

  @RequireAbility('update', 'Storefront')
  @Put('products')
  async productsWebFields(@Req() request: FastifyRequest, @Body() body: unknown) {
    const parsed = bulkProductWebFieldsSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    return mapStorefrontErrors(() =>
      this.storefront.setProductsWebFields(requireContext(request), parsed.data),
    );
  }
}
