import { All, Controller, Get, HttpCode, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { AuditExempt } from '../../platform/audit/audit.interceptor.js';
import { Public } from '../../platform/auth/abilities.js';
import { NcomAuthService } from './ncom-auth.service.js';
import { NcomConnectorService } from './ncom-connector.service.js';
import { NcomOrdersService } from './ncom-orders.service.js';
import { connectorError, header, ncomJson, ncomRawBodyOf, NcomRefusal } from './ncom.http.js';

const SIGNED =
  'ncom.bd servers have no session: each call carries X-NCOM-Key and an HMAC-SHA256 X-NCOM-Signature over the timestamp and the raw body, checked against the brand sealed secret (contract 1, D-553).';
const RECORDED =
  'Recorded in the marketplace tables (holds, handed-over orders, webhook claims) and, for an order, by its own audit row inside the transaction.';

function listOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string');
  return typeof value === 'string' ? [value] : [];
}

function one(value: unknown): string | undefined {
  const list = listOf(value);
  return list[list.length - 1];
}

/**
 * ncom.bd's contract 1, served by the brand's ERP (M35b, D-553, D-556): the connector ncom reads
 * the catalogue through (`/ncom/<org>/v1/*`), the order intake (`/ncom/<org>/orders`) and the
 * webhook receiver (`/ncom/<org>/webhook`). The brand is in the path, as the SSLCommerz IPN's
 * is. The website's nginx may keep the old site's addresses (`/api/ncom/v1/*`,
 * `/api/ncom/orders`, `/api/ncom-webhook`) by forwarding them here (M37), so ncom's settings
 * need not change.
 */
@Controller('ncom')
export class NcomController {
  constructor(
    private readonly auth: NcomAuthService,
    private readonly connector: NcomConnectorService,
    private readonly orders: NcomOrdersService,
  ) {}

  /** The base itself: someone checking they typed it right gets the contract, not a product. */
  @Public(SIGNED)
  @Get(':orgId/v1')
  async base(@Res() reply: FastifyReply): Promise<void> {
    await ncomJson(
      reply,
      404,
      connectorError(
        'not_found',
        'NCOM product source, contract 1. Append /ping and sign the request.',
      ),
    );
  }

  @Public(SIGNED)
  @Get(':orgId/v1/ping')
  async ping(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('orgId') orgId: string,
  ): Promise<void> {
    await this.serve(reply, async () => {
      const context = await this.auth.connector(orgId, request);
      const body = this.connector.ping(context);
      await this.auth.record(context.orgId, 'ping');
      return body;
    });
  }

  @Public(SIGNED)
  @Get(':orgId/v1/products')
  async products(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('orgId') orgId: string,
  ): Promise<void> {
    await this.serve(reply, async () => {
      const context = await this.auth.connector(orgId, request);
      const query = (request.query ?? {}) as Record<string, unknown>;
      const body = await this.connector.products(context, {
        ids: listOf(query.ids),
        limit: one(query.limit),
        cursor: one(query.cursor),
        status: one(query.status),
        category: one(query.category),
        q: one(query.q),
      });
      await this.auth.record(context.orgId, 'products');
      return body;
    });
  }

  @Public(SIGNED)
  @Get(':orgId/v1/products/:id')
  async product(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('orgId') orgId: string,
    @Param('id') id: string,
  ): Promise<void> {
    await this.serve(reply, async () => {
      const context = await this.auth.connector(orgId, request);
      const shaped = await this.connector.product(context, id);
      if (shaped === null) {
        throw new NcomRefusal(404, connectorError('not_found', 'No such product.'));
      }
      await this.auth.record(context.orgId, 'products');
      // Both readings at once: `body.product` and `body.id` each resolve (the old site's).
      return { product: shaped, ...shaped };
    });
  }

  @Public(SIGNED)
  @Get(':orgId/v1/categories')
  async categories(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('orgId') orgId: string,
  ): Promise<void> {
    await this.serve(reply, async () => {
      const context = await this.auth.connector(orgId, request);
      const body = await this.connector.categories(context);
      await this.auth.record(context.orgId, 'categories');
      return body;
    });
  }

  @Public(SIGNED)
  @AuditExempt('A stock reading: it changes nothing.')
  @Post(':orgId/v1/stock')
  @HttpCode(200)
  async stock(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('orgId') orgId: string,
  ): Promise<void> {
    await this.serve(reply, async () => {
      const context = await this.auth.connector(orgId, request);
      const body = await this.connector.stock(context, this.json(request).ids);
      await this.auth.record(context.orgId, 'stock');
      return body;
    });
  }

  @Public(SIGNED)
  @AuditExempt(RECORDED)
  @Post(':orgId/v1/reserve')
  @HttpCode(200)
  async reserve(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('orgId') orgId: string,
  ): Promise<void> {
    await this.serve(reply, async () => {
      const context = await this.auth.connector(orgId, request);
      const body = await this.connector.reserve(context, this.json(request));
      await this.auth.record(context.orgId, 'reserve');
      return body;
    });
  }

  @Public(SIGNED)
  @AuditExempt(RECORDED)
  @Post(':orgId/v1/release')
  @HttpCode(200)
  async release(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('orgId') orgId: string,
  ): Promise<void> {
    await this.serve(reply, async () => {
      const context = await this.auth.connector(orgId, request);
      const body = await this.connector.release(context, this.json(request));
      await this.auth.record(context.orgId, 'release');
      return body;
    });
  }

  /** Anything else under the connector's base: a JSON 404 naming the real endpoints. */
  @Public(SIGNED)
  @AuditExempt('An unknown address: it answers 404 and changes nothing.')
  @All(':orgId/v1/*')
  async unknown(@Res() reply: FastifyReply): Promise<void> {
    await ncomJson(
      reply,
      404,
      connectorError(
        'not_found',
        'No such connector endpoint. This connector serves: /ping, /products, /products/{id}, /stock, /categories, /reserve, /release.',
      ),
    );
  }

  @Public(SIGNED)
  @AuditExempt(RECORDED)
  @Post(':orgId/orders')
  @HttpCode(200)
  async intake(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('orgId') orgId: string,
  ): Promise<void> {
    await this.answer(reply, async () => {
      const context = await this.auth.orders(orgId, request);
      return this.orders.intake(
        context,
        ncomRawBodyOf(request),
        header(request, 'x-ncom-idempotency-key'),
      );
    });
  }

  @Public(SIGNED)
  @AuditExempt(RECORDED)
  @Post(':orgId/webhook')
  @HttpCode(200)
  async webhook(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
    @Param('orgId') orgId: string,
  ): Promise<void> {
    await this.answer(reply, async () => {
      const context = await this.auth.webhook(orgId, request);
      return this.orders.webhook(
        context,
        ncomRawBodyOf(request),
        header(request, 'x-ncom-event-id'),
      );
    });
  }

  private json(request: FastifyRequest): Record<string, unknown> {
    const raw = ncomRawBodyOf(request).toString('utf8');
    if (raw === '') return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      return parsed !== null && typeof parsed === 'object'
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      throw new NcomRefusal(400, connectorError('invalid_request', 'Body is not valid JSON.'));
    }
  }

  private async serve(reply: FastifyReply, work: () => Promise<unknown>): Promise<void> {
    let body: unknown;
    try {
      body = await work();
    } catch (error) {
      if (error instanceof NcomRefusal) {
        await ncomJson(reply, error.status, error.body, error.headers);
        return;
      }
      throw error;
    }
    await ncomJson(reply, 200, body);
  }

  private async answer(
    reply: FastifyReply,
    work: () => Promise<{ readonly status: number; readonly body: unknown }>,
  ): Promise<void> {
    try {
      const answer = await work();
      await ncomJson(reply, answer.status, answer.body);
    } catch (error) {
      if (error instanceof NcomRefusal) {
        await ncomJson(reply, error.status, error.body, error.headers);
        return;
      }
      throw error;
    }
  }
}
