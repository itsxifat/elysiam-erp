import { BadRequestException, Body, Controller, Param, Patch, Post, Req } from '@nestjs/common';
import {
  customerMergeSchema,
  customerPhoneAddSchema,
  customerPhoneRetireSchema,
  customerPhoneUpdateSchema,
  orderBuyerChangeSchema,
} from '@elysium/contracts/customers';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { CustomerNumbersService } from './numbers.service.js';

const id = z.string().uuid();

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * A buyer's numbers and merging two records of one person (M48, D-870 to D-886).
 *
 * `update Customer`, the grant that already says who may change a buyer: org_admin and marketing
 * at `org`, a branch manager at `branch`, sales for buyers of their own orders (D-886: no role
 * gains anything). The buyer's reach is checked in the service as `PATCH /v1/customers/:id`
 * checks it. Merging is a supervisor's on top (org_admin, branch_manager), checked there too.
 */
@Controller('v1/customers')
export class CustomerNumbersController {
  constructor(private readonly numbers: CustomerNumbersService) {}

  @RequireAbility('update', 'Customer')
  @Post(':id/phones')
  async add(
    @Req() request: FastifyRequest,
    @Param('id') customerId: string,
    @Body() body: unknown,
  ) {
    return this.numbers.add(
      requireContext(request),
      auditable(request),
      parse(id, customerId),
      parse(customerPhoneAddSchema, body),
    );
  }

  @RequireAbility('update', 'Customer')
  @Patch(':id/phones/:phoneId')
  async update(
    @Req() request: FastifyRequest,
    @Param('id') customerId: string,
    @Param('phoneId') phoneId: string,
    @Body() body: unknown,
  ) {
    return this.numbers.update(
      requireContext(request),
      auditable(request),
      parse(id, customerId),
      parse(id, phoneId),
      parse(customerPhoneUpdateSchema, body),
    );
  }

  @RequireAbility('update', 'Customer')
  @Post(':id/phones/:phoneId/retire')
  async retire(
    @Req() request: FastifyRequest,
    @Param('id') customerId: string,
    @Param('phoneId') phoneId: string,
    @Body() body: unknown,
  ) {
    return this.numbers.retire(
      requireContext(request),
      auditable(request),
      parse(id, customerId),
      parse(id, phoneId),
      parse(customerPhoneRetireSchema, body),
    );
  }

  @RequireAbility('update', 'Customer')
  @Post(':id/merge')
  async merge(
    @Req() request: FastifyRequest,
    @Param('id') customerId: string,
    @Body() body: unknown,
  ) {
    return this.numbers.merge(
      requireContext(request),
      auditable(request),
      parse(id, customerId),
      parse(customerMergeSchema, body),
    );
  }
}

/**
 * An order's buyer (M48, D-876, D-882). `update Order` and the route's own row scope: changing the
 * buyer is a supervisor's on top; "the buyer is right" is anyone's who may work the order.
 */
@Controller('v1/orders')
export class OrderBuyerController {
  constructor(private readonly numbers: CustomerNumbersService) {}

  @RequireAbility('update', 'Order')
  @Post(':id/buyer')
  async changeBuyer(
    @Req() request: FastifyRequest,
    @Param('id') orderId: string,
    @Body() body: unknown,
  ) {
    return this.numbers.changeBuyer(
      requireContext(request),
      auditable(request),
      parse(id, orderId),
      parse(orderBuyerChangeSchema, body),
    );
  }

  @RequireAbility('update', 'Order')
  @Post(':id/buyer-checked')
  async buyerChecked(@Req() request: FastifyRequest, @Param('id') orderId: string) {
    return this.numbers.buyerChecked(
      requireContext(request),
      auditable(request),
      parse(id, orderId),
    );
  }
}
