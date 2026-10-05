import {
  Controller,
  Get,
  HttpException,
  HttpStatus,
  NotFoundException,
  Param,
  Req,
  Res,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { Public } from '../../platform/auth/abilities.js';
import { MemoryRateLimiter } from '../../platform/http/rate-limit.js';
import { filesEnv } from './files.config.js';
import { FilesService, PUBLIC_VARIANTS, type PublicVariant } from './files.service.js';

/**
 * The website's images (M33, D-507): `GET /media/<org id>/<file id>/<thumb|card|full>`.
 *
 * `@Public`, because a shopper's browser and the website's image optimiser fetch these with
 * no session and no key, and an image on a product page is public by nature. What keeps it
 * from being a hole is what it refuses to serve: only a stored, public file of a website
 * purpose (`PUBLIC_MEDIA_PURPOSES`: product, category and website images), only its
 * re-encoded sizes, and only inside the brand the URL names. Everything else — a payslip, a
 * KYC scan, a pending upload, a private product photo, another brand's file, an unknown
 * size — is the same 404, so the path cannot be used to learn which ids exist.
 *
 * The org id is in the path because the request has no other way to name its tenant, and
 * `files.objects` is under FORCE RLS (the site key carries its org for the same reason). It
 * names no brand: it is the uuid the storefront API already put in the URL it handed out.
 *
 * The bytes never change for a file id and size (the variants are written once, when the
 * upload is finalised), so the response is cacheable for a year, `immutable`, with the
 * variant's SHA-256 as its ETag. nginx or a CDN in front keeps the API from serving the
 * same image twice (§28).
 */
@Controller('media')
export class PublicMediaController {
  /**
   * Requests a minute from one address before `429` (`MEDIA_RATE_PER_MINUTE`, M33's ledger
   * audit, L5). Per process, in memory: this guards the API's connection pool against a
   * flood that skipped the CDN, and an exact cross-replica count is not what it is for.
   */
  private readonly limiter = new MemoryRateLimiter();
  private readonly perMinute = filesEnv().MEDIA_RATE_PER_MINUTE;

  constructor(private readonly files: FilesService) {}

  @Public(
    "The brand website's images: public by nature, served only for stored public files of a website purpose (D-507).",
  )
  @Get(':orgId/:fileId/:variant')
  async media(
    @Param('orgId') orgId: string,
    @Param('fileId') fileId: string,
    @Param('variant') variant: string,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const decision = this.limiter.hit(`media:${request.ip}`, this.perMinute, 60);
    if (!decision.allowed) {
      void reply.header('retry-after', String(decision.retryAfterSeconds ?? 60));
      throw new HttpException(
        { code: 'RATE_LIMITED', message: 'Too many requests. Wait and try again.' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    const name = variant.replace(/\.webp$/, '');
    if (!(PUBLIC_VARIANTS as readonly string[]).includes(name)) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found.' });
    }
    const media = await this.files.publicVariant(orgId, fileId, name as PublicVariant);
    if (media === null) throw new NotFoundException({ code: 'NOT_FOUND', message: 'Not found.' });

    const etag = `"${media.sha256}"`;
    void reply
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', etag)
      .header('x-content-type-options', 'nosniff')
      .header('cross-origin-resource-policy', 'cross-origin');
    if (request.headers['if-none-match'] === etag) {
      await reply.code(304).send();
      return;
    }
    await reply
      .header('content-type', media.mime)
      .header('content-length', String(media.bytes.byteLength))
      .send(Buffer.from(media.bytes));
  }
}
