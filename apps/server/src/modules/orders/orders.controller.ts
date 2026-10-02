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
import { BuyersService } from './buyers.service.js';
import { CustomersService } from './customers.service.js';
import { DeskService } from './desk.service.js';
import { DocumentsService } from './documents.service.js';
import { BuyerProfileService } from './profile.service.js';
import { ReengagementService } from './reengagement.service.js';
import { OrdersService } from './orders.service.js';
import { mapOrderErrors } from './orders.errors.js';
import {
  assignOrderSchema,
  availabilityQuerySchema,
  bulkConfirmSchema,
  bulkDocumentQuerySchema,
  bulkTransitionSchema,
  buyerExportQuerySchema,
  buyerQuerySchema,
  cancelOrderSchema,
  confirmOrderSchema,
  createCustomerSchema,
  createOrderSchema,
  customerLookupSchema,
  customerQuerySchema,
  deliverOrderSchema,
  documentQuerySchema,
  duplicatesQuerySchema,
  exchangeOrderSchema,
  holdOrderSchema,
  orderIdSchema,
  orderQuerySchema,
  reengagementExportQuerySchema,
  reengagementQuerySchema,
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
 * * **Advances** are `advances.controller.ts`'s (M17, D-235): an agent records a claim under
 *   `update Order`, and only `create Wallet` (accounts) verifies, rejects or refunds one,
 *   because verification is money arriving in a wallet and a journal posted against it.
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
    private readonly desk: DeskService,
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

  // --- the order desk (M11) -----------------------------------------------------

  /**
   * The duplicate warning: has this number ordered one of these SKUs in the last day?
   *
   * `read Order`, and brand-wide on purpose — the duplicate that costs money is the one a
   * colleague took — with every order outside the caller's scope reduced to its number,
   * status and time. See `DeskService.duplicates`.
   */
  @RequireAbility('read', 'Order')
  @Get('duplicates')
  async duplicates(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(duplicatesQuerySchema, query ?? {});
    return this.desk.duplicates(requireContext(request), request, parsed);
  }

  /** The people who act on orders, for the agent filter and the timeline's names. */
  @RequireAbility('read', 'Order')
  @Get('agents')
  async agents(@Req() request: FastifyRequest) {
    return this.desk.agents(requireContext(request), request);
  }

  /**
   * Confirm up to a hundred orders, each in its own transaction (M11 bulk confirm).
   *
   * `update Order`, the grant a single confirm declares, and every order in the batch goes
   * through the same scope lock a single confirm does — a batch is
   * a loop over the one path, not a second path.
   */
  @RequireAbility('update', 'Order')
  @Post('bulk-confirm')
  async bulkConfirm(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(bulkConfirmSchema, body);
    return this.desk.bulkConfirm(requireContext(request), auditable(request), input.ids);
  }

  /**
   * Pack or ship up to a hundred orders, each in its own transaction (D-393).
   *
   * `update Order`, the grant each single transition declares, and every order goes through
   * the single-order path — a batch is a loop over the one path, as bulk confirm is.
   */
  @RequireAbility('update', 'Order')
  @Post('bulk-transition')
  async bulkTransition(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(bulkTransitionSchema, body);
    return this.desk.bulkTransition(
      requireContext(request),
      auditable(request),
      input.ids,
      input.trigger,
    );
  }

  /**
   * Bulk print: invoices, packing slips or labels for many orders, as one PDF.
   *
   * The same reasoning as the single-order document below about `@Res()` and the
   * serializer: the bytes are built from selling prices and addresses, after every id has
   * been through the caller's scope.
   */
  @RequireAbility('read', 'Order')
  @Get('documents')
  async documentsFor(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ) {
    const { ids, kind } = parse(bulkDocumentQuerySchema, query ?? {});
    const rendered = await mapOrderErrors(() =>
      this.documents.renderMany(requireContext(request), request, ids, kind),
    );
    await reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', `inline; filename="${rendered.filename}"`)
      .send(Buffer.from(rendered.bytes));
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
    parse(confirmOrderSchema, body ?? {});
    return this.orders.confirm(
      requireContext(request),
      auditable(request),
      parse(orderIdSchema, id),
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
          shortfallNeedsReason: true,
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
          shortfallNeedsReason: true,
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
        returnReason: input.returnReason,
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
  constructor(
    private readonly customers: CustomersService,
    private readonly desk: DeskService,
    private readonly profiles: BuyerProfileService,
  ) {}

  @RequireAbility('read', 'Customer')
  @Get()
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(customerQuerySchema, query ?? {});
    return this.customers.list(requireContext(request), request, parsed);
  }

  /**
   * The order desk's phone lookup (M11): buyer, addresses and recent orders in one call.
   *
   * 200 with `customer: null` for a number nobody has used *and* for a buyer outside the
   * caller's reach, rather than a 404: a new buyer is the ordinary case at the desk, and a
   * status code that meant "not yours" would be the oracle `assertReachable` exists to
   * deny.
   */
  @RequireAbility('read', 'Customer')
  @Get('lookup')
  async lookup(@Req() request: FastifyRequest, @Query() query: unknown) {
    const { phone } = parse(customerLookupSchema, query ?? {});
    return this.desk.lookup(requireContext(request), request, phone);
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

  /**
   * The buyer profile (M16; §10 "Buyer stats"): totals, segment, favourites, greetings
   * and the caller's own recent orders. The same reach as `GET :id`; see the service.
   */
  @RequireAbility('read', 'Customer')
  @Get(':id/profile')
  async profile(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.profiles.profile(requireContext(request), request, parse(orderIdSchema, id));
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
  constructor(
    private readonly orders: OrdersService,
    private readonly desk: DeskService,
  ) {}

  @RequireAbility('read', 'Catalog')
  @Get()
  async list(@Req() request: FastifyRequest) {
    return this.orders.zones(requireContext(request));
  }

  /**
   * Every thana, its district and the zone that covers it (M11 address autocomplete).
   *
   * The whole list in one response, filtered in the browser: see `areasWithZones`.
   */
  @RequireAbility('read', 'Catalog')
  @Get('areas')
  async areas(@Req() request: FastifyRequest) {
    return this.desk.areas(requireContext(request));
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

/**
 * The buyer list and its export (M11 Build list; acceptance check 2).
 *
 * `export BuyerExport` on both routes — the page as well as the file — because §6 gives the
 * list to org_admin and marketing and to nobody who takes orders, and a page of phone
 * numbers is an export by another name. The file is sent with `@Res()`, like the order
 * documents, so the serializer does not see it; what it contains is decided by the same
 * query the page runs, and the service audits every export.
 */
@Controller('v1/buyers')
export class BuyersController {
  constructor(private readonly buyers: BuyersService) {}

  @RequireAbility('export', 'BuyerExport')
  @Get()
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(buyerQuerySchema, query ?? {});
    return this.buyers.list(requireContext(request), request, parsed);
  }

  @RequireAbility('export', 'BuyerExport')
  @Get('export')
  async export(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ) {
    const parsed = parse(buyerExportQuerySchema, query ?? {});
    const file = await this.buyers.export(requireContext(request), request, parsed);
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      // The count travels beside the file so a client can show "1,204 buyers exported"
      // without parsing a spreadsheet, and so a test can compare it with the database.
      .header('x-row-count', String(file.rows))
      .header('cache-control', 'no-store')
      .send(file.bytes);
  }
}

/**
 * The re-engagement list and its export (M16; §10 "Re-engagement lists").
 *
 * `export BuyerExport` on both routes, for the reason `BuyersController` gives: a page of
 * phone numbers is an export by another name, and this is the same list cut a different
 * way. The file goes out with `@Res()` beside its row count, like the buyer export.
 */
@Controller('v1/crm/reengagement')
export class ReengagementController {
  constructor(private readonly reengagement: ReengagementService) {}

  @RequireAbility('export', 'BuyerExport')
  @Get()
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(reengagementQuerySchema, query ?? {});
    return this.reengagement.list(requireContext(request), request, parsed);
  }

  @RequireAbility('export', 'BuyerExport')
  @Get('export')
  async export(
    @Req() request: FastifyRequest,
    @Query() query: unknown,
    @Res() reply: FastifyReply,
  ) {
    const parsed = parse(reengagementExportQuerySchema, query ?? {});
    const file = await this.reengagement.export(requireContext(request), request, parsed);
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `attachment; filename="${file.filename}"`)
      .header('x-row-count', String(file.rows))
      .header('cache-control', 'no-store')
      .send(file.bytes);
  }
}
