import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  cashInSchema,
  closePeriodSchema,
  dateRangeSchema,
  dayBookQuerySchema,
  ledgerIdSchema,
  partyBalanceQuerySchema,
  reopenPeriodSchema,
  trialBalanceQuerySchema,
} from '@elysium/contracts';
import { businessDate } from '@elysium/domain';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { CashService } from './cash.service.js';
import { mapLedgerErrors } from './ledger.errors.js';
import { PeriodsService } from './periods.service.js';
import { ReportsService } from './reports.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * The ledger over HTTP (architecture §7, §23).
 *
 * Reads are `read LedgerReport` (org_admin, accounts; branch_manager for
 * their branches) or `read Wallet`. Posting cash in is `update Wallet`, the
 * §6 "cash entries" capability. Periods are `LedgerPeriod` (D-083). There is
 * deliberately no route that posts an arbitrary journal or reverses one:
 * journals come only from posting rules (D-088).
 */
@Controller('v1/ledger')
export class LedgerController {
  constructor(
    private readonly reports: ReportsService,
    private readonly periods: PeriodsService,
    private readonly cash: CashService,
  ) {}

  @RequireAbility('read', 'LedgerReport')
  @Get('accounts')
  async accounts(@Req() request: FastifyRequest) {
    return mapLedgerErrors(() => this.reports.accounts(requireContext(request), request));
  }

  @RequireAbility('read', 'LedgerReport')
  @Get('accounts/:id/ledger')
  async accountLedger(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Query() query: unknown,
  ) {
    const accountId = parse(ledgerIdSchema, id);
    const range = parse(dateRangeSchema, query);
    return mapLedgerErrors(() =>
      this.reports.accountLedger(requireContext(request), request, accountId, {
        from: range.from,
        to: range.to,
      }),
    );
  }

  @RequireAbility('read', 'LedgerReport')
  @Get('trial-balance')
  async trialBalance(@Req() request: FastifyRequest, @Query() query: unknown) {
    const { asOf } = parse(trialBalanceQuerySchema, query);
    return mapLedgerErrors(() => this.reports.trialBalance(requireContext(request), request, asOf));
  }

  @RequireAbility('read', 'LedgerReport')
  @Get('party-balances')
  async partyBalances(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(partyBalanceQuerySchema, query);
    return mapLedgerErrors(() =>
      this.reports.partyBalances(requireContext(request), request, parsed),
    );
  }

  @RequireAbility('read', 'LedgerReport')
  @Get('day-book')
  async dayBook(@Req() request: FastifyRequest, @Query() query: unknown) {
    const range = parse(dayBookQuerySchema, query);
    return mapLedgerErrors(() => this.reports.dayBook(requireContext(request), request, range));
  }

  @RequireAbility('read', 'Wallet')
  @Get('wallets')
  async wallets(@Req() request: FastifyRequest) {
    return mapLedgerErrors(() =>
      this.reports.wallets(requireContext(request), request, businessDate(new Date())),
    );
  }

  @RequireAbility('read', 'Wallet')
  @Get('wallets/:id/cash-book')
  async cashBook(@Req() request: FastifyRequest, @Param('id') id: string, @Query() query: unknown) {
    const walletId = parse(ledgerIdSchema, id);
    const range = parse(dateRangeSchema, query);
    return mapLedgerErrors(() =>
      this.reports.cashBook(requireContext(request), request, walletId, {
        from: range.from,
        to: range.to,
      }),
    );
  }

  /** Money received into a wallet (§7 "Cash in"). */
  @RequireAbility('update', 'Wallet')
  @Post('cash-in')
  async cashIn(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(cashInSchema, body);
    return mapLedgerErrors(() =>
      this.cash.cashIn(requireContext(request), {
        entryId: input.entryId,
        walletAccountId: input.walletAccountId,
        incomeAccountId: input.incomeAccountId,
        amountPoisha: input.amountPoisha,
        memo: input.memo,
        request: auditable(request),
      }),
    );
  }

  @RequireAbility('read', 'LedgerPeriod')
  @Get('periods')
  async listPeriods(@Req() request: FastifyRequest) {
    return { items: await this.periods.list(requireContext(request)) };
  }

  @RequireAbility('update', 'LedgerPeriod')
  @Post('periods/close')
  async closePeriod(@Req() request: FastifyRequest, @Body() body: unknown) {
    const { month } = parse(closePeriodSchema, body);
    return mapLedgerErrors(() =>
      this.periods.close(requireContext(request), month, auditable(request)),
    );
  }

  /** Raises a `period_reopen` request; a super_admin's approval reopens it. */
  @RequireAbility('update', 'LedgerPeriod')
  @Post('periods/reopen')
  async reopenPeriod(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(reopenPeriodSchema, body);
    return mapLedgerErrors(() =>
      this.periods.requestReopen(requireContext(request), input, auditable(request)),
    );
  }
}
