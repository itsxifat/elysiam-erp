import {
  BadRequestException,
  Body,
  Controller,
  Delete,
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
import { requireContext } from '../../platform/http/context.js';
import { stockIdSchema } from './inventory.schemas.js';
import { LookupService } from './lookup.service.js';
import { StockInHandService } from './stock-in-hand.service.js';
import {
  closeWindowSchema,
  createStockInHandSchema,
  lookupQuerySchema,
  postStockInHandSchema,
  reopenWindowSchema,
  reverseStockInHandSchema,
  stockInHandDraftSchema,
  stockInHandListSchema,
  updateStockInHandDraftSchema,
} from './stock-in-hand.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Stock in hand at the start, and its window, over HTTP (M38a, D-602).
 *
 * The abilities are supply's split (D-005, D-122), because stock in hand is supply's
 * shape without a supplier:
 *
 * - **`create Supply`** reads and writes **drafts**: warehouse, accounts and org_admin.
 *   The draft schemas carry no cost field; a warehouse clerk counts pieces in.
 * - **`read Cost`** prices and posts, and asks to reverse a posted entry (an approval an
 *   org admin decides): org_admin and accounts. The service checks `canReadCost` again.
 * - **`update Supply`** deletes a draft (the matrix grants `delete Supply` to nobody, so
 *   declaring it would make the route unreachable, as supply's own draft delete says).
 * - The window: **`read Stock`** reads it (everyone who works with stock sees whether
 *   opening stock is still being taken); **`approve StockAdjustment`** closes it and asks
 *   to reopen it, which §6 gives to org_admin alone: like a write-off, it decides what
 *   stock the books may take in without a supplier.
 *
 * `SerializeInterceptor` runs `serializeFor` on every answer, so `unitCostPoisha` and
 * `stockValuePoisha` leave only for a caller holding `read:cost` (invariant 5).
 */
@Controller('v1/inventory/stock-in-hand')
export class StockInHandController {
  constructor(private readonly stockInHand: StockInHandService) {}

  // --- the window -----------------------------------------------------------------------

  @RequireAbility('read', 'Stock')
  @Get('window')
  async window(@Req() request: FastifyRequest) {
    return this.stockInHand.window(requireContext(request));
  }

  @RequireAbility('approve', 'StockAdjustment')
  @Post('window/close')
  async closeWindow(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(closeWindowSchema, body ?? {});
    return this.stockInHand.close(requireContext(request), auditable(request), input);
  }

  @RequireAbility('approve', 'StockAdjustment')
  @Post('window/reopen')
  async reopenWindow(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(reopenWindowSchema, body);
    return this.stockInHand.requestReopen(requireContext(request), auditable(request), input);
  }

  // --- entries --------------------------------------------------------------------------

  @RequireAbility('create', 'Supply')
  @Get()
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(stockInHandListSchema, query ?? {});
    return this.stockInHand.list(requireContext(request), request, parsed);
  }

  @RequireAbility('create', 'Supply')
  @Get(':id')
  async detail(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.stockInHand.detail(requireContext(request), request, parse(stockIdSchema, id));
  }

  /** Enter and post, with a cost per piece on every line. */
  @RequireAbility('read', 'Cost')
  @Post()
  async createAndPost(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createStockInHandSchema, body);
    return this.stockInHand.createAndPost(requireContext(request), auditable(request), input);
  }

  @RequireAbility('read', 'Cost')
  @Post(':id/post')
  async post(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const entryId = parse(stockIdSchema, id);
    const input = parse(postStockInHandSchema, body);
    return this.stockInHand.post(requireContext(request), auditable(request), entryId, input);
  }

  /**
   * Ask to take a posted entry back out: an approval for an org admin who did not ask
   * (D-602). `read Cost`, like posting it: whoever may credit equity with stock may ask to
   * debit it back, and a second person decides.
   */
  @RequireAbility('read', 'Cost')
  @Post(':id/reverse')
  async reverse(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const entryId = parse(stockIdSchema, id);
    const input = parse(reverseStockInHandSchema, body);
    return this.stockInHand.requestReversal(
      requireContext(request),
      auditable(request),
      entryId,
      input,
    );
  }

  // --- drafts (quantities only) ---------------------------------------------------------

  @RequireAbility('create', 'Supply')
  @Post('drafts')
  async createDraft(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(stockInHandDraftSchema, body);
    return this.stockInHand.createDraft(requireContext(request), auditable(request), input);
  }

  @RequireAbility('update', 'Supply')
  @Patch('drafts/:id')
  async updateDraft(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const entryId = parse(stockIdSchema, id);
    const patch = parse(updateStockInHandDraftSchema, body);
    return this.stockInHand.updateDraft(
      requireContext(request),
      auditable(request),
      entryId,
      patch,
    );
  }

  @RequireAbility('update', 'Supply')
  @Delete('drafts/:id')
  async deleteDraft(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.stockInHand.deleteDraft(
      requireContext(request),
      auditable(request),
      parse(stockIdSchema, id),
    );
  }
}

/**
 * `GET /v1/catalog/lookup?code=` (M38a, D-605): what a scanned sticker is.
 *
 * `read Catalog`: every role that sees the catalog may resolve a code to its product. The
 * stock part needs `read Stock` and the cost part `read:cost`; both are decided in
 * `LookupService` and stripped again by `serializeFor`.
 */
@Controller('v1/catalog')
export class LookupController {
  constructor(private readonly lookup: LookupService) {}

  @RequireAbility('read', 'Catalog')
  @Get('lookup')
  async byCode(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(lookupQuerySchema, query ?? {});
    return this.lookup.lookup(requireContext(request), parsed.code);
  }
}
