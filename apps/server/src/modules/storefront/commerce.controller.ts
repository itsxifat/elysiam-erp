import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { emailSettingsSchema, sslcommerzSettingsSchema, testEmailSchema } from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditExempt } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { CommerceService } from './commerce.service.js';
import { PaymentsService } from './payments.service.js';
import { mapStorefrontErrors } from './storefront.errors.js';

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message:
        issue === undefined
          ? 'That is not valid.'
          : `${issue.path.join('.') || 'body'}: ${issue.message}`,
    });
  }
  return parsed.data;
}

const accountQuerySchema = z
  .object({
    q: z.string().trim().min(2).max(64).optional(),
    customerId: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

const limitSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

/**
 * The console's Website → Payments, Email and Customers, and the website card on an order
 * (M34, D-528, D-529, D-533).
 *
 * Reading is `read Storefront` (org_admin, marketing, sales). Changing where shoppers' money
 * goes or where their reset links are sent from is `update WebsiteCredentials`, org_admin only
 * (D-528): a marketing user who could repoint SSLCommerz or the email server could take the
 * money or the accounts. No answer carries a password, ever; a fingerprint says which one is set.
 */
@Controller('v1/storefront')
export class CommerceController {
  constructor(
    private readonly commerce: CommerceService,
    private readonly payments: PaymentsService,
  ) {}

  @RequireAbility('read', 'Storefront')
  @Get('payments')
  async paymentSettings(@Req() request: FastifyRequest) {
    return mapStorefrontErrors(() => this.payments.settingsView(requireContext(request)));
  }

  @RequireAbility('update', 'WebsiteCredentials')
  @Put('payments')
  async savePaymentSettings(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(sslcommerzSettingsSchema, body);
    return mapStorefrontErrors(() =>
      this.payments.saveSettings(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('read', 'Storefront')
  @Get('payments/sessions')
  async paymentSessions(@Req() request: FastifyRequest, @Query() query: unknown) {
    const { limit } = parse(limitSchema, query);
    return mapStorefrontErrors(() => this.payments.recent(requireContext(request), limit));
  }

  @RequireAbility('read', 'Storefront')
  @Get('email')
  async emailSettings(@Req() request: FastifyRequest) {
    return mapStorefrontErrors(() => this.commerce.emailSettings(requireContext(request)));
  }

  @RequireAbility('update', 'WebsiteCredentials')
  @Put('email')
  async saveEmailSettings(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(emailSettingsSchema, body);
    return mapStorefrontErrors(() =>
      this.commerce.saveEmailSettings(requireContext(request), auditable(request), input),
    );
  }

  @RequireAbility('update', 'WebsiteCredentials')
  @AuditExempt('A test email changes nothing; the email server answers and nothing is stored.')
  @Post('email/test')
  @HttpCode(200)
  async testEmail(@Req() request: FastifyRequest, @Body() body: unknown) {
    const { to } = parse(testEmailSchema, body);
    return mapStorefrontErrors(() => this.commerce.sendTestEmail(requireContext(request), to));
  }

  @RequireAbility('read', 'Storefront')
  @Get('email/log')
  async emailLog(@Req() request: FastifyRequest, @Query() query: unknown) {
    const { limit } = parse(limitSchema, query);
    return mapStorefrontErrors(() => this.commerce.emailLog(requireContext(request), limit));
  }

  @RequireAbility('read', 'Storefront')
  @Get('accounts')
  async accounts(@Req() request: FastifyRequest, @Query() query: unknown) {
    const input = parse(accountQuerySchema, query);
    return mapStorefrontErrors(() => this.commerce.accounts(requireContext(request), input));
  }

  @RequireAbility('read', 'Storefront')
  @Get('orders/:orderId')
  async orderWebsite(@Req() request: FastifyRequest, @Param('orderId') orderId: string) {
    const id = parse(z.string().uuid('No such order.'), orderId);
    return mapStorefrontErrors(() => this.commerce.orderWebsite(requireContext(request), id));
  }
}
