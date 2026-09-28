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
import { CashService } from './cash.service.js';
import { ClosingsService } from './closings.service.js';
import { WalletReportsService } from './reports.service.js';
import { TransfersService } from './transfers.service.js';
import { WalletsService } from './wallets.service.js';
import { mapWalletErrors } from './wallets.errors.js';
import {
  agingQuerySchema,
  asOfSchema,
  cashEntryListSchema,
  cashEntrySchema,
  closeWalletSchema,
  createWalletSchema,
  reportRangeSchema,
  updateWalletSchema,
  walletIdParamSchema,
  walletTransferSchema,
} from './wallets.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * The cash picture over HTTP (architecture §6, §7, §23).
 *
 * Which ability each route declares is the milestone's role matrix, so it is worth
 * reading as a list rather than route by route (M08 check 5):
 *
 * - Anything that **moves money** — a cash entry, a transfer, a closing — is
 *   `update Wallet`: org_admin and accounts org-wide, a branch manager for their
 *   own branch's wallets. `sales` holds no `Wallet` rule at all, so every one of
 *   these is a 403 at the guard, before a handler runs.
 * - Setting up a wallet is `create Wallet`, which §6's matrix gives to accounts
 *   (and super_admin). A wallet is a chart-of-accounts change, and the row that
 *   grants it is the "Wallets, cash entries, petty cash" one.
 * - Every **report** is `read LedgerReport`: accounts and org_admin at `org`, a
 *   branch manager at `branch` — §6's "branch P&L without cost detail", where the
 *   scope grants the report and the cost strip in the service keeps cost out of it.
 * - The consolidated views declare `read LedgerReport` like the rest and then
 *   refuse anyone who is not a platform super admin, because the ability cannot
 *   express "all orgs" (§5 exception 3).
 *
 * There is deliberately no route that posts an arbitrary journal, and none that
 * approves a variance: a variance is decided through `POST /v1/approvals/:id/decide`
 * and posts through this module's executor, inside that transaction (D-088).
 */
@Controller('v1/accounts')
export class WalletsController {
  constructor(
    private readonly wallets: WalletsService,
    private readonly cash: CashService,
    private readonly transfers: TransfersService,
    private readonly closings: ClosingsService,
    private readonly reports: WalletReportsService,
  ) {}

  @RequireAbility('read', 'Wallet')
  @Get('wallets')
  async listWallets(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(asOfSchema.partial(), query);
    return mapWalletErrors(() =>
      this.wallets.list(requireContext(request), request, {
        ...(parsed.asOf === undefined ? {} : { asOf: parsed.asOf }),
      }),
    );
  }

  @RequireAbility('create', 'Wallet')
  @Post('wallets')
  async createWallet(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(createWalletSchema, body);
    return mapWalletErrors(() =>
      this.wallets.create(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('update', 'Wallet')
  @Patch('wallets/:id')
  async updateWallet(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const walletId = parse(walletIdParamSchema, id);
    const patch = parse(updateWalletSchema, body);
    return mapWalletErrors(() =>
      this.wallets.update(requireContext(request), auditable(request), walletId, patch),
    );
  }

  /** The income and expense categories a cash entry may name (§7, D-084). */
  @RequireAbility('read', 'Wallet')
  @Get('categories')
  async categories(@Req() request: FastifyRequest) {
    return mapWalletErrors(() => this.wallets.categories(requireContext(request), request));
  }

  @RequireAbility('read', 'Wallet')
  @Get('cash-entries')
  async listCashEntries(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(cashEntryListSchema, query);
    return mapWalletErrors(() =>
      this.cash.list(requireContext(request), request, {
        from: parsed.from,
        to: parsed.to,
        walletId: parsed.walletId,
        status: parsed.status,
      }),
    );
  }

  /** Cash in, cash out or petty cash (§7). Petty cash needs a receipt. */
  @RequireAbility('update', 'Wallet')
  @Post('cash-entries')
  async recordCashEntry(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(cashEntrySchema, body);
    return mapWalletErrors(() =>
      this.cash.record(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('update', 'Wallet')
  @Post('transfers')
  async transfer(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(walletTransferSchema, body);
    return mapWalletErrors(() =>
      this.transfers.transfer(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('read', 'Wallet')
  @Get('closings')
  async listClosings(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(cashEntryListSchema.pick({ from: true, to: true }), query);
    return mapWalletErrors(() =>
      this.closings.list(requireContext(request), request, {
        from: parsed.from,
        to: parsed.to,
      }),
    );
  }

  /** Counted cash for one wallet on one date. A variance raises an approval. */
  @RequireAbility('update', 'Wallet')
  @Post('closings')
  async close(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(closeWalletSchema, body);
    return mapWalletErrors(() =>
      this.closings.close(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('read', 'LedgerReport')
  @Get('reports/profit-and-loss')
  async profitAndLoss(@Req() request: FastifyRequest, @Query() query: unknown) {
    const range = parse(reportRangeSchema, query);
    return mapWalletErrors(() =>
      this.reports.profitAndLoss(requireContext(request), request, range),
    );
  }

  @RequireAbility('read', 'LedgerReport')
  @Get('reports/balance-sheet')
  async balanceSheet(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(asOfSchema, query);
    return mapWalletErrors(() =>
      this.reports.balanceSheet(requireContext(request), request, parsed),
    );
  }

  @RequireAbility('read', 'LedgerReport')
  @Get('reports/aging')
  async aging(@Req() request: FastifyRequest, @Query() query: unknown) {
    const parsed = parse(agingQuerySchema, query);
    return mapWalletErrors(() => this.reports.aging(requireContext(request), request, parsed));
  }

  /** Super Admin only, read through `erp_analytics` (§5 exception 3). */
  @RequireAbility('read', 'LedgerReport')
  @Get('reports/consolidated-wallets')
  async consolidatedWallets(@Req() request: FastifyRequest) {
    return mapWalletErrors(() => this.reports.consolidatedWallets(requireContext(request)));
  }

  @RequireAbility('read', 'LedgerReport')
  @Get('reports/consolidated-profit-and-loss')
  async consolidatedProfitAndLoss(@Req() request: FastifyRequest, @Query() query: unknown) {
    const range = parse(reportRangeSchema, query);
    return mapWalletErrors(() =>
      this.reports.consolidatedProfitAndLoss(requireContext(request), range),
    );
  }
}
