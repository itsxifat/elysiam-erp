import { BadRequestException, Controller, Get, Query, Req } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { RequireAbility } from '../../platform/auth/abilities.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import { requireContext } from '../../platform/http/context.js';
import { mapStockErrors } from './inventory.errors.js';
import * as repo from './inventory.repository.js';

const productStockQuerySchema = z
  .object({
    productIds: z
      .string()
      .max(100 * 37)
      .transform((text) => text.split(',').filter((id) => id !== ''))
      .pipe(z.array(z.string().uuid('No such record.')).min(1).max(100)),
  })
  .strict();

/**
 * `GET /v1/inventory/stock/products?productIds=…` (M39b, D-642): pieces on hand and free to
 * sell per product, for the product list's stock column. `read Stock`, inside the caller's
 * branch scope like the stock page (a branch manager sees their showroom's pieces). Quantities
 * only: nothing here is a cost (invariant 5).
 */
@Controller('v1/inventory')
export class ProductStockController {
  @RequireAbility('read', 'Stock')
  @Get('stock/products')
  async totals(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = productStockQuerySchema.safeParse(query ?? {});
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
    const context = requireContext(request);
    const scope = scopeWhere(request, { branchId: sql`l.branch_id` });
    return mapStockErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const rows = await repo.productStockTotals(tx, context.orgId, {
          scope,
          productIds: parsed.data.productIds,
        });
        return {
          items: rows.map((row) => ({
            productId: row.product_id,
            onHand: row.on_hand,
            available: row.available,
          })),
        };
      }),
    );
  }
}
