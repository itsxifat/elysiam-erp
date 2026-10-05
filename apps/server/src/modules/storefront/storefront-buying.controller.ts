import {
  BadRequestException,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  accountEmailSchema,
  cartQuoteSchema,
  changePasswordSchema,
  checkoutSchema,
  googleSignInSchema,
  orderNoSchema,
  paymentInitSchema,
  paymentReturnSchema,
  registerAccountSchema,
  resetPasswordSchema,
  serializeForStorefront,
  signInSchema,
  updateAccountSchema,
  verifyEmailSchema,
  viewTokenSchema,
} from '@elysium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AuditExempt } from '../../platform/audit/audit.interceptor.js';
import { Public } from '../../platform/auth/abilities.js';
import { checkKey, IDEMPOTENCY_REPLAYED_HEADER } from '../../platform/http/idempotency.js';
import { instanceOf, problemFor, PROBLEM_CONTENT_TYPE } from '../../platform/http/problem.js';
import { AccountsService } from './accounts.service.js';
import { BuyingService } from './buying.service.js';
import { FlashSalesReader } from './flash-sales.reader.js';
import { PaymentsService } from './payments.service.js';
import { ShopperOrdersService } from './shopper-orders.service.js';
import { StorefrontSignatureGuard, storefrontSiteOf } from './signature.guard.js';
import { etagOf } from './signature.js';
import { StorefrontError, StorefrontRefusal, toStorefrontHttp } from './storefront.errors.js';

const SIGNED =
  'The brand website’s server has no session: a website key and an HMAC over the timestamp, method, path, query, idempotency key and body authenticate it (D-506, M34).';
const SELF_AUDITED =
  'A storefront write is signed by a website key, not a session; the service records its own audit row inside its transaction where it changes anything (M34).';

const uuid = z.string().uuid();

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

function lastOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/**
 * Buying on the website (M34, D-520 to D-539; `docs/storefront-api.md`): the cart quote, the
 * checkout, shopper accounts, the shopper's view of an order, SSLCommerz, and the flash sales.
 *
 * Server to server only, signed like M33's reads (`StorefrontSignatureGuard`); a write also signs
 * its `Idempotency-Key` and raw body. Every answer leaves through `serializeForStorefront`, the
 * allow-list at every depth, with `Cache-Control: no-store` (personal data, a quote that moves
 * with stock). A refusal that needs more than a sentence (`CART_REPRICED` with the new quote,
 * `OUT_OF_STOCK` with the short lines) is problem+json with those members added, through the same
 * allow-list.
 */
@Controller('storefront/v1')
@UseGuards(StorefrontSignatureGuard)
export class StorefrontBuyingController {
  constructor(
    private readonly buying: BuyingService,
    private readonly accounts: AccountsService,
    private readonly shopperOrders: ShopperOrdersService,
    private readonly payments: PaymentsService,
    private readonly flashSales: FlashSalesReader,
  ) {}

  // --- the cart ----------------------------------------------------------------------------------

  @Public(SIGNED)
  @AuditExempt('A quote reads and prices; it writes nothing.')
  @Post('cart/quote')
  @HttpCode(200)
  async quote(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.buying.quote(orgId, parse(cartQuoteSchema, request.body)),
    );
  }

  @Public(SIGNED)
  @AuditExempt(SELF_AUDITED)
  @Post('checkout')
  async checkout(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const site = storefrontSiteOf(request);
    await answer(request, reply, 201, async () => {
      const key = checkKey(site.idempotencyKey === '' ? undefined : site.idempotencyKey);
      if (!key.ok) {
        throw new StorefrontError(
          'IDEMPOTENCY_KEY_INVALID',
          400,
          'An Idempotency-Key header is required on every checkout.',
        );
      }
      const input = parse(checkoutSchema, request.body);
      const receipt = await this.buying.checkout(site, input, {
        idempotencyKey: key.key,
        rawBody: site.rawBody ?? Buffer.alloc(0),
      });
      if (receipt.replayed) void reply.header(IDEMPOTENCY_REPLAYED_HEADER, 'true');
      return receipt.body;
    });
  }

  // --- accounts ----------------------------------------------------------------------------------

  @Public(SIGNED)
  @AuditExempt(SELF_AUDITED)
  @Post('accounts/register')
  async register(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 201, () =>
      this.accounts.register(orgId, parse(registerAccountSchema, request.body)),
    );
  }

  @Public(SIGNED)
  @AuditExempt(SELF_AUDITED)
  @Post('accounts/verify-email')
  @HttpCode(200)
  async verifyEmail(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.accounts.verifyEmail(orgId, parse(verifyEmailSchema, request.body)),
    );
  }

  @Public(SIGNED)
  @AuditExempt('Sends a code to an inbox; the code itself is the record, and is kept hashed.')
  @Post('accounts/resend-code')
  @HttpCode(200)
  async resendCode(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.accounts.resendCode(orgId, parse(accountEmailSchema, request.body)),
    );
  }

  @Public(SIGNED)
  @AuditExempt('A sign-in checks a password and notes the time; it changes nothing else.')
  @Post('accounts/sign-in')
  @HttpCode(200)
  async signIn(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.accounts.signIn(orgId, parse(signInSchema, request.body)),
    );
  }

  @Public(SIGNED)
  @AuditExempt(SELF_AUDITED)
  @Post('accounts/google')
  @HttpCode(200)
  async google(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.accounts.google(orgId, parse(googleSignInSchema, request.body)),
    );
  }

  @Public(SIGNED)
  @AuditExempt('Sends a reset link to an inbox; the link is kept hashed and says nothing back.')
  @Post('accounts/forgot-password')
  @HttpCode(200)
  async forgotPassword(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.accounts.forgotPassword(orgId, parse(accountEmailSchema, request.body)),
    );
  }

  @Public(SIGNED)
  @AuditExempt(SELF_AUDITED)
  @Post('accounts/reset-password')
  @HttpCode(200)
  async resetPassword(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.accounts.resetPassword(orgId, parse(resetPasswordSchema, request.body)),
    );
  }

  @Public(SIGNED)
  @Get('accounts/:id')
  async account(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () => this.accounts.profile(orgId, parse(uuid, id)));
  }

  @Public(SIGNED)
  @AuditExempt('A shopper’s own profile; the account row is its record, and holds no money.')
  @Patch('accounts/:id')
  async updateAccount(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.accounts.updateProfile(orgId, parse(uuid, id), parse(updateAccountSchema, request.body)),
    );
  }

  @Public(SIGNED)
  @AuditExempt(SELF_AUDITED)
  @Post('accounts/:id/change-password')
  @HttpCode(200)
  async changePassword(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.accounts.changePassword(
        orgId,
        parse(uuid, id),
        parse(changePasswordSchema, request.body),
      ),
    );
  }

  @Public(SIGNED)
  @Get('accounts/:id/orders')
  async accountOrders(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
    @Query('cursor') cursor: string | string[] | undefined,
    @Query('limit') limit: string | string[] | undefined,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    const size = Math.min(50, Math.max(1, Number.parseInt(lastOf(limit) ?? '20', 10) || 20));
    await answer(request, reply, 200, () =>
      this.shopperOrders.listForAccount(orgId, parse(uuid, id), {
        cursor: lastOf(cursor),
        limit: size,
      }),
    );
  }

  @Public(SIGNED)
  @Get('accounts/:id/orders/:orderNo')
  async accountOrder(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('id') id: string,
    @Param('orderNo') orderNo: string,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.shopperOrders.forAccount(orgId, parse(uuid, id), parse(orderNoSchema, orderNo)),
    );
  }

  // --- a guest's order ---------------------------------------------------------------------------

  @Public(SIGNED)
  @Get('orders/:orderNo')
  async order(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('orderNo') orderNo: string,
    @Query('token') token: string | string[] | undefined,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.shopperOrders.byToken(
        orgId,
        parse(orderNoSchema, orderNo),
        parse(viewTokenSchema, lastOf(token) ?? ''),
      ),
    );
  }

  // --- SSLCommerz --------------------------------------------------------------------------------

  @Public(SIGNED)
  @AuditExempt('Opens a payment session; the session row is its record (D-525).')
  @Post('payments/sslcommerz/init')
  @HttpCode(200)
  async initPayment(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const site = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.payments.init(site, parse(paymentInitSchema, request.body)),
    );
  }

  @Public(SIGNED)
  @AuditExempt(SELF_AUDITED)
  @Post('payments/sslcommerz/return')
  @HttpCode(200)
  async paymentReturn(@Req() request: FastifyRequest, @Res() reply: FastifyReply): Promise<void> {
    const site = storefrontSiteOf(request);
    await answer(request, reply, 200, () =>
      this.payments.returned(site, parse(paymentReturnSchema, request.body)),
    );
  }

  // --- flash sales (M35a, D-548) -----------------------------------------------------------------

  @Public(SIGNED)
  @Get('flash-sales')
  async flashSaleList(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Query('home') home: string | string[] | undefined,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await cached(request, reply, () => this.flashSales.list(orgId, lastOf(home) === 'true'));
  }

  @Public(SIGNED)
  @Get('flash-sales/:slug')
  async flashSale(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('slug') slug: string,
  ): Promise<void> {
    const { orgId } = storefrontSiteOf(request);
    await cached(request, reply, () => this.flashSales.one(orgId, slug));
  }
}

/** A personal or moving answer: the allow-list, then JSON, never stored by a cache. */
async function answer(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  work: () => Promise<unknown>,
): Promise<void> {
  let payload: unknown;
  try {
    payload = await work();
  } catch (error) {
    if (error instanceof StorefrontRefusal) {
      const body = {
        ...problemFor({
          status: error.status,
          code: error.code,
          detail: error.message,
          instance: instanceOf(request.url),
        }),
        ...(serializeForStorefront(error.extensions) as Record<string, unknown>),
      };
      await reply
        .code(error.status)
        .header('cache-control', 'no-store')
        .header('content-type', PROBLEM_CONTENT_TYPE)
        .send(JSON.stringify(body));
      return;
    }
    if (error instanceof StorefrontError && error.retryAfter !== undefined) {
      void reply.header('retry-after', String(error.retryAfter));
    }
    throw toStorefrontHttp(error);
  }
  await reply
    .code(status)
    .header('cache-control', 'no-store')
    .header('content-type', 'application/json; charset=utf-8')
    .send(JSON.stringify(serializeForStorefront(payload)));
}

/** A shared read (the flash sales): M33's caching, ETag and 304. */
async function cached(
  request: FastifyRequest,
  reply: FastifyReply,
  work: () => Promise<unknown>,
): Promise<void> {
  let payload: unknown;
  try {
    payload = await work();
  } catch (error) {
    throw toStorefrontHttp(error);
  }
  const body = JSON.stringify(serializeForStorefront(payload));
  const etag = etagOf(body);
  void reply
    .header('cache-control', 'private, max-age=30, stale-while-revalidate=300')
    .header('etag', etag)
    .header('vary', 'x-api-key');
  const asked = request.headers['if-none-match'];
  if (
    typeof asked === 'string' &&
    asked.split(',').some((tag) => tag.trim().replace(/^W\//, '') === etag)
  ) {
    await reply.code(304).send();
    return;
  }
  await reply.header('content-type', 'application/json; charset=utf-8').send(body);
}
