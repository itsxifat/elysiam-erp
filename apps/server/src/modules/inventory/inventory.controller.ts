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
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { AdjustmentsService } from './adjustments.service.js';
import { CountsService } from './counts.service.js';
import { ReconcileService } from './reconcile.service.js';
import { StockService } from './stock.service.js';
import { TransfersService } from './transfers.service.js';
import { mapStockErrors } from './inventory.errors.js';
import { countScanSchema } from './stock-in-hand.schemas.js';
import {
  createLocationSchema,
  dispatchTransferSchema,
  movementQuerySchema,
  openCountSchema,
  recordCountsSchema,
  reconcileQuerySchema,
  requestAdjustmentSchema,
  setReorderLevelSchema,
  stockIdSchema,
  stockQuerySchema,
  updateLocationSchema,
} from './inventory.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

/**
 * The Fastify request as the audit net sees it.
 *
 * `AuditableRequest` is an index-signature type — the interceptor stashes its
 * bookkeeping on the request object — and `FastifyRequest` has no index signature,
 * so the cast is structural rather than a widening. Same helper the wallets
 * controller declares, for the same reason.
 */
const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Stock over HTTP (architecture §6, §8, §23).
 *
 * Every route declares an ability, and the split is §6's two stock rows exactly:
 *
 * * **`read Stock`** — everyone who works in the brand. Availability is operational
 *   information: an order desk agent needs to know whether the size is there, and a
 *   showroom manager needs to know whether another branch has it.
 * * **`read Cost`** — the valuation report and nothing else. Stock value is the one
 *   figure here that is cost information in its own right rather than a field that
 *   can be stripped from a larger response.
 * * **`request StockAdjustment` / `approve StockAdjustment`** — write-offs, gains and
 *   the counts that produce them. There is deliberately **no** `update Stock` route,
 *   for anybody: §6's matrix has no such grant, and invariant 3 says stock changes
 *   only through movements. An endpoint that set a level would be a path that must
 *   not exist, and building one because the permission seemed to invite it is the
 *   mistake the matrix comment warns about.
 *
 * Transfers sit under `request StockAdjustment` rather than under a subject of their
 * own. A transfer does not change what the brand owns — it moves it — but it does
 * take units off one branch's shelf, so the warehouse and branch-manager roles that
 * hold the adjustment grant are exactly the set that should be able to send stock.
 * Recorded as D-146.
 *
 * `SerializeInterceptor` reads each route's own `@RequireAbility` and runs
 * `serializeFor()` against it, so `wacPoisha`, `unitCostPoisha` and
 * `stockValuePoisha` leave only for a caller holding `read Cost` (invariant 5).
 */
@Controller('v1/inventory')
export class InventoryController {
  constructor(
    private readonly stock: StockService,
    private readonly adjustments: AdjustmentsService,
    private readonly transfers: TransfersService,
    private readonly counts: CountsService,
    private readonly reconcile: ReconcileService,
  ) {}

  // --- locations --------------------------------------------------------------

  @RequireAbility('read', 'Stock')
  @Get('locations')
  async locations(@Req() request: FastifyRequest, @Query('includeInactive') inactive?: string) {
    return this.stock.listLocations(requireContext(request), request, inactive === 'true');
  }

  @RequireAbility('create', 'Catalog')
  @Post('locations')
  async createLocation(@Req() request: FastifyRequest, @Body() body: unknown) {
    /*
     * `create Catalog`, not a stock grant.
     *
     * A location is part of an org's physical footprint (§8, D-046) — the same kind
     * of setup decision as a category or an attribute, and §6 gives those to
     * org_admin alone. There is no "create Location" cell in the matrix, and adding
     * one to `StockAdjustment` would have let the warehouse role invent locations,
     * which is how stock ends up somewhere nobody counts.
     */
    const input = parse(createLocationSchema, body);
    return this.stock.createLocation(requireContext(request), auditable(request), input);
  }

  @RequireAbility('update', 'Catalog')
  @Patch('locations/:id')
  async updateLocation(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const locationId = parse(stockIdSchema, id);
    const patch = parse(updateLocationSchema, body);
    return this.stock.updateLocation(
      requireContext(request),
      auditable(request),
      locationId,
      patch,
    );
  }

  // --- stock views ------------------------------------------------------------

  @RequireAbility('read', 'Stock')
  @Get('stock')
  async stockList(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(stockQuerySchema, query ?? {});
    return this.stock.listStock(requireContext(request), request, parsed);
  }

  @RequireAbility('read', 'Cost')
  @Get('valuation')
  async valuation(@Req() request: FastifyRequest, @Query('locationId') locationId?: string) {
    const location = locationId === undefined ? undefined : parse(stockIdSchema, locationId);
    return this.stock.valuation(requireContext(request), request, location);
  }

  @RequireAbility('read', 'Stock')
  @Get('movements')
  async movements(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(movementQuerySchema, query ?? {});
    return this.stock.listMovements(requireContext(request), request, parsed);
  }

  @RequireAbility('update', 'Catalog')
  @Put('reorder-levels')
  async setReorderLevel(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(setReorderLevelSchema, body);
    return this.stock.setReorderLevel(requireContext(request), auditable(request), input);
  }

  // --- adjustments ------------------------------------------------------------

  @RequireAbility('read', 'StockAdjustment')
  @Get('adjustments')
  async adjustmentList(@Req() request: FastifyRequest, @Query('status') status?: string) {
    return this.adjustments.list(requireContext(request), request, { status });
  }

  @RequireAbility('request', 'StockAdjustment')
  @Post('adjustments')
  async requestAdjustment(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(requestAdjustmentSchema, body);
    return mapStockErrors(() =>
      this.adjustments.request(requireContext(request), auditable(request), input),
    );
  }

  // --- transfers --------------------------------------------------------------

  @RequireAbility('read', 'Stock')
  @Get('transfers')
  async transferList(@Req() request: FastifyRequest, @Query('status') status?: string) {
    return this.transfers.list(requireContext(request), request, { status });
  }

  @RequireAbility('request', 'StockAdjustment')
  @Post('transfers')
  async dispatchTransfer(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(dispatchTransferSchema, body);
    return this.transfers.dispatch(requireContext(request), auditable(request), input);
  }

  @RequireAbility('request', 'StockAdjustment')
  @Post('transfers/:id/receive')
  async receiveTransfer(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.transfers.receive(
      requireContext(request),
      auditable(request),
      parse(stockIdSchema, id),
    );
  }

  // --- counts -----------------------------------------------------------------

  /*
   * Reading a count is `read Stock`, not `read StockAdjustment`.
   *
   * §6 gives the warehouse role `request StockAdjustment` and no read on it — the
   * write-off list carries `stockValuePoisha`, and a packer has no business with a
   * brand's stock valuation. But the warehouse is the role that *does* the counting,
   * and a count session it cannot read back is a screen that cannot exist.
   *
   * A count session is quantities and SKU codes: a snapshot, a counted number and
   * their difference. That is stock information, which every role that works in the
   * brand already sees, so these two routes sit under `read Stock`. The variance's
   * *value* appears only on the adjustments the close produces, which stay behind
   * `read StockAdjustment` (D-147).
   */
  @RequireAbility('read', 'Stock')
  @Get('counts')
  async countList(@Req() request: FastifyRequest) {
    return this.counts.list(requireContext(request), request);
  }

  @RequireAbility('read', 'Stock')
  @Get('counts/:id')
  async count(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.counts.get(requireContext(request), request, parse(stockIdSchema, id));
  }

  @RequireAbility('request', 'StockAdjustment')
  @Post('counts')
  async openCount(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(openCountSchema, body);
    return this.counts.open(requireContext(request), auditable(request), input);
  }

  @RequireAbility('request', 'StockAdjustment')
  @Put('counts/:id/lines')
  async recordCounts(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const sessionId = parse(stockIdSchema, id);
    const input = parse(recordCountsSchema, body);
    return this.counts.record(requireContext(request), auditable(request), sessionId, input);
  }

  /**
   * One scan on an open count (M38a, D-606): one more piece of the scanned SKU. Same
   * ability as typing a count, because it is the same act done with a scanner.
   */
  @RequireAbility('request', 'StockAdjustment')
  @Post('counts/:id/scans')
  async scanCount(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const sessionId = parse(stockIdSchema, id);
    const input = parse(countScanSchema, body);
    return this.counts.scan(requireContext(request), auditable(request), sessionId, input);
  }

  @RequireAbility('request', 'StockAdjustment')
  @Post('counts/:id/submit')
  async submitCount(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.counts.submit(
      requireContext(request),
      auditable(request),
      parse(stockIdSchema, id),
    );
  }

  @RequireAbility('request', 'StockAdjustment')
  @Post('counts/:id/close')
  async closeCount(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.counts.close(requireContext(request), auditable(request), parse(stockIdSchema, id));
  }

  // --- reconciliation ---------------------------------------------------------

  @RequireAbility('read', 'StockAdjustment')
  @Get('reconciliations')
  async reconciliations(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(reconcileQuerySchema, query ?? {});
    return this.reconcile.history(requireContext(request), request, parsed.limit);
  }
}
