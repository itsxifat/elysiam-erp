import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  TERMINAL_DEVICE_HEADER,
  handoverScanSchema,
  handoverShipSchema,
  lotCountSchema,
} from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { LotsService } from './lots.service.js';
import { PackStationService } from './station.service.js';
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
 * Lots and the courier's handover over HTTP (M46, D-805 to D-808). All `update Order`, the hub's
 * grant, with the caller's scope applied to the order before anything is read or changed. No
 * route takes a status: closing the last lot is Finish, and handing over asks the order's state
 * machine to `ship`.
 */
@Controller('v1/packing')
export class LotsController {
  constructor(
    private readonly lots: LotsService,
    private readonly station: PackStationService,
  ) {}

  /** How many bags the order goes in (D-805): 1 to 20, until the handover starts. */
  @RequireAbility('update', 'Order')
  @Put('orders/:orderId/lots')
  async setLots(
    @Req() request: FastifyRequest,
    @Param('orderId') orderId: string,
    @Body() body: unknown,
  ) {
    const input = parse(lotCountSchema, body);
    return this.lots.setLotCount(
      requireContext(request),
      auditable(request),
      parse(idSchema, orderId),
      input,
    );
  }

  /** Close the open lot at the packing station (D-807); the next scans fill the next one. */
  @RequireAbility('update', 'Order')
  @Post('sessions/:id/lots/close')
  @HttpCode(200)
  async closeLot(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.station.closeLot(requireContext(request), auditable(request), parse(idSchema, id));
  }

  /** The handover's list: packed orders scanned today, with what each still needs (D-808). */
  @RequireAbility('update', 'Order')
  @Get('handover')
  async pending(@Req() request: FastifyRequest) {
    return this.lots.pending(requireContext(request), request);
  }

  /** One label scanned as its parcel goes to the courier (D-808). */
  @RequireAbility('update', 'Order')
  @Post('handover/scans')
  @HttpCode(200)
  async scan(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(handoverScanSchema, body);
    return this.lots.scan(
      requireContext(request),
      auditable(request),
      input,
      terminalTokenOf(request.headers[TERMINAL_DEVICE_HEADER]),
    );
  }

  /** Hand these orders to the courier: each only with every lot scanned (D-808). */
  @RequireAbility('update', 'Order')
  @Post('handover')
  @HttpCode(200)
  async ship(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(handoverShipSchema, body);
    return this.lots.ship(requireContext(request), auditable(request), input);
  }
}
