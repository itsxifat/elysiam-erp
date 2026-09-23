import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';

/**
 * A resource that carries cost, so the matrix has something real to be tested
 * against (M02b checks 1 and 2).
 *
 * Every assertion about "cost does not reach sales" is worth exactly as much as
 * the thing it is asserted against. Against a mock it proves the mock; against
 * this it goes through the same RLS, the same guard and the same serializer as
 * everything that comes after.
 *
 * **Temporary.** M06 brings the real catalog, which carries cost for genuine
 * reasons, and the matrix suite moves onto it. Dropping `demo` is part of M06
 * and is logged as a follow-up so the deletion is somebody's job.
 */
@Controller('v1/demo/costed-items')
export class DemoController {
  @RequireAbility('read', 'CostedItem')
  @Get()
  async list(@Req() request: FastifyRequest) {
    const context = requireContext(request);

    const rows = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
      tx.execute<{
        id: string;
        sku: string;
        name: string;
        unit_cost_poisha: string;
        sell_price_poisha: string;
        available_qty: number;
      }>(sql`
        select id, sku, name, unit_cost_poisha, sell_price_poisha, available_qty
        from demo.costed_items
        order by sku
      `),
    );

    const items = [...rows].map((row) => ({
      id: row.id,
      sku: row.sku,
      name: row.name,
      unitCostPoisha: row.unit_cost_poisha,
      sellPricePoisha: row.sell_price_poisha,
      availableQty: row.available_qty,
    }));

    // Returned raw on purpose. `SerializeInterceptor` strips what this caller
    // may not read, using the subject from this route's own @RequireAbility —
    // so the protection is a property of the application rather than something
    // each handler remembers. A handler that called `serializeFor` itself would
    // pass its own test and prove nothing about the next handler.
    return { items };
  }

  @RequireAbility('create', 'CostedItem')
  @Post()
  async create(@Req() request: FastifyRequest, @Body() body: { sku?: string; name?: string }) {
    const context = requireContext(request);

    const rows = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
      tx.execute<{ id: string }>(sql`
        insert into demo.costed_items (org_id, sku, name, unit_cost_poisha, sell_price_poisha)
        values (${context.orgId}, ${body.sku ?? 'SKU'}, ${body.name ?? 'Item'}, 100000, 250000)
        returning id
      `),
    );

    return { id: rows[0]?.id };
  }
}
