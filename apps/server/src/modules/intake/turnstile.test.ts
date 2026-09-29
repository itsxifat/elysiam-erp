import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CloudflareTurnstile, TURNSTILE_TOKEN_MAX } from './turnstile.js';

/**
 * The Turnstile client against a local stand-in for siteverify, over real HTTP.
 *
 * The stand-in answers the way Cloudflare's documentation says siteverify answers — the
 * same field names, the same error codes — and records what it was sent, so the request
 * the client builds is checked field by field rather than assumed. The cases are the ones
 * that decide whether a bot gets through: a truthy-but-not-`true` success, an outage, a
 * token over the documented length.
 */

interface Seen {
  readonly contentType: string | undefined;
  readonly form: URLSearchParams;
}

let server: Server;
let url = '';
const seen: Seen[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    request.on('end', () => {
      const form = new URLSearchParams(body);
      seen.push({ contentType: request.headers['content-type'], form });
      const token = form.get('response');
      response.setHeader('content-type', 'application/json');
      if (token === 'slow') {
        setTimeout(() => response.end('{"success":true}'), 1_500);
        return;
      }
      if (token === 'broken') {
        response.statusCode = 500;
        response.end('oops');
        return;
      }
      if (token === 'truthy') {
        response.end('{"success":"yes"}');
        return;
      }
      if (token === 'cf-internal') {
        response.end('{"success":false,"error-codes":["internal-error"]}');
        return;
      }
      response.end(
        token === 'pass'
          ? '{"success":true,"challenge_ts":"2026-09-28T10:00:00.000Z","hostname":"lp.example.com","error-codes":[]}'
          : '{"success":false,"error-codes":["invalid-input-response"]}',
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/siteverify`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(timeoutMs = 1_000) {
  return new CloudflareTurnstile({ secret: 'test-secret', url, timeoutMs });
}

describe('siteverify, as Cloudflare documents it', () => {
  it('sends secret, response, remoteip and idempotency_key form-encoded', async () => {
    const verdict = await client().verify({
      token: 'pass',
      remoteIp: '203.0.113.7',
      idempotencyKey: '4a1c7d1e-0000-4000-8000-000000000001',
    });
    expect(verdict).toMatchObject({
      success: true,
      unavailable: false,
      hostname: 'lp.example.com',
    });
    const last = seen.at(-1);
    expect(last?.contentType).toBe('application/x-www-form-urlencoded');
    expect(last?.form.get('secret')).toBe('test-secret');
    expect(last?.form.get('response')).toBe('pass');
    expect(last?.form.get('remoteip')).toBe('203.0.113.7');
    expect(last?.form.get('idempotency_key')).toBe('4a1c7d1e-0000-4000-8000-000000000001');
  });

  it('omits remoteip when there is no visitor address', async () => {
    await client().verify({ token: 'pass', remoteIp: null, idempotencyKey: 'k-1' });
    expect(seen.at(-1)?.form.has('remoteip')).toBe(false);
  });

  it('reports a refused token as a refusal, not an outage', async () => {
    const verdict = await client().verify({ token: 'nope', remoteIp: null, idempotencyKey: 'k-2' });
    expect(verdict).toMatchObject({
      success: false,
      unavailable: false,
      errorCodes: ['invalid-input-response'],
    });
  });

  it('passes only on success === true', async () => {
    const verdict = await client().verify({
      token: 'truthy',
      remoteIp: null,
      idempotencyKey: 'k-3',
    });
    expect(verdict.success).toBe(false);
  });

  it('treats a timeout, an HTTP error and Cloudflare’s own internal-error as unavailable', async () => {
    const slow = await client(300).verify({ token: 'slow', remoteIp: null, idempotencyKey: 'k-4' });
    const broken = await client().verify({
      token: 'broken',
      remoteIp: null,
      idempotencyKey: 'k-5',
    });
    const internal = await client().verify({
      token: 'cf-internal',
      remoteIp: null,
      idempotencyKey: 'k-6',
    });
    for (const verdict of [slow, broken, internal]) {
      expect(verdict.success).toBe(false);
      expect(verdict.unavailable).toBe(true);
    }
  });

  it('refuses an over-long token without asking Cloudflare', async () => {
    const before = seen.length;
    const verdict = await client().verify({
      token: 'x'.repeat(TURNSTILE_TOKEN_MAX + 1),
      remoteIp: null,
      idempotencyKey: 'k-7',
    });
    expect(verdict.success).toBe(false);
    expect(seen.length).toBe(before);
  });
});
