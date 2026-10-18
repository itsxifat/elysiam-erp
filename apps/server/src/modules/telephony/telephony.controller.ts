import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import {
  phoneCallAnsweredSchema,
  phoneCallListQuerySchema,
  phoneCallOutcomeSchema,
  phoneCallPlaceSchema,
  phoneLookupQuerySchema,
  telephonyAssignSchema,
  telephonyConnectionCreateSchema,
  telephonyConnectionUpdateSchema,
} from '@elysium/contracts/telephony';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { requireContext } from '../../platform/http/context.js';
import { TelephonyCallsService } from './calls.service.js';
import { TelephonyConnectionsService } from './connections.service.js';

const idSchema = z.string().uuid('No such record.');
const extensionSchema = z.string().regex(/^[0-9]{2,8}$/, 'An extension is two to eight digits.');
const envoCallIdSchema = z.string().regex(/^[0-9]{1,20}(\.[0-9]{1,10})?$/, 'No such call.');

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
 * Phone calls through Envo over HTTP (M47, D-830 to D-853).
 *
 * - Settings → Calls: `read Telephony` (org_admin, branch_manager) to see the connections and the
 *   calls in progress, `create`/`update Telephony` (org_admin) to add, change and test one;
 *   `read`/`update PhoneExtension` (org_admin, branch_manager) for the extensions and who has
 *   them.
 * - Calling: `create PhoneCall` (org_admin, branch_manager, and sales from their own extension)
 *   to call, to record a call's outcome, for the web phone's token and the caller's screen pop;
 *   `read PhoneCall` for the log and the recordings (sales: their own and their orders' calls,
 *   D-841); `update PhoneCall` (the supervisors) to hang up a call in progress.
 */
@Controller('v1/telephony')
export class TelephonyController {
  constructor(
    private readonly connections: TelephonyConnectionsService,
    private readonly calls: TelephonyCallsService,
  ) {}

  // --- Settings → Calls --------------------------------------------------------------------------

  @RequireAbility('read', 'Telephony')
  @Get('connections')
  async listConnections(@Req() request: FastifyRequest) {
    return this.connections.list(requireContext(request));
  }

  @RequireAbility('create', 'Telephony')
  @Post('connections')
  async createConnection(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.connections.create(
      requireContext(request),
      auditable(request),
      parse(telephonyConnectionCreateSchema, body),
    );
  }

  @RequireAbility('update', 'Telephony')
  @Put('connections/:id')
  async updateConnection(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.connections.update(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(telephonyConnectionUpdateSchema, body),
    );
  }

  /** Reads Envo's extensions and numbers with the connection's key (acceptance check 1). */
  @RequireAbility('update', 'Telephony')
  @Post('connections/:id/test')
  @HttpCode(200)
  async testConnection(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.connections.test(requireContext(request), auditable(request), parse(idSchema, id));
  }

  @RequireAbility('read', 'PhoneExtension')
  @Get('connections/:id/extensions')
  async extensions(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.connections.extensions(requireContext(request), parse(idSchema, id));
  }

  @RequireAbility('update', 'PhoneExtension')
  @Put('connections/:id/extensions/:extension')
  async assign(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('extension') extension: string,
    @Body() body: unknown,
  ) {
    const input = parse(telephonyAssignSchema, {
      ...(typeof body === 'object' && body !== null ? body : {}),
      extension,
    });
    return this.connections.assign(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input.extension,
      input.userId,
    );
  }

  @RequireAbility('update', 'PhoneExtension')
  @Delete('connections/:id/extensions/:extension')
  async unassign(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('extension') extension: string,
  ) {
    return this.connections.unassign(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(extensionSchema, extension),
    );
  }

  /** Who has which extension, brand-wide (the Staff screen). */
  @RequireAbility('read', 'PhoneExtension')
  @Get('assignments')
  async assignments(@Req() request: FastifyRequest) {
    return this.connections.assignments(requireContext(request));
  }

  @RequireAbility('read', 'Telephony')
  @Get('connections/:id/live')
  async live(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.connections.live(requireContext(request), parse(idSchema, id));
  }

  @RequireAbility('update', 'PhoneCall')
  @Post('connections/:id/live/:callId/hangup')
  @HttpCode(200)
  async hangup(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('callId') callId: string,
  ) {
    scopeHasNoRowDimension(request, 'a call in progress on the brand’s SIP server, by Envo’s id');
    return this.connections.hangup(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(envoCallIdSchema, callId),
    );
  }

  // --- calling -----------------------------------------------------------------------------------

  @RequireAbility('read', 'PhoneCall')
  @Get('me')
  async me(@Req() request: FastifyRequest) {
    return this.calls.me(requireContext(request), request);
  }

  /** The web phone's token, for the caller's own extension (D-843). */
  @RequireAbility('create', 'PhoneCall')
  @Get('phone/token')
  async phoneToken(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    void reply.header('cache-control', 'no-store');
    return this.calls.phoneToken(requireContext(request), request);
  }

  @RequireAbility('create', 'PhoneCall')
  @Get('lookup')
  async lookup(@Req() request: FastifyRequest, @Query() query: unknown) {
    return this.calls.lookup(
      requireContext(request),
      request,
      parse(phoneLookupQuerySchema, query).phone,
    );
  }

  /** Call a customer from your own extension; an order needs its owner acknowledged (D-710). */
  @RequireAbility('create', 'PhoneCall')
  @Post('calls')
  async place(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.calls.place(
      requireContext(request),
      auditable(request),
      parse(phoneCallPlaceSchema, body),
    );
  }

  @RequireAbility('create', 'PhoneCall')
  @Post('calls/answered')
  @HttpCode(200)
  async answered(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.calls.answered(
      requireContext(request),
      auditable(request),
      parse(phoneCallAnsweredSchema, body),
    );
  }

  @RequireAbility('read', 'PhoneCall')
  @Get('calls')
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    return this.calls.list(
      requireContext(request),
      request,
      parse(phoneCallListQuerySchema, query),
    );
  }

  @RequireAbility('read', 'PhoneCall')
  @Get('calls/:id')
  async one(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.calls.one(requireContext(request), request, parse(idSchema, id));
  }

  /**
   * A call's recording, to a person who may see the call: the bytes, not JSON, so `@Res()` and a
   * manual send (nothing in a recording is a cost). Private, cached briefly in the browser only.
   */
  @RequireAbility('read', 'PhoneCall')
  @Get('calls/:id/recording')
  async recording(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const recording = await this.calls.recording(
      requireContext(request),
      request,
      parse(idSchema, id),
    );
    await reply
      .header('content-type', recording.mime)
      .header('content-length', String(recording.bytes.byteLength))
      .header('cache-control', 'private, max-age=300')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', 'inline')
      .send(Buffer.from(recording.bytes));
  }

  /** M41's verification outcome for a call about an order (D-838). */
  @RequireAbility('create', 'PhoneCall')
  @Post('calls/:id/outcome')
  async outcome(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    return this.calls.outcome(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(phoneCallOutcomeSchema, body),
    );
  }
}
