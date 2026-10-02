import { pino, type Logger } from 'pino';
import { describe, expect, it } from 'vitest';

import { loggerOptions, safeUrl } from './logger.js';

/**
 * What reaches a log line (architecture §25, §26, invariant 10).
 *
 * Every case plants a real-shaped secret or Bangladeshi mobile number and asserts on the
 * bytes pino actually wrote, not on a helper's return value: a redactor that works and a
 * logger that bypasses it look the same from the helper's side.
 */

const PHONE = '01712345689';
const MASKED = '017******89';

function capture(): {
  logger: Logger;
  text: () => string;
  lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const logger = pino(loggerOptions('test', { level: 'trace', pretty: false }), {
    write(chunk: string) {
      chunks.push(chunk);
    },
  });
  return {
    logger,
    text: () => chunks.join(''),
    lines: () => chunks.map((chunk) => JSON.parse(chunk) as Record<string, unknown>),
  };
}

describe('the logger removes secrets', () => {
  it('drops credential-named fields at any depth, not only one level down', () => {
    const { logger, text, lines } = capture();
    logger.info(
      {
        password: 'hunter2-password',
        session: { token: 'tok_live_session' },
        courier: { credentials: { apiKey: 'sk_live_courier_key', secretKey: 'sk_secret_value' } },
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig' },
        verification: { otp: '483920' },
        employee: { nid: '1994785321456' },
        orderId: 'ord_123',
        count: 3,
      },
      'saved',
    );

    for (const secret of [
      'hunter2-password',
      'tok_live_session',
      'sk_live_courier_key',
      'sk_secret_value',
      'eyJhbGciOiJIUzI1NiJ9',
      '483920',
      '1994785321456',
    ]) {
      expect(text()).not.toContain(secret);
    }
    // And what is not a secret survives, so the line is still useful.
    expect(lines()[0]).toMatchObject({ orderId: 'ord_123', count: 3, msg: 'saved' });
  });

  it('drops a secret an Error carries as its own field', () => {
    const { logger, text } = capture();
    const error = Object.assign(new Error('courier refused'), { apiKey: 'sk_live_on_error' });
    logger.error({ err: error }, 'booking failed');

    expect(text()).not.toContain('sk_live_on_error');
    expect(text()).toContain('courier refused');
  });
});

describe('the logger masks phone numbers', () => {
  it('in a field value, under a phone-named key and in free text', () => {
    const { logger, text } = capture();
    logger.info(
      {
        phone: `+88${PHONE}`,
        customer: { mobile: PHONE },
        note: `customer ${PHONE} refused the parcel`,
        phones: ['01812345678', '01912345670'],
      },
      'note added',
    );

    expect(text()).not.toMatch(/0171234568|01812345678|01912345670/);
    expect(text()).toContain(MASKED);
  });

  it('in the message and in its format arguments', () => {
    const { logger, text } = capture();
    logger.info(`calling ${PHONE}`);
    logger.warn('sms to %s failed', '01812345678');

    expect(text()).not.toContain(PHONE);
    expect(text()).not.toContain('01812345678');
    expect(text()).toContain(MASKED);
    expect(text()).toContain('018******78');
  });

  it("in an Error's message and stack, which a field walk cannot see", () => {
    const { logger, lines } = capture();
    logger.error(
      { err: new Error(`duplicate key value (phone)=(${PHONE}) violates unique constraint`) },
      'insert failed',
    );

    const err = lines()[0]?.err as { message: string; stack: string; type: string };
    expect(err.type).toBe('Error');
    expect(err.message).toContain(MASKED);
    expect(err.message).not.toContain(PHONE);
    expect(err.stack).not.toContain(PHONE);
    expect(err.stack).toContain('logger.test');
  });

  it("in a child logger's bindings", () => {
    const { logger, text } = capture();
    logger.child({ customerPhone: PHONE }).info('looked up');

    expect(text()).not.toContain(PHONE);
    expect(text()).toContain(MASKED);
  });
});

describe('request lines', () => {
  it("leave Fastify's request to its serializer, so its getters still read", () => {
    class FakeRequest {
      readonly ip = '203.0.113.9';
      readonly host = 'api.example.test';
      private readonly verb = ['G', 'E', 'T'].join('');
      get method(): string {
        return this.verb;
      }
      get url(): string {
        return `/v1/customers/${PHONE}?token=abc`;
      }
    }
    const { logger, lines, text } = capture();
    logger.info({ req: new FakeRequest() }, 'incoming request');

    expect(lines()[0]?.req).toEqual({
      method: 'GET',
      url: `/v1/customers/${MASKED}?[redacted]`,
      host: 'api.example.test',
      remoteAddress: '203.0.113.9',
    });
    expect(text()).not.toContain('token=abc');
  });
});

describe('safeUrl', () => {
  it('drops the query string and masks a phone in the path', () => {
    expect(safeUrl(`/v1/customers/${PHONE}?token=abc&phone=${PHONE}`)).toBe(
      `/v1/customers/${MASKED}?[redacted]`,
    );
    expect(safeUrl('/v1/orders')).toBe('/v1/orders');
    expect(safeUrl(undefined)).toBe('');
  });
});
