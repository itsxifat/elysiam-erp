import { BadRequestException, Body, Controller, Get, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { mapLoanErrors } from './loans.errors.js';
import {
  createLenderSchema,
  createLoanSchema,
  idParamSchema,
  payInstalmentSchema,
  previewScheduleSchema,
} from './loans.schemas.js';
import { LoansService } from './loans.service.js';
import { LoanPaymentsService } from './payments.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * Company loans over HTTP (architecture §6, §15, §23; M26).
 *
 * One subject, `CompanyLoan`, which §6 gives to org_admin and accounts at `org` and to
 * nobody else: reads are `read`, recording a lender or a loan is `create`, and paying an
 * instalment is `update`. A repayment above the brand's threshold is decided through
 * `POST /v1/approvals/:id/decide` and takes effect through this module's executor; there
 * is no second door into that decision here.
 *
 * The wallet picker is M08's `GET /v1/ledger/wallets`, which both roles already read.
 */
@Controller('v1/loans')
export class LoansController {
  constructor(
    private readonly loans: LoansService,
    private readonly payments: LoanPaymentsService,
  ) {}

  @RequireAbility('read', 'CompanyLoan')
  @Get('lenders')
  async listLenders(@Req() request: FastifyRequest) {
    return mapLoanErrors(() => this.loans.listLenders(requireContext(request)));
  }

  @RequireAbility('create', 'CompanyLoan')
  @Post('lenders')
  async createLender(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createLenderSchema, body);
    return mapLoanErrors(() =>
      this.loans.createLender(requireContext(request), auditable(request), input),
    );
  }

  /** The schedule proposed terms would have. Writes nothing. */
  @RequireAbility('read', 'CompanyLoan')
  @Post('preview')
  async preview(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(previewScheduleSchema, body);
    return mapLoanErrors(() => Promise.resolve(this.loans.preview(requireContext(request), input)));
  }

  @RequireAbility('read', 'CompanyLoan')
  @Get()
  async list(@Req() request: FastifyRequest) {
    return mapLoanErrors(() => this.loans.list(requireContext(request)));
  }

  /** Record a loan: Dr W / Cr Loan payable (lender), and its schedule (§7). */
  @RequireAbility('create', 'CompanyLoan')
  @Post()
  async create(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createLoanSchema, body);
    return mapLoanErrors(() =>
      this.loans.create(requireContext(request), auditable(request), input),
    );
  }

  /** The loan's statement: schedule, payments, totals and the ledger's balance. */
  @RequireAbility('read', 'CompanyLoan')
  @Get(':id')
  async statement(@Req() request: FastifyRequest, @Param('id') id: string) {
    const loanId = parse(idParamSchema, id);
    return mapLoanErrors(() => this.loans.statement(requireContext(request), loanId));
  }

  /** Pay the next instalment: posts, or waits for a checker above the threshold. */
  @RequireAbility('update', 'CompanyLoan')
  @Post(':id/payments')
  async pay(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const loanId = parse(idParamSchema, id);
    const input = parse(payInstalmentSchema, body);
    return mapLoanErrors(() =>
      this.payments.pay(requireContext(request), auditable(request), loanId, input),
    );
  }
}
