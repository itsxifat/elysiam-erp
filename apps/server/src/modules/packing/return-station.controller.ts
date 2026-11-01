import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  TERMINAL_DEVICE_HEADER,
  packingRemovalSchema,
  packingScanSchema,
  packingSessionsQuerySchema,
} from '@elysium/contracts';
import {
  packingReturnOpenSchema,
  packingReturnReceiveSchema,
} from '@elysium/contracts/packing-returns';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { ReturnStationService } from './return-station.service.js';
import { terminalTokenOf } from './terminal-token.js';

const idSchema = z.string().uuid('No such record.');

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

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * The return station over HTTP (M51, D-934): Packaging → Returns. Receiving a return is
 * `update Order` — §6 gives the warehouse that grant "to pack, ship and receive returns" — and
 * every route applies the caller's scope to the order first. Its videos play through the packing
 * video's own route (`read PackingVideo`).
 */
@Controller('v1/packing/returns')
export class ReturnStationController {
  constructor(private readonly returns: ReturnStationService) {}

  /** Open the return station on a parcel by its scanned label or the order's id, or resume it. */
  @RequireAbility('update', 'Order')
  @Post()
  @HttpCode(200)
  async open(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(packingReturnOpenSchema, body);
    return this.returns.open(
      requireContext(request),
      auditable(request),
      input,
      terminalTokenOf(request.headers[TERMINAL_DEVICE_HEADER]),
    );
  }

  /** The recent return inspections, newest first, of orders the caller may see. */
  @RequireAbility('read', 'Order')
  @Get()
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    const input = parse(packingSessionsQuerySchema, query ?? {});
    return this.returns.list(requireContext(request), request, input);
  }

  /** The order page's return record: its inspection, or none. */
  @RequireAbility('read', 'Order')
  @Get('orders/:orderId')
  async forOrder(@Req() request: FastifyRequest, @Param('orderId') orderId: string) {
    return this.returns.forOrder(requireContext(request), request, parse(idSchema, orderId));
  }

  @RequireAbility('read', 'Order')
  @Get(':id')
  async get(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.returns.get(requireContext(request), request, parse(idSchema, id));
  }

  /** One scan: the parcel's label starts or stops a bag; anything else is a piece back. */
  @RequireAbility('update', 'Order')
  @Post(':id/scans')
  @HttpCode(200)
  async scan(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(packingScanSchema, body);
    return this.returns.scan(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }

  /** Take one piece scanned back by mistake out again. */
  @RequireAbility('update', 'Order')
  @Post(':id/removals')
  @HttpCode(200)
  async remove(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(packingRemovalSchema, body);
    return this.returns.remove(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }

  /** Receive the inspected return into stock, in one transaction with its receipt. */
  @RequireAbility('update', 'Order')
  @Post(':id/receive')
  @HttpCode(200)
  async receive(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(packingReturnReceiveSchema, body);
    return this.returns.receive(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }
}
