import { pino, type Logger } from 'pino';

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

export function createLogger(name: string): Logger {
  const env = serverEnv();

  return pino({
    name,
    level: env.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    ...(env.NODE_ENV === 'development'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  });
}
