import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { NodeSDK } from '@opentelemetry/sdk-node';

import type { TelemetrySettings } from './config.js';
import { onObservabilityShutdown } from './errors.js';
import { scrubSpanUrls, type ScrubbableSpan } from './scrub.js';

/**
 * OpenTelemetry traces and metrics over OTLP (§26, D-344), from the JavaScript getting
 * started guide (opentelemetry.io/docs/languages/js/getting-started/nodejs/) and the
 * sdk-node README, read 2026-10-02 for 0.222.0.
 *
 * No exporter is passed: NodeSDK builds the OTLP trace exporter and the periodic metric
 * reader from the standard variables (`OTEL_EXPORTER_OTLP_ENDPOINT`, `_HEADERS`,
 * `_PROTOCOL`, `OTEL_TRACES_EXPORTER`, `OTEL_METRICS_EXPORTER`, `OTEL_TRACES_SAMPLER`), so
 * a collector is pointed at by configuration alone. `instrument.ts` starts this only when
 * an endpoint is set.
 *
 * Two instrumentations, both chosen because they need no ESM loader hook: incoming
 * requests through Node's `http` server (Fastify requires it as CommonJS, so the patch
 * applies), and outbound calls through undici's diagnostics channel, which is every
 * courier, SMS and Meta call (Node's `fetch`). The health probes are not traced: kamal-proxy
 * and the uptime monitor would be most of the traffic. Every URL attribute is scrubbed
 * (`scrubSpanUrls`): no query string, phones masked.
 */
export function startTelemetry(settings: TelemetrySettings): void {
  const scrub = (span: unknown): void => {
    scrubSpanUrls(span as ScrubbableSpan);
  };

  const sdk = new NodeSDK({
    serviceName: settings.serviceName,
    instrumentations: [
      new HttpInstrumentation({
        ignoreIncomingRequestHook: (request) => request.url?.startsWith('/health/') ?? false,
        requestHook: scrub,
      }),
      new UndiciInstrumentation({ requestHook: scrub }),
    ],
  });
  sdk.start();
  onObservabilityShutdown(() => sdk.shutdown());
}
