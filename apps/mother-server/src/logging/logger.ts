import { maskPhonesInText, redact } from '@elysium/domain';
import { pino, stdSerializers, type Logger } from 'pino';

/**
 * The mother's logs (§26's rules): structured, with credential-named fields removed at any
 * depth, phone numbers masked in the finished line, and a request URL logged without its
 * query string. A brand's connection string never reaches a log line: it is decrypted only
 * into the driver, and failures are logged as codes (D-486).
 */

const URL_IN_TEXT = /postgres(?:ql)?:\/\/[^\s'"]+/gi;

/** Removes any connection string a message might quote, then masks phones. */
export function scrubText(text: string): string {
  return maskPhonesInText(text.replace(URL_IN_TEXT, 'postgres://[redacted]'));
}

function scrubError(error: unknown): unknown {
  if (!(error instanceof Error)) return redact(error);
  const serialized = stdSerializers.err(error) as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(serialized)) {
    if (['params', 'parameters', 'args', 'detail', 'where'].includes(key)) {
      out[key] = '[withheld]';
    } else if (typeof value === 'string') {
      out[key] = scrubText(value);
    } else out[key] = value;
  }
  return redact(out);
}

export function safeUrl(url: string | undefined): string {
  if (url === undefined) return '';
  const index = url.indexOf('?');
  return index === -1 ? url : `${url.slice(0, index)}?[redacted]`;
}

export function createLogger(
  name: string,
  settings: { readonly level: string; readonly pretty: boolean },
): Logger {
  return pino({
    name,
    level: settings.level,
    redact: {
      paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.token'],
      censor: '[redacted]',
    },
    formatters: {
      log: (fields) => {
        const kept: Record<string, unknown> = {};
        const rest: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(fields)) {
          if (key === 'err' || key === 'error' || key === 'req' || key === 'res') kept[key] = value;
          else rest[key] = value;
        }
        return { ...(redact(rest) as Record<string, unknown>), ...kept };
      },
    },
    hooks: { streamWrite: scrubText },
    serializers: {
      req: (req: { method?: string; url?: string; ip?: string }) => ({
        method: req.method,
        url: safeUrl(req.url),
        remoteAddress: req.ip,
      }),
      err: scrubError,
      error: scrubError,
    },
    ...(settings.pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss' },
          },
        }
      : {}),
  });
}
