import { maskPhonesInText } from '@elysium/domain';
import { destination, pino, type Logger, type LoggerOptions } from 'pino';

import { serverEnv } from '../config/env.js';

/**
 * Phone numbers are masked and secrets are removed before anything is written
 * (architecture §25). The redaction list grows with the schema; it is defined
 * here so no module can log around it.
 */
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.token',
  '*.secret',
  '*.accessToken',
  '*.refreshToken',
];

/**
 * A request URL fit for a log line: the path, never the query string.
 *
 * Fastify's default request serializer logs `req.url` whole, and the query is
 * exactly where tokens end up — a reset link's `?token=`, an OAuth `code`, a
 * `?phone=` lookup. Pino's path redaction cannot reach inside a string, so the
 * query is dropped wholesale and its presence noted. Phone numbers in the path
 * itself (`/v1/customers/01712345689`) are masked the same way the audit log
 * masks them.
 */
export function safeUrl(url: string | undefined): string {
  if (url === undefined) return '';
  const index = url.indexOf('?');
  const path = index === -1 ? url : url.slice(0, index);
  return maskPhonesInText(path) + (index === -1 ? '' : '?[redacted]');
}

interface LoggableRequest {
  readonly method?: string;
  readonly url?: string;
  readonly host?: string;
  readonly ip?: string;
}

export function createLogger(name: string): Logger {
  const env = serverEnv();
  const toStderr = env.LOG_DESTINATION === 'stderr';

  const options: LoggerOptions = {
    name,
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    // Fastify merges these over its own defaults, so this replaces its `req`
    // serializer on every request log line (fastify/lib/logger-pino.js).
    serializers: {
      req: (req: LoggableRequest) => ({
        method: req.method,
        url: safeUrl(req.url),
        host: req.host,
        remoteAddress: req.ip,
      }),
    },
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'HH:MM:ss',
              ...(toStderr ? { destination: 2 } : {}),
            },
          },
        }
      : {}),
  };
  // pino refuses a stream beside a transport; the pretty transport takes its own.
  return toStderr && options.transport === undefined
    ? pino(options, destination(2))
    : pino(options);
}
