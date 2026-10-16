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
  TERMINAL_DEVICE_HEADER,
  defineAbilityFor,
  packingCameraCreateSchema,
  packingCameraUpdateSchema,
  packingOpenSchema,
  packingRemovalSchema,
  packingScanSchema,
  packingSessionsQuerySchema,
  packingSettingsSchema,
  packingVideoFileSchema,
  packingVideoStartSchema,
} from '@elysium/contracts';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { requireContext } from '../../platform/http/context.js';
import { CameraSettingsService } from './camera-settings.service.js';
import { PackStationService } from './station.service.js';
import { terminalTokenOf } from './terminal-token.js';
import { PackingVideoService } from './video.service.js';

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
 * The packing station and the packing video over HTTP (M38b, D-610 to D-615).
 *
 * Packing is `update Order` — §6 gives the warehouse that grant org-wide "to pack, ship and
 * receive returns", sales on their own orders — and every route applies the caller's scope to
 * the order before it reads or changes anything (`OrdersApi.orderVisibleTo`). Watching a video
 * is `read PackingVideo` (org_admin and the warehouse across the brand, sales on their own
 * orders), with that grant's scope applied to the order the same way. No route takes a status:
 * finishing asks the order's state machine to `pack`.
 */
@Controller('v1/packing')
export class PackStationController {
  constructor(
    private readonly station: PackStationService,
    private readonly videos: PackingVideoService,
    private readonly cameras: CameraSettingsService,
  ) {}

  /** Open the station on an order by a scanned code or its id, or resume its session. */
  @RequireAbility('update', 'Order')
  @Post('sessions')
  @HttpCode(200)
  async open(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(packingOpenSchema, body);
    // M46 (D-802): a computer bound to a packing terminal sends its token.
    return this.station.open(
      requireContext(request),
      auditable(request),
      input,
      terminalTokenOf(request.headers[TERMINAL_DEVICE_HEADER]),
    );
  }

  /** The recent sessions, newest first, of orders the caller may see (D-617). */
  @RequireAbility('read', 'Order')
  @Get('sessions')
  async list(@Req() request: FastifyRequest, @Query() query: unknown) {
    const input = parse(packingSessionsQuerySchema, query ?? {});
    return this.station.list(requireContext(request), request, input);
  }

  @RequireAbility('read', 'Order')
  @Get('sessions/:id')
  async get(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.station.get(requireContext(request), request, parse(idSchema, id));
  }

  /** One piece scanned: taken, or refused and recorded (a refusal is an answer, not an error). */
  @RequireAbility('update', 'Order')
  @Post('sessions/:id/scans')
  @HttpCode(200)
  async scan(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(packingScanSchema, body);
    return this.station.scan(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }

  /** Take one piece of an item back out. */
  @RequireAbility('update', 'Order')
  @Post('sessions/:id/removals')
  @HttpCode(200)
  async remove(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(packingRemovalSchema, body);
    return this.station.remove(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }

  /** Every piece in the box: the order moves to `packed` through the state machine, once. */
  @RequireAbility('update', 'Order')
  @Post('sessions/:id/complete')
  @HttpCode(200)
  async complete(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.station.complete(requireContext(request), auditable(request), parse(idSchema, id));
  }

  /** A recording started at the station: its part registered under the browser's id. */
  @RequireAbility('update', 'Order')
  @Post('sessions/:id/videos')
  @HttpCode(200)
  async startVideo(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const input = parse(packingVideoStartSchema, body);
    return this.videos.start(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }

  /** A recording's finalized upload, attached to its part. */
  @RequireAbility('update', 'Order')
  @Post('sessions/:id/videos/:videoId/file')
  @HttpCode(200)
  async attachVideo(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Param('videoId') videoId: string,
    @Body() body: unknown,
  ) {
    const input = parse(packingVideoFileSchema, body);
    return this.videos.attach(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      parse(idSchema, videoId),
      input,
    );
  }

  /** A short-lived URL to play one part (D-614). */
  @RequireAbility('read', 'PackingVideo')
  @Get('videos/:id/url')
  async videoUrl(@Req() request: FastifyRequest, @Param('id') id: string) {
    return this.videos.url(requireContext(request), request, parse(idSchema, id));
  }

  /** The order page's packing record: who packed, every scan, the video's parts. */
  @RequireAbility('read', 'Order')
  @Get('orders/:orderId')
  async forOrder(@Req() request: FastifyRequest, @Param('orderId') orderId: string) {
    const context = requireContext(request);
    return this.station.forOrder(
      context,
      request,
      parse(idSchema, orderId),
      defineAbilityFor(context).can('read', 'PackingVideo'),
    );
  }

  /** The brand's packing settings, for whoever packs (D-615). */
  @RequireAbility('update', 'Order')
  @Get('settings')
  async settings(@Req() request: FastifyRequest) {
    const context = requireContext(request);
    scopeHasNoRowDimension(request, 'the packing settings are the brand’s, not an order’s');
    return this.station.settings(context, defineAbilityFor(context).can('update', 'PackingVideo'));
  }

  /** Recording on or off for the brand: org_admin (D-615). */
  @RequireAbility('update', 'PackingVideo')
  @Put('settings')
  async saveSettings(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(packingSettingsSchema, body);
    scopeHasNoRowDimension(request, 'the packing settings are the brand’s, not an order’s');
    return this.station.saveSettings(requireContext(request), auditable(request), input);
  }

  /**
   * The packing tables' IP cameras and whether each is filming (M38c, D-668, D-670), for
   * whoever packs, to choose one at the station. Their addresses and user names only for an
   * org admin; the password never.
   */
  @RequireAbility('update', 'Order')
  @Get('cameras')
  async listCameras(@Req() request: FastifyRequest) {
    const context = requireContext(request);
    scopeHasNoRowDimension(request, 'the packing cameras are the brand’s, not an order’s');
    return this.cameras.list(context, defineAbilityFor(context).can('update', 'PackingVideo'));
  }

  /** Add an IP camera: org_admin (D-668, D-669). The password is sealed, never returned. */
  @RequireAbility('update', 'PackingVideo')
  @Post('cameras')
  async addCamera(@Req() request: FastifyRequest, @Body() body: unknown) {
    const input = parse(packingCameraCreateSchema, body);
    scopeHasNoRowDimension(request, 'the packing cameras are the brand’s, not an order’s');
    return this.cameras.create(requireContext(request), auditable(request), input);
  }

  /**
   * Delete a camera from use (D-684): org_admin. Refused while it is recording a packing; past
   * videos keep playing.
   */
  @RequireAbility('update', 'PackingVideo')
  @Delete('cameras/:id')
  async deleteCamera(@Req() request: FastifyRequest, @Param('id') id: string) {
    scopeHasNoRowDimension(request, 'the packing cameras are the brand’s, not an order’s');
    return this.cameras.remove(requireContext(request), auditable(request), parse(idSchema, id));
  }

  /**
   * One frame of a camera's live preview (D-683), a JPEG, for whoever packs (`update Order`;
   * resellers hold none). Asking keeps the preview running; 204 when no fresh frame is in.
   */
  @RequireAbility('update', 'Order')
  @Get('cameras/:id/preview')
  async cameraPreview(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    scopeHasNoRowDimension(request, 'the packing cameras are the brand’s, not an order’s');
    const frame = await this.cameras.livePreview(requireContext(request), parse(idSchema, id));
    if (frame === null) {
      // No fresh frame yet, or the camera stopped sending: an answer, not an error (W2).
      await reply.code(204).header('cache-control', 'no-store').send();
      return;
    }
    await reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'no-store')
      .send(frame);
  }

  /** Change a camera, switch it off, or replace or remove its password: org_admin. */
  @RequireAbility('update', 'PackingVideo')
  @Put('cameras/:id')
  async updateCamera(
    @Req() request: FastifyRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const input = parse(packingCameraUpdateSchema, body);
    scopeHasNoRowDimension(request, 'the packing cameras are the brand’s, not an order’s');
    return this.cameras.update(
      requireContext(request),
      auditable(request),
      parse(idSchema, id),
      input,
    );
  }
}
