import { ALLOWED_MIME_TYPES } from '@elysium/integrations';
import { Injectable, UnsupportedMediaTypeException, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import { FilesService } from './files.service.js';

/** The local driver's signed PUT target, as Fastify's router names the route. */
export const SIGNED_PUT_ROUTE = '/v1/files/content';

/** The upload types, whose parsers take up to a type's ceiling (a video's 90 MiB). */
const UPLOAD_TYPES: ReadonlySet<string> = new Set(ALLOWED_MIME_TYPES.map((rule) => rule.mime));

/** The request's media type, without parameters, in lower case. */
function mediaType(request: FastifyRequest): string {
  return (
    String(request.headers['content-type'] ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase() ?? ''
  );
}

/** The declared `Content-Length`, when the request declares a usable one. */
function declaredLength(request: FastifyRequest): number | undefined {
  const raw = request.headers['content-length'];
  if (typeof raw !== 'string' || !/^\d{1,16}$/.test(raw.trim())) return undefined;
  return Number(raw.trim());
}

/**
 * Check a signed PUT's token before Fastify reads its body (M38b audit, W3).
 *
 * `PUT /v1/files/content` is `@Public`: the token in `?t=` is the credential. The handler
 * checked it, but a handler runs after the body parser, and the parser for a packing video
 * accepts up to 90 MiB — so a stranger with a junk token could make this process hold 90 MiB
 * per request before anything said no. An `onRequest` hook runs once the route is matched and
 * before a byte of the body is read; `FilesService.assertUploadRequest` checks the token's
 * signature, expiry and method, the declared content type against the signed one and the
 * declared length against that type's ceiling, and throws the handler's own refusals, which
 * Nest's exception layer (the global `ProblemFilter`) answers as problem+json.
 *
 * Matched on `routeOptions.url`, the route Fastify chose, not on the raw URL: a trailing
 * slash or an encoded character that still reaches the handler still reaches this hook.
 * Registered from `OnModuleInit`, like `FileUploadBodyParser` and the intake's raw body, so
 * the HTTP tests get the hook production has.
 */
@Injectable()
export class FileUploadGate implements OnModuleInit {
  constructor(
    private readonly adapters: HttpAdapterHost,
    private readonly files: FilesService,
  ) {}

  onModuleInit(): void {
    const instance = this.adapters.httpAdapter?.getInstance<FastifyInstance>();
    if (instance === undefined) return;

    instance.addHook('onRequest', (request, _reply, done) => {
      if (request.method !== 'PUT' || request.routeOptions.url !== SIGNED_PUT_ROUTE) {
        // The upload parsers are the application's, so they would read a video-typed body of
        // up to 90 MiB on any route before its guard ran (the M38b re-check): only the signed
        // PUT takes an upload type; every other route refuses one before reading a byte.
        if (UPLOAD_TYPES.has(mediaType(request))) {
          done(
            new UnsupportedMediaTypeException({
              code: 'UNSUPPORTED_MEDIA_TYPE',
              message: 'Send JSON.',
            }),
          );
          return;
        }
        done();
        return;
      }
      try {
        const query = request.query as Record<string, unknown> | undefined;
        const token = typeof query?.t === 'string' ? query.t : '';
        this.files.assertUploadRequest(
          token,
          String(request.headers['content-type'] ?? ''),
          declaredLength(request),
        );
        done();
      } catch (error) {
        done(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
}
