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
import { PaymentsService } from './payments.service.js';
import { ReturnsService } from './returns.service.js';
import { StatementsService } from './statements.service.js';
import { SuppliesService } from './supplies.service.js';
import { SuppliersService } from './suppliers.service.js';
import {
  applyAdvanceSchema,
  createSupplierSchema,
  createSupplySchema,
  idParamSchema,
  paymentListSchema,
  receiveSupplySchema,
  statementQuerySchema,
  supplierContactSchema,
  supplierDocumentSchema,
  supplierListSchema,
  supplierNoteSchema,
  supplierPaymentSchema,
  supplyDraftSchema,
  supplyListSchema,
  supplyReturnSchema,
  updateSupplierSchema,
  updateSupplyDraftSchema,
} from './supply.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Suppliers and purchasing over HTTP (architecture §7, §8, §23).
 *
 * Which ability each route declares **is** D-005, so it is worth reading as a list
 * rather than route by route (M09 check 4):
 *
 * - **Reading** anything about suppliers or entries is `read Supply`: org_admin and
 *   accounts. `warehouse` holds `create` and `update` on Supply and deliberately no
 *   `read`, so every one of these is a 403 at the guard, before a handler runs — which
 *   is how a warehouse clerk is prevented from reading back the prices accounts entered.
 * - **The draft flow** is `create Supply` and `update Supply`: warehouse, accounts and
 *   org_admin. Its schemas have no cost field anywhere, so there is nothing for a
 *   warehouse role to send even if one tried.
 * - **Anything that touches a purchase price or supplier money** declares
 *   `read Cost` — pricing and receiving an entry, a supplier return, an advance, a
 *   payment, applying an advance, and the statement. §6's Supply row cannot express
 *   "not warehouse", because it grants warehouse `update`; the Cost row is exactly the
 *   set §6 means (super_admin, org_admin, accounts) and exactly the set
 *   `REQUESTER_TYPES` lets raise a `supplier_payment` (D-122). Each of those services
 *   checks `canReadCost` again, because a decorator is one refactor from being dropped.
 * - **Deleting a draft** declares `update Supply`, not `delete Supply`: the matrix
 *   grants `delete Supply` to nobody, so declaring it would make the route unreachable
 *   for every role including the warehouse clerk who entered the draft twice.
 *
 * There is no route that posts an arbitrary journal and none that approves a payment: a
 * payment is decided through `POST /v1/approvals/:id/decide` and posts through this
 * module's executor, inside that transaction (D-088).
 */
@Controller('v1/supply')
export class SupplyController {
  constructor(
    private readonly suppliers: SuppliersService,
    private readonly supplies: SuppliesService,
    private readonly returns: ReturnsService,
    private readonly payments: PaymentsService,
    private readonly statements: StatementsService,
  ) {}

  // --- suppliers --------------------------------------------------------------

  @RequireAbility('read', 'Supply')
  @Get('suppliers')
  async listSuppliers(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(supplierListSchema, query ?? {});
    return this.suppliers.list(requireContext(request), parsed);
  }

  @RequireAbility('read', 'Supply')
  @Get('suppliers/:id')
  async supplier(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.suppliers.detail(requireContext(request), parse(idParamSchema, id));
  }

  @RequireAbility('create', 'Supply')
  @Post('suppliers')
  async createSupplier(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createSupplierSchema, body);
    return this.suppliers.create(requireContext(request), auditable(request), input);
  }

  @RequireAbility('update', 'Supply')
  @Patch('suppliers/:id')
  async updateSupplier(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const supplierId = parse(idParamSchema, id);
    const patch = parse(updateSupplierSchema, body);
    return this.suppliers.update(requireContext(request), auditable(request), supplierId, patch);
  }

  @RequireAbility('update', 'Supply')
  @Post('suppliers/:id/contacts')
  async addContact(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const supplierId = parse(idParamSchema, id);
    const input = parse(supplierContactSchema, body);
    return this.suppliers.addContact(
      requireContext(request),
      auditable(request),
      supplierId,
      input,
    );
  }

  @RequireAbility('update', 'Supply')
  @Post('suppliers/:id/notes')
  async addNote(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const supplierId = parse(idParamSchema, id);
    const input = parse(supplierNoteSchema, body);
    return this.suppliers.addNote(requireContext(request), auditable(request), supplierId, input);
  }

  @RequireAbility('update', 'Supply')
  @Post('suppliers/:id/documents')
  async addDocument(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const supplierId = parse(idParamSchema, id);
    const input = parse(supplierDocumentSchema, body);
    return this.suppliers.addDocument(
      requireContext(request),
      auditable(request),
      supplierId,
      input,
    );
  }

  /** The statement whose closing balances must equal the ledger's (check 2). */
  @RequireAbility('read', 'Cost')
  @Get('suppliers/:id/statement')
  async statement(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const supplierId = parse(idParamSchema, id);
    const range = parse(statementQuerySchema, query);
    return this.statements.statement(requireContext(request), supplierId, range);
  }

  // --- supply entries ---------------------------------------------------------

  @RequireAbility('read', 'Supply')
  @Get('entries')
  async listEntries(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(supplyListSchema, query ?? {});
    return this.supplies.list(requireContext(request), request, parsed);
  }

  @RequireAbility('read', 'Supply')
  @Get('entries/:id')
  async entry(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.supplies.detail(requireContext(request), request, parse(idParamSchema, id));
  }

  /** A qty-only draft from the warehouse (D-005). No cost field exists on this body. */
  @RequireAbility('create', 'Supply')
  @Post('drafts')
  async createDraft(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(supplyDraftSchema, body);
    return this.supplies.createDraft(requireContext(request), auditable(request), input);
  }

  @RequireAbility('update', 'Supply')
  @Patch('drafts/:id')
  async updateDraft(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const supplyId = parse(idParamSchema, id);
    const patch = parse(updateSupplyDraftSchema, body);
    return this.supplies.updateDraft(requireContext(request), auditable(request), supplyId, patch);
  }

  @RequireAbility('update', 'Supply')
  @Delete('drafts/:id')
  async deleteDraft(@Req() request: FastifyRequest, @Param('id') id: string) {
    const supplyId = parse(idParamSchema, id);
    return this.supplies.deleteDraft(requireContext(request), auditable(request), supplyId);
  }

  /** Accounts prices a draft and receives it: movements, WAC and the journal. */
  @RequireAbility('read', 'Cost')
  @Post('entries/:id/receive')
  async receive(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const supplyId = parse(idParamSchema, id);
    const input = parse(receiveSupplySchema, body);
    return this.supplies.receive(requireContext(request), auditable(request), supplyId, input);
  }

  /** Entered and priced in one call, from a paper invoice. */
  @RequireAbility('read', 'Cost')
  @Post('entries')
  async createEntry(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createSupplySchema, body);
    return this.supplies.createAndReceive(requireContext(request), auditable(request), input);
  }

  // --- returns ----------------------------------------------------------------

  @RequireAbility('read', 'Supply')
  @Get('returns')
  async listReturns(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(supplyListSchema.pick({ supplierId: true }), query ?? {});
    return this.returns.list(requireContext(request), request, parsed.supplierId);
  }

  @RequireAbility('read', 'Cost')
  @Post('returns')
  async createReturn(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(supplyReturnSchema, body);
    return this.returns.create(requireContext(request), auditable(request), input);
  }

  // --- payments and advances --------------------------------------------------

  @RequireAbility('read', 'Supply')
  @Get('payments')
  async listPayments(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(paymentListSchema, query ?? {});
    return this.payments.list(requireContext(request), request, parsed);
  }

  @RequireAbility('read', 'Cost')
  @Post('payments')
  async pay(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(supplierPaymentSchema, body);
    return this.payments.pay(requireContext(request), auditable(request), input);
  }

  @RequireAbility('read', 'Cost')
  @Post('advance-applications')
  async applyAdvance(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(applyAdvanceSchema, body);
    return this.payments.applyAdvance(requireContext(request), auditable(request), input);
  }
}
