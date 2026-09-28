import {
  BadRequestException,
  Body,
  Controller,
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
import { DistributionsService } from './distributions.service.js';
import { InvestorDocumentsService } from './documents.service.js';
import { InvestmentsService } from './investments.service.js';
import { InvestorsService } from './investors.service.js';
import { WithdrawalsService } from './withdrawals.service.js';
import { mapInvestorErrors } from './investors.errors.js';
import {
  attachDocumentSchema,
  createInvestorSchema,
  declareDistributionSchema,
  investorIdParamSchema,
  investorListQuerySchema,
  recordInvestmentSchema,
  rejectSchema,
  requestWithdrawalSchema,
  reviewWithdrawalSchema,
  statementQuerySchema,
  updateInvestorSchema,
  withdrawalListQuerySchema,
} from './investors.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Investors over HTTP (architecture §6, §15, §23).
 *
 * Which ability each route declares is this milestone's role matrix, and it is
 * worth reading as a list rather than route by route:
 *
 * - **Every read is `read Investor`**, which §6 gives to org_admin and accounts
 *   at `org` and to the `investor` role at `own`. That single grant is check 1:
 *   the handler applies the caller's scope to the investor row and joins
 *   everything else — contributions, withdrawals, documents, statements — to it,
 *   so an investor's reach is exactly their own row and a staff role's is the org.
 * - **Recording money is `create Investor`**, which §6 gives to accounts (and
 *   super_admin) and *not* to org_admin, whose cell on the investors row reads
 *   "org (read)". Contributions, distributions, withdrawal requests and documents
 *   are all recording, so they are all `create`.
 * - **Reviewing and paying are `update Investor`**, also accounts. Reviewing is
 *   the maker half of maker-checker; paying is the act that posts the journal.
 * - **There is no approve route here.** A distribution and a withdrawal are
 *   decided through `POST /v1/approvals/:id/decide` and take effect through this
 *   module's executors, inside that transaction (D-088). A second door into the
 *   same decision is a second place for the maker-checker rule to be wrong.
 *
 * `GET /wallet-accounts` declares `create Investor` rather than `read Investor`
 * on purpose: it is the picker for a contribution or a payment, and an investor
 * has no business enumerating the brand's bank and bKash accounts.
 */
@Controller('v1/investors')
export class InvestorsController {
  constructor(
    private readonly investors: InvestorsService,
    private readonly investments: InvestmentsService,
    private readonly distributions: DistributionsService,
    private readonly withdrawals: WithdrawalsService,
    private readonly documents: InvestorDocumentsService,
  ) {}

  @RequireAbility('read', 'Investor')
  @Get()
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(investorListQuerySchema, query);
    return mapInvestorErrors(() =>
      this.investors.list(requireContext(request), request, {
        includeExited: parsed.includeExited,
      }),
    );
  }

  @RequireAbility('create', 'Investor')
  @Post()
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createInvestorSchema, body);
    return mapInvestorErrors(() =>
      this.investors.create(requireContext(request), auditable(request), input),
    );
  }

  /** The wallet accounts a contribution or a payment may name (§7). */
  @RequireAbility('create', 'Investor')
  @Get('wallet-accounts')
  async walletAccounts(@Req() request: FastifyRequest) {
    return mapInvestorErrors(() => this.investors.walletAccounts(requireContext(request)));
  }

  @RequireAbility('read', 'Investor')
  @Get('investments')
  async listInvestments(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(withdrawalListQuerySchema.pick({ investorId: true }), query);
    return mapInvestorErrors(() =>
      this.investments.list(requireContext(request), request, { investorId: parsed.investorId }),
    );
  }

  /** A capital contribution. Posts Dr wallet / Cr investor capital (§7). */
  @RequireAbility('create', 'Investor')
  @Post('investments')
  async recordInvestment(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(recordInvestmentSchema, body);
    return mapInvestorErrors(() =>
      this.investments.record(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('read', 'Investor')
  @Get('distributions')
  async listDistributions(@Req() request: FastifyRequest) {
    return mapInvestorErrors(() => this.distributions.list(requireContext(request), request));
  }

  /**
   * Declare a distribution for a month (D-019). Posts nothing: it waits for a
   * checker, and the split is computed here rather than sent by the client.
   */
  @RequireAbility('create', 'Investor')
  @Post('distributions')
  async declareDistribution(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(declareDistributionSchema, body);
    return mapInvestorErrors(() =>
      this.distributions.declare(requireContext(request), auditable(request), input),
    );
  }

  /**
   * Close a declaration that will not be declared.
   *
   * `create Investor`, like declaring: the same people who raise a declaration are
   * the ones who withdraw it. Without this, a rejected declaration sits at
   * `pending_approval` and the unique index in 0058 makes that month's profit
   * impossible to declare ever again.
   */
  @RequireAbility('create', 'Investor')
  @Post('distributions/:id/reject')
  async rejectDistribution(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const distributionId = parse(investorIdParamSchema, id);
    const input = parse(rejectSchema, body ?? {});
    return mapInvestorErrors(() =>
      this.distributions.reject(
        requireContext(request),
        auditable(request),
        distributionId,
        input.reason,
      ),
    );
  }

  @RequireAbility('read', 'Investor')
  @Get('distributions/:id')
  async getDistribution(@Req() request: FastifyRequest, @Param('id') id: string) {
    const distributionId = parse(investorIdParamSchema, id);
    return mapInvestorErrors(() =>
      this.distributions.get(requireContext(request), request, distributionId),
    );
  }

  @RequireAbility('read', 'Investor')
  @Get('withdrawals')
  async listWithdrawals(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(withdrawalListQuerySchema, query);
    return mapInvestorErrors(() =>
      this.withdrawals.list(requireContext(request), request, {
        investorId: parsed.investorId,
        status: parsed.status,
      }),
    );
  }

  @RequireAbility('create', 'Investor')
  @Post('withdrawals')
  async requestWithdrawal(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(requestWithdrawalSchema, body);
    return mapInvestorErrors(() =>
      this.withdrawals.request(requireContext(request), auditable(request), input),
    );
  }

  /** Review: confirm the position, name the wallet, raise the approval. */
  @RequireAbility('update', 'Investor')
  @Post('withdrawals/:id/review')
  async reviewWithdrawal(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const withdrawalId = parse(investorIdParamSchema, id);
    const input = parse(reviewWithdrawalSchema, body);
    return mapInvestorErrors(() =>
      this.withdrawals.review(requireContext(request), auditable(request), withdrawalId, input),
    );
  }

  /**
   * Close a withdrawal that will not be paid.
   *
   * `update Investor`, like the review: it is the finance team withdrawing a request
   * rather than a checker deciding one. It exists because every status short of paid
   * and rejected counts against the investor's own headroom, so a request nobody
   * closes is money that investor can never reach again.
   */
  @RequireAbility('update', 'Investor')
  @Post('withdrawals/:id/reject')
  async rejectWithdrawal(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const withdrawalId = parse(investorIdParamSchema, id);
    const input = parse(rejectSchema, body ?? {});
    return mapInvestorErrors(() =>
      this.withdrawals.reject(
        requireContext(request),
        auditable(request),
        withdrawalId,
        input.reason,
      ),
    );
  }

  /** Pay an approved withdrawal. The only step in the flow that posts (§7). */
  @RequireAbility('update', 'Investor')
  @Post('withdrawals/:id/pay')
  async payWithdrawal(@Req() request: FastifyRequest, @Param('id') id: string) {
    const withdrawalId = parse(investorIdParamSchema, id);
    return mapInvestorErrors(() =>
      this.withdrawals.pay(requireContext(request), auditable(request), withdrawalId),
    );
  }

  @RequireAbility('read', 'Investor')
  @Get('documents')
  async listDocuments(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(withdrawalListQuerySchema.pick({ investorId: true }), query);
    return mapInvestorErrors(() =>
      this.documents.list(requireContext(request), request, { investorId: parsed.investorId }),
    );
  }

  @RequireAbility('create', 'Investor')
  @Post('documents')
  async attachDocument(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(attachDocumentSchema, body);
    return mapInvestorErrors(() =>
      this.documents.attach(requireContext(request), auditable(request), input),
    );
  }

  /** A short-lived signed URL for one private document (check 3). */
  @RequireAbility('read', 'Investor')
  @Get('documents/:id/download')
  async downloadDocument(@Req() request: FastifyRequest, @Param('id') id: string) {
    const documentId = parse(investorIdParamSchema, id);
    return mapInvestorErrors(() =>
      this.documents.download(requireContext(request), request, documentId),
    );
  }

  @RequireAbility('read', 'Investor')
  @Get(':id')
  async get(@Req() request: FastifyRequest, @Param('id') id: string) {
    const investorId = parse(investorIdParamSchema, id);
    return mapInvestorErrors(() =>
      this.investors.get(requireContext(request), request, investorId),
    );
  }

  @RequireAbility('update', 'Investor')
  @Patch(':id')
  async update(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const investorId = parse(investorIdParamSchema, id);
    const patch = parse(updateInvestorSchema, body);
    return mapInvestorErrors(() =>
      this.investors.update(requireContext(request), auditable(request), investorId, patch),
    );
  }

  /** An investor's own statement over a range of business dates (§15). */
  @RequireAbility('read', 'Investor')
  @Get(':id/statement')
  async statement(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const investorId = parse(investorIdParamSchema, id);
    const range = parse(statementQuerySchema, query);
    return mapInvestorErrors(() =>
      this.investors.statement(requireContext(request), request, investorId, range),
    );
  }
}
