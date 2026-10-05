import { Readable } from 'node:stream';

import { Injectable, PayloadTooLargeException, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { NCOM_CONTRACT } from '@elysium/domain/storefront';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * The HTTP edge of ncom.bd's contract 1 (M35b, D-553, D-556).
 *
 * ncom signs the exact bytes it sends, so the bytes are kept before Fastify parses them (a
 * `preParsing` hook, the storefront's arrangement), under the old site's ceilings: 256 KiB for
 * a connector call, 512 KiB for an order, 1 MiB for a webhook. Every answer is JSON with the
 * contract's headers and `no-store`: ncom keeps no cache and a proxy must not either.
 */

export const NCOM_PREFIX = '/ncom/';

const RAW_BODY = Symbol('elysium:ncom-raw-body');
type WithRawBody = FastifyRequest & { [RAW_BODY]?: Buffer };

function limitFor(path: string): number {
  if (path.endsWith('/webhook')) return 1024 * 1024;
  if (path.endsWith('/orders')) return 512 * 1024;
  return 256 * 1024;
}

/** The exact bytes of an ncom POST, or the empty body of a GET. */
export function ncomRawBodyOf(request: FastifyRequest): Buffer {
  return (request as WithRawBody)[RAW_BODY] ?? Buffer.alloc(0);
}

@Injectable()
export class NcomRawBody implements OnModuleInit {
  constructor(private readonly adapters: HttpAdapterHost) {}

  onModuleInit(): void {
    const instance = this.adapters.httpAdapter?.getInstance<FastifyInstance>();
    if (instance === undefined) return;
    instance.addHook('preParsing', async (request, _reply, payload) => {
      const path = request.url.split('?')[0] ?? '';
      if (request.method !== 'POST' || !path.startsWith(NCOM_PREFIX)) return payload;
      const limit = limitFor(path);
      const declared = Number(request.headers['content-length'] ?? 0);
      if (Number.isFinite(declared) && declared > limit) {
        throw new PayloadTooLargeException({
          code: 'PAYLOAD_TOO_LARGE',
          message: 'Request body is too large.',
        });
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        size += buffer.length;
        if (size > limit) {
          throw new PayloadTooLargeException({
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Request body is too large.',
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

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store, no-cache, must-revalidate, private',
  'x-ncom-contract': NCOM_CONTRACT,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** A JSON answer with the contract's headers. */
export async function ncomJson(
  reply: FastifyReply,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Promise<void> {
  await reply
    .code(status)
    .headers({ ...BASE_HEADERS, ...headers })
    .send(JSON.stringify(body));
}

/** A connector refusal: a machine code and a sentence that echoes nothing the caller sent. */
export function connectorError(
  code: string,
  message: string,
  extra: Readonly<Record<string, unknown>> = {},
): { ok: false; error: { code: string; message: string } } & Record<string, unknown> {
  return { ok: false, error: { code, message }, ...extra };
}

/** A refusal the connector routes answer with (status, body, headers). */
export class NcomRefusal extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(`ncom refusal ${String(status)}`);
    this.name = 'NcomRefusal';
  }
}

export function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? (value[0] ?? '') : '';
}
