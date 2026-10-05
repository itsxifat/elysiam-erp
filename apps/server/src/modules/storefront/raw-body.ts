import { Readable } from 'node:stream';

import {
  Injectable,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
  type OnModuleInit,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * The exact bytes of a storefront write, and SSLCommerz's form posts (M34, D-525).
 *
 * **Signed writes.** A website write is signed over its raw body (`signature.ts`), and by the
 * time a guard runs Fastify has parsed the bytes into an object that does not serialise back
 * to them. So, as the intake does for its path (`intake/raw-body.ts`), a `preParsing` hook keeps
 * the bytes of every `POST` or `PATCH` under `/storefront/v1/` and hands Fastify a fresh stream
 * of the same bytes; Fastify's own JSON parser still runs. Capped at 64 KiB: a checkout is a
 * few kilobytes, and an unsigned request should not buffer a megabyte from a stranger.
 *
 * **The IPN.** SSLCommerz posts `application/x-www-form-urlencoded`, which this API otherwise
 * does not accept. A parser for that type is registered, and refuses every path but the IPN's
 * (`/storefront/ipn/`): a form post to any other route stays the 415 it was, so no cookie
 * route grows a form-encoded way in.
 */

export const STOREFRONT_WRITE_PREFIX = '/storefront/v1/';
export const SSLCOMMERZ_IPN_PREFIX = '/storefront/ipn/';
export const STOREFRONT_BODY_LIMIT_BYTES = 64 * 1024;

const RAW_BODY = Symbol('elysium:storefront-raw-body');

type WithRawBody = FastifyRequest & { [RAW_BODY]?: Buffer };

/** The bytes the hook kept, or undefined for a request it did not handle. */
export function storefrontRawBodyOf(request: FastifyRequest): Buffer | undefined {
  return (request as WithRawBody)[RAW_BODY];
}

function pathOf(url: string): string {
  return url.split('?')[0] ?? '';
}

@Injectable()
export class StorefrontRawBody implements OnModuleInit {
  constructor(private readonly adapters: HttpAdapterHost) {}

  onModuleInit(): void {
    const instance = this.adapters.httpAdapter?.getInstance<FastifyInstance>();
    if (instance === undefined) return;

    instance.addHook('preParsing', async (request, _reply, payload) => {
      if (request.method !== 'POST' && request.method !== 'PATCH') return payload;
      if (!pathOf(request.url).startsWith(STOREFRONT_WRITE_PREFIX)) return payload;

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += buffer.length;
        if (size > STOREFRONT_BODY_LIMIT_BYTES) {
          throw new PayloadTooLargeException({
            code: 'PAYLOAD_TOO_LARGE',
            message: 'A storefront request body may be at most 64 KiB.',
          });
        }
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks);
      (request as WithRawBody)[RAW_BODY] = raw;
      const replay = Readable.from([raw]) as Readable & { receivedEncodedLength?: number };
      replay.receivedEncodedLength = raw.length;
      return replay;
    });

    const form = 'application/x-www-form-urlencoded';
    if (!instance.hasContentTypeParser(form)) {
      instance.addContentTypeParser(
        form,
        { parseAs: 'string', bodyLimit: 16 * 1024 },
        (request, body, done) => {
          if (!pathOf(request.url).startsWith(SSLCOMMERZ_IPN_PREFIX)) {
            done(
              new UnsupportedMediaTypeException({
                code: 'UNSUPPORTED_MEDIA_TYPE',
                message: 'Send JSON.',
              }),
              undefined,
            );
            return;
          }
          const fields = Object.create(null) as Record<string, string>;
          for (const [key, value] of new URLSearchParams(String(body))) {
            if (key.length <= 64 && !(key in fields)) fields[key] = value.slice(0, 1_000);
          }
          done(null, fields);
        },
      );
    }
  }
}
