import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { gatewayFor, notifyConfig } from '../notify.config.js';
import { BulkSmsBdGateway } from './bulksmsbd.gateway.js';
import { FakeSmsGateway } from './sms-gateway.js';

/**
 * The BulkSMSBD adapter, without BulkSMSBD (D-012: unverified, off by default).
 *
 * What the developer page documents — the form fields, `202` for success, the numbered
 * failures — is exercised against a local HTTP stub, so the request the adapter builds and
 * the reading of every documented answer are pinned without a network or an account. The
 * key and sender id are throwaway values for this file.
 */

interface Received {
  readonly path: string;
  readonly contentType: string | undefined;
  readonly form: URLSearchParams;
}

let server: Server;
let baseUrl: string;
const received: Received[] = [];
let reply: { status: number; body: string; delayMs?: number } = { status: 200, body: '' };

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => (body += chunk));
    request.on('end', () => resolve(body));
  });
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void readBody(request).then((body) => {
      received.push({
        path: request.url ?? '',
        contentType: request.headers['content-type'],
        form: new URLSearchParams(body),
      });
      setTimeout(() => {
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(reply.body);
      }, reply.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const gateway = () =>
  new BulkSmsBdGateway({ baseUrl, apiKey: 'test-api-key', senderId: 'TESTSENDER' });

describe('reading an answer', () => {
  it('is a success only on 202', () => {
    expect(
      BulkSmsBdGateway.interpret(200, '{"response_code":202,"success_message":"SMS Submitted"}'),
    ).toEqual({ ok: true, providerMessageId: null });
  });

  it.each([
    ['1007', false], // balance insufficient
    ['1002', false], // sender id
    ['1005', true], // their internal error: worth another try
  ])('names documented failure %s, retryable %s', (code, retryable) => {
    expect(
      BulkSmsBdGateway.interpret(200, `{"response_code":${code},"error_message":"x"}`),
    ).toEqual({ ok: false, error: `bulksmsbd:${code}`, retryable });
  });

  it('refuses anything it cannot recognise, rather than call it sent', () => {
    expect(BulkSmsBdGateway.interpret(200, 'OK')).toEqual({
      ok: false,
      error: 'unrecognised_response',
      retryable: false,
    });
    expect(BulkSmsBdGateway.interpret(404, '{"response_code":202}')).toMatchObject({ ok: false });
  });
});

describe('sending', () => {
  it('posts the documented form, with the number in 880 form', async () => {
    reply = { status: 200, body: '{"response_code":202}' };
    const result = await gateway().send('01711000999', 'আপনার কোড 1234', { timeoutMs: 2_000 });

    expect(result).toEqual({ ok: true, providerMessageId: null });
    const last = received.at(-1);
    expect(last?.path).toBe('/api/smsapi');
    expect(last?.contentType).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(last?.form ?? [])).toEqual({
      api_key: 'test-api-key',
      type: 'text',
      number: '8801711000999',
      senderid: 'TESTSENDER',
      message: 'আপনার কোড 1234',
    });
  });

  it('retries a server error and a timeout, and sends nothing when unconfigured', async () => {
    reply = { status: 503, body: '' };
    expect(await gateway().send('01711000999', 'x', { timeoutMs: 2_000 })).toEqual({
      ok: false,
      error: 'http_503',
      retryable: true,
    });

    reply = { status: 200, body: '{"response_code":202}', delayMs: 300 };
    expect(await gateway().send('01711000999', 'x', { timeoutMs: 50 })).toEqual({
      ok: false,
      error: 'timeout',
      retryable: true,
    });

    const before = received.length;
    const unconfigured = new BulkSmsBdGateway({ baseUrl, apiKey: undefined, senderId: undefined });
    expect(unconfigured.configured).toBe(false);
    expect(await unconfigured.send('01711000999', 'x', { timeoutMs: 2_000 })).toEqual({
      ok: false,
      error: 'unconfigured',
      retryable: false,
    });
    expect(received.length).toBe(before);
  });
});

describe('choosing a gateway (two switches)', () => {
  it('uses the fake unless told otherwise', () => {
    expect(gatewayFor(notifyConfig({}))).toBeInstanceOf(FakeSmsGateway);
  });

  it('refuses to boot when the unverified gateway is named without its second switch', () => {
    expect(() => gatewayFor(notifyConfig({ NOTIFY_SMS_PROVIDER: 'bulksmsbd' }))).toThrow(
      /unverified gateway/,
    );
  });

  it('uses BulkSMSBD, marked unverified, with both switches', () => {
    const chosen = gatewayFor(
      notifyConfig({ NOTIFY_SMS_PROVIDER: 'bulksmsbd', NOTIFY_BULKSMSBD_ENABLED: 'true' }),
    );
    expect(chosen).toBeInstanceOf(BulkSmsBdGateway);
    expect((chosen as BulkSmsBdGateway).verified).toBe(false);
  });

  it('reads an empty value as unset, the way a copied .env.example leaves one', () => {
    const config = notifyConfig({
      NOTIFY_SMS_PROVIDER: '',
      NOTIFY_BULKSMSBD_API_KEY: '',
      NOTIFY_BULKSMSBD_SENDER_ID: '',
    });
    expect(config.NOTIFY_SMS_PROVIDER).toBe('fake');
    expect(config.NOTIFY_BULKSMSBD_API_KEY).toBeUndefined();
  });
});
