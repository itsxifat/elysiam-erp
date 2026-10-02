/**
 * Error reporting and telemetry, started before the application loads (§26, M14b).
 *
 *   node --import ./dist/instrument.js dist/main.api.js
 *
 * Loaded with `--import` because both SDKs say so: instrumentation must be in place
 * before the modules it patches are loaded. With no `SENTRY_DSN` and no OTLP endpoint this
 * imports neither SDK and does nothing, which is every developer machine and every test.
 *
 * Order matters when both are on: the OpenTelemetry SDK first, then Sentry, as Sentry's
 * custom-setup guide requires.
 */
import { observabilityConfig, type ProcessRole } from './platform/observability/config.js';

const entrypoint = process.argv[1] ?? '';
const role: ProcessRole = entrypoint.includes('main.worker') ? 'worker' : 'api';

const config = observabilityConfig(role);

if (config.telemetry !== null) {
  const { startTelemetry } = await import('./platform/observability/telemetry.js');
  startTelemetry(config.telemetry);
}

if (config.sentry !== null) {
  const { startSentry } = await import('./platform/observability/sentry.js');
  startSentry(config.sentry, { withTelemetry: config.telemetry !== null });
}
