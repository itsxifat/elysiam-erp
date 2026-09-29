import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
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
import { BranchesService } from './branches.service.js';
import { mapPosErrors } from './pos.errors.js';
import {
  branchClosingSchema,
  catalogPageSchema,
  closeShiftSchema,
  createRegisterSchema,
  dateSchema,
  idParamSchema,
  openShiftSchema,
  promoCheckSchema,
  rangeSchema,
  resolveReviewSchema,
  reviewListSchema,
  shiftListSchema,
  syncSchema,
  updateRegisterSchema,
} from './pos.schemas.js';
import { RegistersService } from './registers.service.js';
import { ReviewsService } from './reviews.service.js';
import { ShiftsService } from './shifts.service.js';
import { SyncService } from './sync.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * The showroom POS over HTTP (architecture §14, §23).
 *
 * Which ability each route declares is the milestone's role matrix, and §6 has no
 * POS row, so this reads it off the rows that do exist (decision row; a `PosSale`
 * subject is proposed for integration):
 *
 * - Anything that **moves till money** — opening and closing a shift, syncing
 *   sales and returns, resolving a review, closing a branch day, configuring a
 *   register's wallets — is `update Wallet`, exactly as M08's cash entries and
 *   closings are: org_admin and accounts org-wide, a branch manager for their own
 *   branch. Every handler then asserts the register's or branch's row scope.
 * - **Reading** till documents is `read Wallet`, with the same scope.
 * - The **price list** is `read Catalog`: selling prices, no cost.
 * - The **branch dashboards** are `read LedgerReport` — §6's "branch P&L without
 *   cost detail" — with cost fields stripped by `serializeFor` (D-014).
 *
 * The discount ceiling is not a route ability at all: it is enforced per sale by
 * the sync, which holds anything above the seller's ceiling for a manager.
 */
@Controller('v1/pos')
export class PosController {
  constructor(
    private readonly registers: RegistersService,
    private readonly shifts: ShiftsService,
    private readonly syncs: SyncService,
    private readonly reviews: ReviewsService,
    private readonly branches: BranchesService,
  ) {}

  // --- registers ----------------------------------------------------------------

  @RequireAbility('read', 'Wallet')
  @Get('registers')
  async listRegisters(@Req() request: FastifyRequest) {
    return mapPosErrors(() => this.registers.list(requireContext(request), request));
  }

  @RequireAbility('update', 'Wallet')
  @Post('registers')
  async createRegister(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createRegisterSchema, body);
    return mapPosErrors(() =>
      this.registers.create(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('update', 'Wallet')
  @Patch('registers/:id')
  async updateRegister(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const registerId = parse(idParamSchema, id);
    const patch = parse(updateRegisterSchema, body);
    return mapPosErrors(() =>
      this.registers.update(requireContext(request), auditable(request), registerId, patch),
    );
  }

  /** What a till caches before it can sell: register, shift, ceiling, receipt header. */
  @RequireAbility('read', 'Wallet')
  @Get('registers/:id/session')
  async session(@Req() request: FastifyRequest, @Param('id') id: string) {
    const registerId = parse(idParamSchema, id);
    return mapPosErrors(() =>
      this.registers.session(requireContext(request), request, registerId),
    );
  }

  /** The offline price list, keyset-paged by SKU code. */
  @RequireAbility('read', 'Catalog')
  @Get('registers/:id/price-list')
  async priceList(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const registerId = parse(idParamSchema, id);
    const page = parse(catalogPageSchema, query);
    return mapPosErrors(() =>
      this.registers.priceList(requireContext(request), request, registerId, page),
    );
  }

  /** Always "not available" until M16 binds the promotions port. */
  @RequireAbility('update', 'Wallet')
  @Post('promo-codes/check')
  @HttpCode(200)
  async checkPromo(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(promoCheckSchema, body);
    return mapPosErrors(() =>
      this.registers.checkPromo(requireContext(request), request, input),
    );
  }

  // --- shifts -------------------------------------------------------------------

  @RequireAbility('read', 'Wallet')
  @Get('shifts')
  async listShifts(@Req() request: FastifyRequest, @Query() query: unknown) {
    const filter = parse(shiftListSchema, query);
    return mapPosErrors(() => this.shifts.list(requireContext(request), request, filter));
  }

  @RequireAbility('read', 'Wallet')
  @Get('shifts/:id')
  async getShift(@Req() request: FastifyRequest, @Param('id') id: string) {
    const shiftId = parse(idParamSchema, id);
    return mapPosErrors(() => this.shifts.get(requireContext(request), request, shiftId));
  }

  @RequireAbility('update', 'Wallet')
  @Post('shifts')
  async openShift(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(openShiftSchema, body);
    return mapPosErrors(() =>
      this.shifts.open(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('update', 'Wallet')
  @Post('shifts/:id/close')
  @HttpCode(200)
  async closeShift(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const shiftId = parse(idParamSchema, id);
    const input = parse(closeShiftSchema, body);
    return mapPosErrors(() =>
      this.shifts.close(requireContext(request), auditable(request), shiftId, input),
    );
  }

  // --- the offline queue ----------------------------------------------------------

  /**
   * The till's queue, oldest first. Answers 200 with one result per document —
   * posted, held for review, a replay of what was already recorded, or refused —
   * so one bad document never costs the ones behind it.
   */
  @RequireAbility('update', 'Wallet')
  @Post('sync')
  @HttpCode(200)
  async sync(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(syncSchema, body);
    return mapPosErrors(() =>
      this.syncs.sync(requireContext(request), auditable(request), input.documents),
    );
  }

  @RequireAbility('read', 'Wallet')
  @Get('receipts/:receiptNo')
  async receipt(@Req() request: FastifyRequest, @Param('receiptNo') receiptNo: string) {
    if (!/^[A-Z0-9][A-Z0-9-]{0,39}$/.test(receiptNo)) {
      throw new BadRequestException('Not a receipt number.');
    }
    return mapPosErrors(() => this.reviews.receipt(requireContext(request), request, receiptNo));
  }

  @RequireAbility('read', 'Wallet')
  @Get('sales/:id')
  async sale(@Req() request: FastifyRequest, @Param('id') id: string) {
    const saleId = parse(idParamSchema, id);
    return mapPosErrors(() => this.reviews.sale(requireContext(request), request, saleId));
  }

  // --- review items ---------------------------------------------------------------

  @RequireAbility('read', 'Wallet')
  @Get('reviews')
  async listReviews(@Req() request: FastifyRequest, @Query() query: unknown) {
    const filter = parse(reviewListSchema, query);
    return mapPosErrors(() => this.reviews.list(requireContext(request), request, filter));
  }

  @RequireAbility('update', 'Wallet')
  @Post('reviews/:id/resolve')
  @HttpCode(200)
  async resolveReview(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const reviewId = parse(idParamSchema, id);
    const input = parse(resolveReviewSchema, body);
    return mapPosErrors(() =>
      this.reviews.resolve(requireContext(request), auditable(request), reviewId, input),
    );
  }

  // --- branches -------------------------------------------------------------------

  @RequireAbility('read', 'LedgerReport')
  @Get('branches')
  async listBranches(@Req() request: FastifyRequest, @Query() query: unknown) {
    const { date } = parse(dateSchema, query);
    return mapPosErrors(() => this.branches.list(requireContext(request), request, date));
  }

  @RequireAbility('read', 'LedgerReport')
  @Get('branches/:id/summary')
  async branchSummary(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const branchId = parse(idParamSchema, id);
    const range = parse(rangeSchema, query);
    return mapPosErrors(() =>
      this.branches.summary(requireContext(request), request, branchId, range),
    );
  }

  @RequireAbility('read', 'Wallet')
  @Get('branches/:id/closings')
  async branchClosings(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const branchId = parse(idParamSchema, id);
    const range = parse(rangeSchema, query);
    return mapPosErrors(() =>
      this.branches.closings(requireContext(request), request, branchId, range),
    );
  }

  @RequireAbility('update', 'Wallet')
  @Post('branches/:id/closings')
  async closeBranchDay(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const branchId = parse(idParamSchema, id);
    const input = parse(branchClosingSchema, body);
    return mapPosErrors(() =>
      this.branches.close(requireContext(request), auditable(request), branchId, input),
    );
  }
}
