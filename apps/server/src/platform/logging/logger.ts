import { maskPhonesInText, redact } from '@elysium/domain';
import {
  destination as pinoDestination,
  pino,
  stdSerializers,
  type DestinationStream,
  type Logger,
  type LoggerOptions,
} from 'pino';

import { serverEnv } from '../config/env.js';

/**
 * Phone numbers are masked and secrets are removed before anything is written
 * (architecture §25, invariant 10). It is all defined here so no module can log around it.
 *
 * Three layers, because each catches what the others cannot reach:
 *
 * - **Every field, at any depth** (`formatters.log`): the audit log's own `redact`, so a
 *   credential-named key (`password`, `apiKey`, `otp`, `authorization`, `nid`, …) is
 *   removed however deep it sits and a value under a phone-named key is masked. pino's
 *   path redaction below matches one level only (`*.token`), and
 *   `{ courier: { credentials: { apiKey } } }` is two.
 * - **Errors** (the `err` serializer): an Error's message and stack are not enumerable,
 *   so the field walk skips them; its own fields are scrubbed here.
 * - **The finished line** (`hooks.streamWrite`): every Bangladeshi mobile number in the
 *   serialized JSON is masked (`017******89`) just before it is written. That is the only
 *   place a message, a format argument, a driver error quoting the row it refused, and a
 *   child logger's bindings all pass through: pino resets the bindings formatter for
 *   every child, so `logger.child({ phone })` never reaches `formatters`.
 *
 * Path redaction is kept for the request headers as a belt over the braces.
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

/** Fields a serializer below turns into data; the serializer scrubs them, not the walk. */
const SERIALIZED_FIELDS = new Set(['req', 'res', 'err', 'error']);

/** Plain data: a primitive, an array, or an object literal. */
function isPlainData(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * A log line's fields, scrubbed.
 *
 * pino runs this before the serializers, so anything a serializer owns, and any class
 * instance, is passed through untouched. `redact` copies own enumerable properties, which
 * on an Error excludes the message and stack and on Fastify's request excludes the
 * `method` and `url` getters: walking either here would hand its serializer an empty
 * copy, and would also walk the whole socket graph under every request line.
 */
export function scrubLogFields(fields: Record<string, unknown>): Record<string, unknown> {
  const kept: [string, unknown][] = [];
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SERIALIZED_FIELDS.has(key) || !isPlainData(value)) kept.push([key, value]);
    else rest[key] = value;
  }
  const scrubbed = redact(rest) as Record<string, unknown>;
  for (const [key, value] of kept) scrubbed[key] = value;
  return scrubbed;
}

/**
 * Fields in which a database error quotes the values it was given (M30, security review A6).
 *
 * Drizzle's `DrizzleQueryError` keeps the bound parameters as `params` and repeats them in
 * its message (`Failed query: … params: …`), and Postgres's `detail` quotes the row it
 * refused (`Key (phone_e164)=(…) already exists`). Those are the buyer's name, address and
 * phone, or a password-reset token: masking phone numbers in the finished line catches only
 * the phone. The SQL text and the error's code and constraint stay, which is what a person
 * debugging needs.
 */
const QUOTED_VALUE_FIELDS = new Set(['params', 'parameters', 'args', 'detail', 'where']);

const WITHHELD = '[withheld]';

/** `params: …` in a message or a stack, up to the first stack frame. */
function withoutBoundValues(text: string): string {
  return text.replace(/\nparams: [\s\S]*?(?=\n\s+at |$)/g, `\nparams: ${WITHHELD}`);
}

function stripBoundValues(value: unknown, depth = 0): unknown {
  if (depth > 5 || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (QUOTED_VALUE_FIELDS.has(key)) out[key] = WITHHELD;
    else if (typeof field === 'string' && (key === 'message' || key === 'stack')) {
      out[key] = withoutBoundValues(field);
    } else if (key === 'cause' || key === 'aggregateErrors') {
      out[key] = Array.isArray(field)
        ? field.map((entry) => stripBoundValues(entry, depth + 1))
        : stripBoundValues(field, depth + 1);
    } else out[key] = field;
  }
  return out;
}

/**
 * An Error as pino would write it, then scrubbed: message, stack and every own field, with
 * the values a failed query was given withheld.
 */
export function scrubError(error: unknown): unknown {
  if (!(error instanceof Error)) return redact(error);
  return redact(stripBoundValues(stdSerializers.err(error)));
}

export interface LoggerSettings {
  readonly level: string;
  readonly pretty: boolean;
}

/** The options every process's logger is built from. Exported for the tests. */
export function loggerOptions(name: string, settings: LoggerSettings): LoggerOptions {
  return {
    name,
    level: settings.level,
    redact: { paths: REDACT_PATHS, censor: '[redacted]' },
    formatters: { log: scrubLogFields },
    // A phone pattern cannot match across a JSON delimiter, so masking the serialized
    // line leaves it valid JSON.
    hooks: { streamWrite: maskPhonesInText },
    // Fastify merges these over its own defaults, so this replaces its `req`
    // serializer on every request log line (fastify/lib/logger-pino.js).
    serializers: {
      req: (req: LoggableRequest) => ({
        method: req.method,
        url: safeUrl(req.url),
        host: req.host,
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
  };
}

export function createLogger(name: string, destination?: DestinationStream): Logger {
  const env = serverEnv();
  // `LOG_DESTINATION=stderr` keeps stdout free for a CLI's own output (the preview seed's
  // `--out -`).
  const target = destination ?? (env.LOG_DESTINATION === 'stderr' ? pinoDestination(2) : undefined);
  const options = loggerOptions(name, {
    level: env.LOG_LEVEL,
    // A transport and an explicit destination are mutually exclusive in pino.
    pretty: env.NODE_ENV === 'development' && target === undefined,
  });
  return target === undefined ? pino(options) : pino(options, target);
}
