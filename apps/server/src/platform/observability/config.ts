import { z } from 'zod';

/**
 * Error reporting and telemetry configuration (architecture §26, M14b, D-344).
 *
 * Both are off unless configured: no `SENTRY_DSN`, no Sentry; no OTLP endpoint, no
 * OpenTelemetry. A developer, a test run and the route gate need nothing. Read on its own,
 * before `serverEnv()`, because `instrument.ts` runs ahead of the application and a bad
 * value here should name itself rather than surface as a missing span.
 *
 * An empty value is read as unset, as `notifyConfig` and `intakeConfig` do: a copied
 * `.env.example` leaves `SENTRY_DSN=` behind, and that means "off", not "invalid URL".
 */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const schema = z.object({
  NODE_ENV: optional(z.enum(['development', 'test', 'production'])),
  SENTRY_DSN: optional(z.string().url()),
  /** Defaults to NODE_ENV. Set it to `staging` on staging, which also runs as production. */
  SENTRY_ENVIRONMENT: optional(z.string().min(1).max(64)),
  /** The image tag Kamal deployed (`KAMAL_VERSION`), so an error names its release. */
  SENTRY_RELEASE: optional(z.string().min(1).max(200)),
  OTEL_EXPORTER_OTLP_ENDPOINT: optional(z.string().url()),
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: optional(z.string().url()),
  OTEL_SDK_DISABLED: optional(z.enum(['true', 'false'])),
  OTEL_SERVICE_NAME: optional(z.string().min(1)),
});

export type ProcessRole = 'api' | 'worker';

export interface SentrySettings {
  readonly dsn: string;
  readonly environment: string;
  readonly release: string | undefined;
}

export interface TelemetrySettings {
  readonly serviceName: string;
}

export interface ObservabilityConfig {
  readonly sentry: SentrySettings | null;
  readonly telemetry: TelemetrySettings | null;
}

export function observabilityConfig(
  role: ProcessRole,
  source: Record<string, string | undefined> = process.env,
): ObservabilityConfig {
  const result = schema.safeParse(source);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .sort()
      .join('\n');
    throw new Error(`Invalid observability configuration:\n${problems}`);
  }
  const env = result.data;

  const sentry: SentrySettings | null =
    env.SENTRY_DSN === undefined
      ? null
      : {
          dsn: env.SENTRY_DSN,
          environment: env.SENTRY_ENVIRONMENT ?? env.NODE_ENV ?? 'development',
          release: env.SENTRY_RELEASE,
        };

  // The SDK reads the endpoint itself (OTEL_EXPORTER_OTLP_*); this only decides whether
  // to start it. Without an endpoint it would export to localhost:4318 and log a failure
  // every minute, which is not "off".
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const telemetry: TelemetrySettings | null =
    endpoint === undefined || env.OTEL_SDK_DISABLED === 'true'
      ? null
      : { serviceName: env.OTEL_SERVICE_NAME ?? `elysium-${role}` };

  return { sentry, telemetry };
}
