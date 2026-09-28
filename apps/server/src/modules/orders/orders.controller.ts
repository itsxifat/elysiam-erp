import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { CustomersService } from './customers.service.js';
import { DocumentsService } from './documents.service.js';
import { OrdersService } from './orders.service.js';
import { mapOrderErrors } from './orders.errors.js';
import {
  assignOrderSchema,
  availabilityQuerySchema,
  cancelOrderSchema,
  confirmOrderSchema,
  createCustomerSchema,
  createOrderSchema,
  customerQuerySchema,
  deliverOrderSchema,
  documentQuerySchema,
  exchangeOrderSchema,
  holdOrderSchema,
  orderIdSchema,
  orderQuerySchema,
  recordAdvanceSchema,
  returnOrderSchema,
  shipOrderSchema,
  startReturnSchema,
  updateCustomerSchema,
  updateOrderSchema,
  upsertZoneSchema,
  zoneLookupSchema,
} from './orders.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

/**
 * The Fastify request as the audit net sees it.
 *
 * `AuditableRequest` is an index-signature type — the interceptor stashes its bookkeeping
 * on the request object — and `FastifyRequest` has no index signature, so the cast is
 * structural rather than a widening. Same helper the inventory and wallets controllers
 * declare, for the same reason.
 */
const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/** `occurredAt` arrives as an ISO string and every domain rule wants a `Date`. */
function at(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}

/**
 * Orders over HTTP (architecture §6, §9, §23).
 *
 * Which ability each route declares is the whole of §6's Orders row, and it is worth
 * reading as a list rather than route by route:
 *
 * * **`read Order`** — everything that shows an order or its documents. `sales` holds it
 *   at `own`, and §6's cell adds "the unassigned queue", which `orderScopeSql` renders as
 *   part of the WHERE rather than as a filter applied afterwards.
 * * **`create Order`** — taking an order, and raising an exchange. An exchange *is* a new
 *   order (§9): it creates the replacement and reverses the original's sale, so
 *   `create Order` is the honest grant. Declaring `update Order` instead would hand it to
 *   `warehouse`, whose cell is "pack, ship, returns" — a warehouse clerk able to reverse
 *   a delivered sale into a store credit is not what the matrix says.
 * * **`update Order`** — every transition, plus assign and claim. §6 gives `warehouse`
 *   this at `org` precisely so it can pack, ship and receive returns, and the domain
 *   state machine is what stops that grant from reaching confirm on a `pending` order or
 *   cancel on a `shipped` one.
 * * **`create Wallet`** — recording an advance. It is money arriving in a wallet and a
 *   journal posted against it (§7), so it belongs to the wallets row rather than to an
 *   order grant: `update Order` would have let every sales agent post into a till.
 *
 *   Read the matrix before assuming who that is. `create Wallet` is **`accounts` and
 *   super_admin only** — `org_admin` holds `read` and `update` on Wallet and not `create`
 *   — so an org admin cannot record an advance today. That is a gap in §6 rather than in
 *   this route, and it is left as a gap deliberately: widening the route to
 *   `update Wallet` would hand it to `branch_manager` at branch scope, and adding
 *   `create Wallet` to org_admin is a change to the matrix that needs a decision of its
 *   own. Recorded as a follow-up.
 * * **`read Stock`** — the availability read the order form makes before it promises a
 *   size. Exactly what the inventory controller uses for the same question, and `org`
 *   scope for every role that holds it, so there is nothing to narrow.
 *
 * There is no route that sets a status, for anybody: invariant 7 says an order moves
 * through the domain machine, and an endpoint that took a target status would be the hole
 * that makes the invariant unenforceable.
 *
 * `SerializeInterceptor` runs `serializeFor()` against each route's own
 * `@RequireAbility`, and the views in `orders.service.ts` carry no cost field for it to
 * strip — belt and braces in that order, not instead of each other (invariant 5).
 */
@Controller('v1/orders')
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly documents: DocumentsService,
  ) {}

  @RequireAbility('read', 'Order')
  @Get()
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(orderQuerySchema, query ?? {});
    return this.orders.list(requireContext(request), request, parsed);
  }

  /**
   * Availability for order entry, declared before `:id` so the word is not read as one.
   *
   * `read Stock` rather than `read Order`: it is a question about the shelf, the same one
   * `GET /v1/inventory/stock` answers, and answering it under an order grant would mean
   * two abilities governing one fact.
   */
  @RequireAbility('read', 'Stock')
  @Get('availability')
  async availability(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(availabilityQuerySchema, query ?? {});
    return this.orders.availability(requireContext(request), parsed);
  }

  @RequireAbility('create', 'Order')
  @Post()
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createOrderSchema, body);
    return this.orders.create(requireContext(request), auditable(request), input);
  }

  @RequireAbility('read', 'Order')
  @Get(':id')
  async get(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.orders.get(requireContext(request), request, parse(orderIdSchema, id));
  }

  @RequireAbility('update', 'Order')
  @Patch(':id')
  async edit(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const patch = parse(updateOrderSchema, body);
    return this.orders.edit(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      patch,
    );
  }

  // --- the transitions (§9) -----------------------------------------------------

  @RequireAbility('update', 'Order')
  @Post(':id/confirm')
  async confirm(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(confirmOrderSchema, body ?? {});
    return this.orders.confirm(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      input,
    );
  }

  @RequireAbility('update', 'Order')
  @Post(':id/hold')
  async hold(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(holdOrderSchema, body);
    return this.orders.transition(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      'hold',
      { reason: input.reason },
    );
  }

  @RequireAbility('update', 'Order')
  @Post(':id/release-hold')
  async releaseHold(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.orders.transition(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      'release_hold',
    );
  }

  @RequireAbility('update', 'Order')
  @Post(':id/cancel')
  async cancel(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(cancelOrderSchema, body);
    return this.orders.transition(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      'cancel',
      { reason: input.reason },
    );
  }

  @RequireAbility('update', 'Order')
  @Post(':id/pack')
  async pack(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.orders.transition(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      'pack',
    );
  }

  /**
   * Handover to a courier: the dispatch movements and §7's goods-in-transit journal.
   *
   * The consignment number is carried on the order's own history rather than on a column,
   * because there is no column until M12 registers couriers and parcels. It is recorded
   * rather than discarded: a desk that booked by hand has nothing else linking our order
   * to the courier's reference, and dropping the field the schema accepts would be worse
   * than putting it somewhere honest.
   */
  @RequireAbility('update', 'Order')
  @Post(':id/ship')
  async ship(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(shipOrderSchema, body ?? {});
    return this.orders.transition(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      'ship',
      {
        courierId: input.courierId ?? null,
        reason: input.consignmentNo === undefined ? null : `Consignment ${input.consignmentNo}`,
      },
    );
  }

  @RequireAbility('update', 'Order')
  @Post(':id/deliver')
  async deliver(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(deliverOrderSchema, body ?? {});
    if (input.lines !== undefined) {
      throw new BadRequestException(
        'A partial delivery goes to /partial-delivery, which posts only the delivered lines.',
      );
    }
    return this.orders.transition(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      'deliver',
      {
        deliver: {
          collectedPoisha: input.collectedPoisha,
          differenceReason: input.differenceReason,
        },
        ...(at(input.occurredAt) === undefined ? {} : { occurredAt: at(input.occurredAt) }),
      },
    );
  }

  /**
   * A partial delivery: the courier handed some units over and is bringing the rest back.
   *
   * Its own route rather than a shape of `deliver`, because the two land the order in
   * different statuses and post different journals, and a client that forgot the `lines`
   * field would otherwise have marked the whole parcel delivered (§7, check 5).
   */
  @RequireAbility('update', 'Order')
  @Post(':id/partial-delivery')
  async deliverPartially(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(deliverOrderSchema, body);
    if (input.lines === undefined) {
      throw new BadRequestException('A partial delivery needs the units that actually arrived.');
    }
    return this.orders.transition(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      'deliver_partially',
      {
        deliver: {
          collectedPoisha: input.collectedPoisha,
          differenceReason: input.differenceReason,
          lines: input.lines,
        },
        ...(at(input.occurredAt) === undefined ? {} : { occurredAt: at(input.occurredAt) }),
      },
    );
  }

  @RequireAbility('update', 'Order')
  @Post(':id/start-return')
  async startReturn(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(startReturnSchema, body ?? {});
    return this.orders.transition(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      'start_return',
      { reason: input.reason ?? null },
    );
  }

  @RequireAbility('update', 'Order')
  @Post(':id/receive-return')
  async receiveReturn(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(returnOrderSchema, body);
    return this.orders.transition(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      'receive_return',
      {
        reason: input.reason,
        ret: {
          reason: input.reason,
          locationId: input.locationId,
          damaged: input.damaged,
        },
        ...(at(input.occurredAt) === undefined ? {} : { occurredAt: at(input.occurredAt) }),
      },
    );
  }

  // --- the queue ----------------------------------------------------------------

  @RequireAbility('update', 'Order')
  @Post(':id/assign')
  async assign(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(assignOrderSchema, body);
    return this.orders.assign(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      input.assignedTo,
    );
  }

  @RequireAbility('update', 'Order')
  @Post(':id/claim')
  async claim(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.orders.claim(requireContext(request), auditable(request), parse(orderIdSchema, id));
  }

  // --- money and exchanges ------------------------------------------------------

  @RequireAbility('create', 'Wallet')
  @Post(':id/advance')
  async advance(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(recordAdvanceSchema, body);
    return this.orders.recordAdvance(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      input,
    );
  }

  @RequireAbility('create', 'Order')
  @Post(':id/exchange')
  async exchange(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(exchangeOrderSchema, body);
    return this.orders.exchange(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      input,
    );
  }

  // --- documents ----------------------------------------------------------------

  /**
   * The invoice or the packing slip, as a PDF (§22).
   *
   * `@Res()` and a manual send, because this is the one route here that does not return
   * JSON — which also means `SerializeInterceptor` never sees it. That is safe and worth
   * saying out loud: the renderer is given selling prices, quantities and an address, and
   * `orderByIdInScope` applies the caller's §6 scope before any of it is read, so the
   * bytes cannot contain an order the caller may not see or a cost nobody may.
   */
  @RequireAbility('read', 'Order')
  @Get(':id/document')
  async document(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ) {
    const { kind } = parse(documentQuerySchema, query ?? {});
    const rendered = await mapOrderErrors(() =>
      this.documents.render(requireContext(request), request, parse(orderIdSchema, id), kind),
    );
    await reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${rendered.filename}"`)
      .send(Buffer.from(rendered.bytes));
  }
}

/**
 * Buyers (architecture §9 "Customers", §6's customers row).
 *
 * §6 scopes `sales` to "customers of own orders", which has no column on
 * `sales.customers` to hang it on — the agent who first took someone's call does not own
 * the relationship. So the scope is applied as an EXISTS over the orders the caller
 * reaches, in `CustomersService`. See the comment there: mapping it onto a customer
 * column would have made "own" either meaningless or wrong.
 */
@Controller('v1/customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @RequireAbility('read', 'Customer')
  @Get()
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(customerQuerySchema, query ?? {});
    return this.customers.list(requireContext(request), request, parsed);
  }

  @RequireAbility('create', 'Customer')
  @Post()
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createCustomerSchema, body);
    return this.customers.create(requireContext(request), auditable(request), input);
  }

  @RequireAbility('read', 'Customer')
  @Get(':id')
  async get(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.customers.get(requireContext(request), request, parse(orderIdSchema, id));
  }

  @RequireAbility('update', 'Customer')
  @Patch(':id')
  async update(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const patch = parse(updateCustomerSchema, body);
    return this.customers.update(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
      patch,
    );
  }
}

/**
 * Delivery zones, charges and couriers (§9, D-009).
 *
 * `read Catalog` and `update Catalog`, not an order grant. A zone is org configuration of
 * the same kind as a category or a location — §6 has no "Zone" cell, and the inventory
 * controller already puts locations and reorder levels under the catalog grants for
 * exactly this reason (D-146's shape). It also settles the scope cleanly: every role that
 * holds `read Catalog` holds it at `org`, so there is nothing to narrow on a table with
 * no `created_by` and no `branch_id`.
 *
 * D-009 is still OPEN, so the charges are the assumed placeholders migration 0042 seeds
 * and `PUT /v1/delivery-zones` is how an org replaces them without a deploy.
 */
@Controller('v1/delivery-zones')
export class DeliveryZonesController {
  constructor(private readonly orders: OrdersService) {}

  @RequireAbility('read', 'Catalog')
  @Get()
  async list(@Req() request: FastifyRequest) {
    return this.orders.zones(requireContext(request));
  }

  /** The zone and charge that cover one address, for the order form. */
  @RequireAbility('read', 'Catalog')
  @Get('for-area')
  async forArea(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(zoneLookupSchema, query ?? {});
    return this.orders.zoneFor(requireContext(request), parsed);
  }

  @RequireAbility('update', 'Catalog')
  @Put()
  async upsert(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(upsertZoneSchema, body);
    return this.orders.upsertZone(requireContext(request), auditable(request), input);
  }
}
