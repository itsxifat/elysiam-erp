import { Readable } from 'node:stream';

import { Injectable, PayloadTooLargeException, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * The exact bytes of a Meta webhook (M42, D-732).
 *
 * Meta signs the body it sent (`X-Hub-Signature-256`), and by the time a handler runs Fastify
 * has parsed those bytes into an object that does not serialise back to them. So, as the order
 * intake (`intake/raw-body.ts`) and ncom's connector do for their paths, a `preParsing` hook
 * keeps the bytes of every `POST` under `/webhooks/meta/` and hands Fastify a fresh stream of the
 * same bytes; Fastify's own JSON parser still runs, with its prototype-poisoning protection.
 *
 * Capped at 2 MiB: Meta batches up to 1,000 updates in one body, and an unauthenticated endpoint
 * should not buffer more than that from a stranger before the signature is checked.
 */

export const META_WEBHOOK_PREFIX = '/webhooks/meta/';
export const META_WEBHOOK_BODY_LIMIT_BYTES = 2 * 1024 * 1024;

const RAW_BODY = Symbol('elysium:meta-webhook-raw-body');

type WithRawBody = FastifyRequest & { [RAW_BODY]?: Buffer };

/** The bytes the hook kept, or an empty buffer for a request it did not handle. */
export function metaRawBodyOf(request: FastifyRequest): Buffer {
  return (request as WithRawBody)[RAW_BODY] ?? Buffer.alloc(0);
}

@Injectable()
export class MetaWebhookRawBody implements OnModuleInit {
  constructor(private readonly adapters: HttpAdapterHost) {}

  onModuleInit(): void {
    const instance = this.adapters.httpAdapter?.getInstance<FastifyInstance>();
    if (instance === undefined) return;

    instance.addHook('preParsing', async (request, _reply, payload) => {
      const path = request.url.split('?')[0] ?? '';
      if (request.method !== 'POST' || !path.startsWith(META_WEBHOOK_PREFIX)) return payload;

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += buffer.length;
        if (size > META_WEBHOOK_BODY_LIMIT_BYTES) {
          throw new PayloadTooLargeException({
            code: 'PAYLOAD_TOO_LARGE',
            message: 'A webhook body may be at most 2 MiB.',
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
  }
}
