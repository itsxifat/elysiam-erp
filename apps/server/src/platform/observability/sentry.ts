import * as Sentry from '@sentry/node';

import type { SentrySettings } from './config.js';
import { setErrorReporter } from './errors.js';
import { scrubErrorEvent } from './scrub.js';

/**
 * Sentry for errors only (§26, D-344), from its Node guide
 * (docs.sentry.io/platforms/javascript/guides/node/, read 2026-10-02 for 11.2.0).
 *
 * - No `tracesSampleRate` and no `tracesSampler`, which is how the SDK is told not to
 *   trace; OpenTelemetry owns traces.
 * - `enableOpenTelemetrySetup: false`: the SDK registers no tracer provider of its own. When
 *   our OpenTelemetry SDK is running, `openTelemetryIntegration()` links an error to the
 *   active trace without sending spans to Sentry (the guide's "custom setup" page), and the
 *   SDK must start first, which `instrument.ts` does.
 * - Nothing personal is collected (`dataCollection`), breadcrumbs are off (they would carry
 *   outbound URLs), and every event passes `scrubErrorEvent` on its way out.
 *
 * Reporting goes through `reportError` (errors.ts): the problem filter's 5xx, a
 * dead-lettered job, a failed boot.
 */
export function startSentry(settings: SentrySettings, options: { withTelemetry: boolean }): void {
  Sentry.init({
    dsn: settings.dsn,
    environment: settings.environment,
    ...(settings.release === undefined ? {} : { release: settings.release }),
    enableOpenTelemetrySetup: false,
    maxBreadcrumbs: 0,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      stackFrameVariables: false,
    },
    beforeSend: (event) => scrubErrorEvent(event),
    ...(options.withTelemetry
      ? { integrations: (defaults) => [...defaults, Sentry.openTelemetryIntegration()] }
      : {}),
  });

  setErrorReporter({
    capture(error, tags) {
      Sentry.captureException(error, { tags: { ...tags } });
    },
    async close(timeoutMs) {
      await Sentry.close(timeoutMs);
    },
  });
}
