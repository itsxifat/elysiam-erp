import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ArgumentsHost } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';

import { ProblemFilter } from '../http/problem.filter.js';
import { observabilityConfig } from './config.js';
import {
  onObservabilityShutdown,
  reportError,
  setErrorReporter,
  shutdownObservability,
  type ErrorReporter,
} from './errors.js';
import { scrubErrorEvent, scrubSpanUrls } from './scrub.js';

/**
 * Sentry and OpenTelemetry behind configuration (M14b, §26, D-344).
 *
 * Neither SDK is loaded here. What is tested is what decides whether they start, the seam
 * every caller reports through, and the scrubbers every event and span passes on its way
 * to a third party, with planted phone numbers and credentials.
 */

const PHONE = '01712345689';
const MASKED = '017******89';

afterEach(() => {
  setErrorReporter(undefined);
});

describe('observabilityConfig', () => {
  it('is off without a DSN or an endpoint, which is every developer and every test', () => {
    expect(observabilityConfig('api', {})).toEqual({ sentry: null, telemetry: null });
  });

  it('reads an empty value as unset, the way a copied .env.example leaves one', () => {
    expect(observabilityConfig('api', { SENTRY_DSN: '', OTEL_EXPORTER_OTLP_ENDPOINT: '' })).toEqual(
      { sentry: null, telemetry: null },
    );
  });

  it('turns Sentry on with a DSN, naming the environment and release', () => {
    const config = observabilityConfig('worker', {
      NODE_ENV: 'production',
      SENTRY_DSN: 'https://public@o0.ingest.example.test/1',
      SENTRY_ENVIRONMENT: 'staging',
      SENTRY_RELEASE: 'abc123',
    });
    expect(config.sentry).toEqual({
      dsn: 'https://public@o0.ingest.example.test/1',
      environment: 'staging',
      release: 'abc123',
    });
    expect(config.telemetry).toBeNull();
  });

  it('turns telemetry on with an endpoint, named after the process unless told otherwise', () => {
    const endpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otlp.example.test' };
    expect(observabilityConfig('worker', endpoint).telemetry).toEqual({
      serviceName: 'elysium-worker',
    });
    expect(
      observabilityConfig('api', { ...endpoint, OTEL_SERVICE_NAME: 'erp-api' }).telemetry,
    ).toEqual({ serviceName: 'erp-api' });
    expect(
      observabilityConfig('api', { ...endpoint, OTEL_SDK_DISABLED: 'true' }).telemetry,
    ).toBeNull();
  });

  it('stops the process on a malformed value rather than reporting nowhere', () => {
    expect(() => observabilityConfig('api', { SENTRY_DSN: 'not a url' })).toThrow(/SENTRY_DSN/);
  });
});

describe('reportError', () => {
  const recorder = (): ErrorReporter & { captured: [unknown, Record<string, string>][] } => {
    const captured: [unknown, Record<string, string>][] = [];
    return {
      captured,
      capture: (error, tags) => captured.push([error, { ...tags }]),
      close: () => Promise.resolve(),
    };
  };

  it('does nothing without a reporter', () => {
    expect(() => {
      reportError(new Error('boom'));
    }).not.toThrow();
  });

  it('never lets a failing reporter throw into the caller', () => {
    setErrorReporter({
      capture: () => {
        throw new Error('sentry is down');
      },
      close: () => Promise.resolve(),
    });
    expect(() => {
      reportError(new Error('boom'), { kind: 'http' });
    }).not.toThrow();
  });

  it('is what the problem filter calls for a 5xx, and only for a 5xx', () => {
    const reporter = recorder();
    setErrorReporter(reporter);
    const filter = new ProblemFilter();

    const host = (url: string): ArgumentsHost => {
      const reply = { status: () => reply, header: () => reply, send: () => reply };
      const request = { url, method: 'POST', log: { error: () => undefined } };
      return {
        switchToHttp: () => ({ getRequest: () => request, getResponse: () => reply }),
      } as unknown as ArgumentsHost;
    };

    filter.catch(new BadRequestException('Say why.'), host('/v1/orders'));
    expect(reporter.captured).toHaveLength(0);

    const failure = new Error(`duplicate key (phone)=(${PHONE})`);
    filter.catch(failure, host(`/v1/customers/${PHONE}`));
    expect(reporter.captured).toEqual([
      [failure, { kind: 'http', code: 'INTERNAL_ERROR', method: 'POST' }],
    ]);
    // The URL is not a tag: it can hold a phone number.
    expect(JSON.stringify(reporter.captured[0]?.[1])).not.toContain(PHONE);
  });

  it('flushes the reporter and every registered closer on shutdown', async () => {
    const close = vi.fn(() => Promise.resolve());
    const closer = vi.fn(() => Promise.resolve());
    setErrorReporter({ capture: () => undefined, close });
    onObservabilityShutdown(closer);

    await shutdownObservability(500);

    expect(close).toHaveBeenCalledWith(500);
    expect(closer).toHaveBeenCalledOnce();
  });
});

describe('scrubErrorEvent', () => {
  it('masks phones everywhere and keeps only the method and a safe URL of the request', () => {
    const event = {
      message: `customer ${PHONE} refused`,
      exception: {
        values: [
          {
            type: 'PostgresError',
            value: `Key (phone)=(${PHONE}) already exists`,
            stacktrace: { frames: [{ filename: 'orders.service.js', function: 'create' }] },
          },
        ],
      },
      request: {
        method: 'POST',
        url: `https://api.example.test/v1/customers/${PHONE}?token=reset-token-value`,
        query_string: 'token=reset-token-value',
        cookies: { 'better-auth.session_token': 'session-cookie-value' },
        headers: { authorization: 'Bearer header-token-value', cookie: 'a=b' },
        data: { password: 'body-password-value' },
      },
      user: { email: 'someone@example.test', ip_address: '203.0.113.9' },
      breadcrumbs: [{ message: `GET https://courier.example.test/track?phone=${PHONE}` }],
      extra: { courier: { apiKey: 'sk_live_extra_key' }, note: `call ${PHONE}` },
      contexts: { job: { secret: 'context-secret-value' } },
      tags: { kind: 'http', code: 'INTERNAL_ERROR' },
      sdkProcessingMetadata: { kept: true },
    };

    const scrubbed = scrubErrorEvent(event);
    const text = JSON.stringify(scrubbed);

    for (const leak of [
      PHONE,
      'reset-token-value',
      'session-cookie-value',
      'header-token-value',
      'body-password-value',
      'someone@example.test',
      'sk_live_extra_key',
      'context-secret-value',
    ]) {
      expect(text).not.toContain(leak);
    }
    expect(scrubbed?.request).toEqual({
      method: 'POST',
      url: `https://api.example.test/v1/customers/${MASKED}?[redacted]`,
    });
    expect(scrubbed?.exception.values[0]?.value).toBe(`Key (phone)=(${MASKED}) already exists`);
    expect(scrubbed?.tags).toEqual({ kind: 'http', code: 'INTERNAL_ERROR' });
    expect(scrubbed?.sdkProcessingMetadata).toEqual({ kept: true });
    // The original is untouched: the SDK may still hold it.
    expect(event.message).toContain(PHONE);
  });

  it('drops an event it cannot scrub rather than send it as it is', () => {
    const circular: Record<string, unknown> = { message: 'loop' };
    circular.self = circular;
    expect(scrubErrorEvent(circular)).toBeNull();
  });
});

describe('scrubSpanUrls', () => {
  it('rewrites every URL attribute the http and undici instrumentations set', () => {
    const attributes: Record<string, unknown> = {
      'http.target': `/v1/customers/${PHONE}?q=${PHONE}`,
      'url.path': `/v1/customers/${PHONE}`,
      'url.query': `q=${PHONE}`,
      'url.full': `https://courier.example.test/track?api_key=courier-key-value&phone=${PHONE}`,
      'http.method': 'GET',
    };
    const span = {
      attributes,
      setAttribute(key: string, value: string) {
        attributes[key] = value;
        return span;
      },
    };

    scrubSpanUrls(span);

    expect(attributes).toEqual({
      'http.target': `/v1/customers/${MASKED}?[redacted]`,
      'url.path': `/v1/customers/${MASKED}`,
      'url.query': '[redacted]',
      'url.full': 'https://courier.example.test/track?[redacted]',
      'http.method': 'GET',
    });
  });
});
