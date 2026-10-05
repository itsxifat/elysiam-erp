import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Injectable,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { defineAbilityFor, scannerPairSchema, shipmentCodeSchema } from '@elysium/contracts';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AuditExempt } from '../../platform/audit/audit.interceptor.js';
import { Public, RequireAbility } from '../../platform/auth/abilities.js';
import { scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { requireContext } from '../../platform/http/context.js';
import { bearerOf } from './device-token.js';
import { ScannerService, type DeviceCaller } from './scanner.service.js';

const DEVICE = Symbol('packing:device');
type WithDevice = FastifyRequest & { [DEVICE]?: DeviceCaller; requestId?: string };

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

/**
 * The scanner app's bearer device token (D-554): verified before the handler, the person read
 * again, and their `read Order` scope hung on the request exactly as the ability guard hangs a
 * session's. Every failure is the same 401.
 */
@Injectable()
export class ScannerDeviceGuard implements CanActivate {
  constructor(private readonly scanner: ScannerService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<WithDevice>();
    const token = bearerOf(request.headers.authorization);
    const caller =
      token === null ? null : await this.scanner.verify(token, request.requestId ?? '');
    if (caller === null) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'This scanner is not signed in. Sign in again.',
      });
    }
    request[DEVICE] = caller;
    this.scanner.scope(request, caller);
    return true;
  }
}

function deviceOf(request: FastifyRequest): DeviceCaller {
  const caller = (request as WithDevice)[DEVICE];
  if (caller === undefined) throw new UnauthorizedException('This scanner is not signed in.');
  return caller;
}

const DEVICE_TOKEN =
  'The packing scanner app has no session: a bearer device token from /v1/scanner/sign-in or the console authenticates it, and the person behind it is read again on every call (D-554).';

/**
 * The packing scanner (M35b, D-554): the phone app's routes (a device token) and the console's
 * (a session). The app's sign-in itself is the identity module's (`POST /v1/scanner/sign-in`):
 * it is the one place passwords and second factors are checked.
 */
@Controller('v1/scanner')
export class ScannerController {
  constructor(private readonly scanner: ScannerService) {}

  // --- the phone ------------------------------------------------------------------------------

  @Public(DEVICE_TOKEN)
  @UseGuards(ScannerDeviceGuard)
  @Get('shipment')
  async shipment(@Req() request: FastifyRequest, @Query('code') code: unknown) {
    const caller = deviceOf(request);
    const scanned = parse(shipmentCodeSchema, typeof code === 'string' ? code : '');
    return this.scanner.shipment(caller.orgId, request, scanned, null);
  }

  @Public(DEVICE_TOKEN)
  @UseGuards(ScannerDeviceGuard)
  @AuditExempt('A device ends its own sign-in: the device row records when and by whom.')
  @Post('sign-out')
  @HttpCode(200)
  async signOut(@Req() request: FastifyRequest) {
    return this.scanner.signOut(deviceOf(request));
  }

  // --- the console ----------------------------------------------------------------------------

  /** The Scan page's lookup: the same packing list, in the session's own scope. */
  @RequireAbility('read', 'Order')
  @Get('lookup')
  async lookup(@Req() request: FastifyRequest, @Query('code') code: unknown) {
    const context = requireContext(request);
    const scanned = parse(shipmentCodeSchema, typeof code === 'string' ? code : '');
    return this.scanner.shipment(context.orgId, request, scanned, null);
  }

  @RequireAbility('read', 'Order')
  @Get('devices')
  async devices(@Req() request: FastifyRequest) {
    const context = requireContext(request);
    scopeHasNoRowDimension(request, 'scanner devices are people’s sign-ins, not order rows');
    return this.scanner.list(context, defineAbilityFor(context).can('update', 'User'));
  }

  /** Pair a phone from the console: a sign-in code, shown once, to paste into the app. */
  @RequireAbility('read', 'Order')
  @Post('devices')
  async pair(@Req() request: FastifyRequest, @Body() body: unknown) {
    const context = requireContext(request);
    const input = parse(scannerPairSchema, body ?? {});
    scopeHasNoRowDimension(request, 'pairing signs the caller’s own phone in; it reads no order');
    return this.scanner.pair(context, input.deviceName);
  }

  @RequireAbility('read', 'Order')
  @Post('devices/:id/revoke')
  @HttpCode(200)
  async revoke(@Req() request: FastifyRequest, @Param('id') id: string) {
    const context = requireContext(request);
    scopeHasNoRowDimension(request, 'a scanner device is a person’s sign-in, not an order row');
    return this.scanner.revoke(
      context,
      parse(idSchema, id),
      defineAbilityFor(context).can('update', 'User'),
    );
  }
}
