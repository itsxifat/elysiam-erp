import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { Public, RequireAbility } from '../../platform/auth/abilities.js';
import { scopeWhere } from '../../platform/auth/scope.js';
import { requireContext } from '../../platform/http/context.js';
import { FilesService } from './files.service.js';
import { fileIdSchema, uploadTicketSchema } from './files.schemas.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

/**
 * Files over HTTP (architecture §22, §23).
 *
 * Four routes, and the split between them is the design:
 *
 * - `POST /v1/files` issues a presigned PUT. The bytes never pass through this
 *   process — an upload proxied through the API would hold a worker and a
 *   connection for the length of somebody's mobile upload.
 * - `POST /v1/files/:id/finalize` is where the server looks at what arrived.
 *   Until it runs, the row is `pending` and nothing can download it.
 * - `GET /v1/files/:id/download` authorizes and *then* signs.
 * - `GET /v1/files/content?t=…` serves the bytes and `PUT` accepts them,
 *   for the local driver only. Both are `@Public` because the token is the
 *   credential: it was minted for one key, with one method, and it expires.
 *   In production R2 serves and accepts its own signed URLs and neither route
 *   is reached — which is why the local driver has them at all, so the client
 *   flow tests exercise is the one production runs.
 */
@Controller('v1/files')
export class FilesController {
  constructor(private readonly files: FilesService) {}

  /**
   * The caller's row scope, from this route's own declaration (§6).
   *
   * Both `createdBy` and `assignedTo` map to `owner_user_id`, and both have to
   * be mapped: an `own` scope expands into two conditions, and `scopeWhere`
   * throws rather than silently dropping one it has no column for — which is
   * right, because dropping a condition from an OR widens it. A reseller's
   * first upload was a 500 until both were here.
   *
   * Mapping them to the same column is not a fudge. A file has exactly one
   * person: whoever uploaded it. There is no separate assignee to be wrong
   * about, so "mine" and "assigned to me" are the same set.
   *
   * Leaving the call out altogether is not an option either:
   * `ScopeInterceptor` refuses to send a scoped caller's response unless the
   * handler applied the scope.
   */
  private scope(request: FastifyRequest) {
    return scopeWhere(request, {
      createdBy: sql`owner_user_id`,
      assignedTo: sql`owner_user_id`,
    });
  }

  @RequireAbility('create', 'FileObject')
  @Post()
  async createUpload(@Req() request: FastifyRequest, @Body() body: unknown) {
    const context = requireContext(request);
    const input = parse(uploadTicketSchema, body);
    // A `create` has nothing to filter, but the scope must still be applied:
    // a reseller's `own` grant means the row they are about to insert has to
    // be theirs, and `owner_user_id` is set from the context, never the body.
    this.scope(request);
    return this.files.createUploadTicket(context, input);
  }

  @RequireAbility('create', 'FileObject')
  @Post(':id/finalize')
  async finalize(@Req() request: FastifyRequest, @Param('id') id: string) {
    const context = requireContext(request);
    const fileId = parse(fileIdSchema, id);
    return this.files.finalizeUpload(context, fileId, this.scope(request));
  }

  /**
   * A short-lived URL for one file, issued only after the permission check.
   *
   * Returns the expiry alongside the URL, because a client that cannot see when
   * a link dies will cache it — and the bug then looks like "downloads
   * randomly stop working" rather than "the link expired".
   */
  @RequireAbility('read', 'FileObject')
  @Get(':id/download')
  async download(@Req() request: FastifyRequest, @Param('id') id: string) {
    const context = requireContext(request);
    const fileId = parse(fileIdSchema, id);
    const signed = await this.files.signDownload(context, fileId, this.scope(request));
    return {
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
      file: signed.file,
    };
  }

  /**
   * The local driver's presigned PUT target.
   *
   * The body arrives as a raw Buffer, because `FilesModule` registers a
   * content-type parser for every allowed upload type — Fastify would
   * otherwise answer 415 for `image/png`, since its built-in parsers cover
   * JSON and urlencoded and nothing else.
   */
  @Public('The signed token is the credential: one key, one method, expiring.')
  @Put('content')
  async upload(@Query('t') token: string, @Req() request: FastifyRequest) {
    const body = request.body;
    if (!Buffer.isBuffer(body)) {
      throw new BadRequestException('An upload must carry its bytes as the request body.');
    }
    await this.files.writeSignedContent(
      token,
      new Uint8Array(body),
      String(request.headers['content-type'] ?? ''),
    );
    return { ok: true };
  }

  @Public(
    'The signed token is the credential: minted after the permission check, one key, expiring.',
  )
  @Get('content')
  async content(@Query('t') token: string, @Res() reply: FastifyReply): Promise<void> {
    const object = await this.files.readSignedContent(token);

    /*
     * `Content-Disposition: attachment` and `X-Content-Type-Options: nosniff`
     * on every response, together.
     *
     * The content type on the row is sniffed from the bytes, so it is already
     * trustworthy — but this route serves user-uploaded bytes from the API's
     * own origin, and "the type is right" and "the browser agrees" are not the
     * same claim. Forcing a download and forbidding sniffing means even a file
     * that slipped through as HTML is saved rather than rendered, which is the
     * difference between a bad upload and stored XSS against every session
     * cookie scoped to this domain.
     */
    const filename = (object.filename ?? 'download').replace(/[^A-Za-z0-9._-]/g, '_');
    await reply
      .header('content-type', object.contentType)
      .header('content-length', String(object.bytes.byteLength))
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `attachment; filename="${filename}"`)
      // The URL already expires; telling shared caches not to keep a copy means
      // the expiry is the only thing that has to be right.
      .header('cache-control', 'private, no-store')
      .send(Buffer.from(object.bytes));
  }
}
