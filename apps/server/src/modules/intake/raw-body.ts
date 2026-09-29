import { Readable } from 'node:stream';

import { Injectable, PayloadTooLargeException, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Keep the exact bytes of a public order's body (architecture §23: "an HMAC signature over
 * body + timestamp").
 *
 * A signature is over bytes, and by the time a handler runs Fastify has turned the bytes
 * into an object. Re-serialising that object does not give the bytes back — key order,
 * whitespace and number spelling are the sender's — so a signature checked against
 * `JSON.stringify(request.body)` fails for every client whose JSON library is not ours, and
 * passes for a forged body that happens to serialise the same way.
 *
 * So a `preParsing` hook, for the public intake's paths only, reads the stream into a
 * buffer, keeps it on the request, and hands Fastify a fresh stream of the same bytes to
 * parse. Fastify's own JSON parser still runs — with its prototype-poisoning protection —
 * which is why this does not replace the parser: a hand-written `JSON.parse` for one route
 * would quietly be the one route without it.
 *
 * Registered from `OnModuleInit`, like `FileUploadBodyParser`, so the HTTP tests — which
 * build the application from modules and never run `main.api.ts` — get the same hook as
 * production. Hooks added before `ready()` apply to every route, including ones Nest
 * registered earlier: Fastify assembles each route's hook list at `preReady`.
 *
 * The body is capped here, below Fastify's global limit: a real order is a couple of
 * kilobytes, and an unauthenticated endpoint should not buffer a megabyte from a stranger
 * before it has checked a signature.
 */

export const INTAKE_PATH_PREFIX = '/public/v1/';
export const INTAKE_BODY_LIMIT_BYTES = 64 * 1024;

const RAW_BODY = Symbol('elysium:intake-raw-body');

type WithRawBody = FastifyRequest & { [RAW_BODY]?: Buffer };

/** The bytes the hook kept, or undefined for a request it did not handle. */
export function rawBodyOf(request: FastifyRequest): Buffer | undefined {
  return (request as WithRawBody)[RAW_BODY];
}

/**
 * An HTTP exception rather than a plain error with a `statusCode`: this throws from a
 * Fastify hook, and Nest's handler for hook errors turns anything that is not an
 * `HttpException` into a 500 — which would tell a landing page its oversized body was our
 * fault.
 */
function bodyTooLarge(): PayloadTooLargeException {
  return new PayloadTooLargeException({
    code: 'PAYLOAD_TOO_LARGE',
    message: 'A public order body may be at most 64 KiB.',
  });
}

@Injectable()
export class IntakeRawBody implements OnModuleInit {
  constructor(private readonly adapters: HttpAdapterHost) {}

  onModuleInit(): void {
    const instance = this.adapters.httpAdapter?.getInstance<FastifyInstance>();
    if (instance === undefined) return;

    instance.addHook('preParsing', async (request, _reply, payload) => {
      const path = request.url.split('?')[0] ?? '';
      if (request.method !== 'POST' || !path.startsWith(INTAKE_PATH_PREFIX)) return payload;

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += buffer.length;
        if (size > INTAKE_BODY_LIMIT_BYTES) throw bodyTooLarge();
        chunks.push(buffer);
      }
      const raw = Buffer.concat(chunks);
      (request as WithRawBody)[RAW_BODY] = raw;

      // Fastify compares what the parser received against Content-Length; a replacement
      // stream reports its length here or every request fails that check.
      const replay = Readable.from([raw]) as Readable & { receivedEncodedLength?: number };
      replay.receivedEncodedLength = raw.length;
      return replay;
    });
  }
}
