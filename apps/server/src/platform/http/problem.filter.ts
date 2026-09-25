import {
  Catch,
  HttpException,
  HttpStatus,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ZodError } from 'zod';

import { instanceOf, problemFor, PROBLEM_CONTENT_TYPE, type ProblemDocument } from './problem.js';

/**
 * 500, as a number rather than as `HttpStatus.INTERNAL_SERVER_ERROR`.
 *
 * A problem document's `status` is a plain number — it comes from
 * `exception.getStatus()` or from a literal — and comparing a number to a member
 * of a TypeScript enum is the mistake `no-unsafe-enum-comparison` is there to
 * catch, because the enum could be renumbered and the comparison would still
 * compile.
 */
const SERVER_ERROR = 500;

/**
 * Every error leaves as RFC 9457 problem details (architecture §23, D-087).
 *
 * A filter rather than a helper each controller calls, for the same reason the
 * serializer is an interceptor: the failure of "remember to shape your errors"
 * is invisible. Until now a thrown `BadRequestException('…')` left as Nest's
 * `{ statusCode, message, error }`, the ledger's errors left as `{ code,
 * message }`, and the rate limiter wrote a third shape by hand — so a client had
 * to know which layer refused it before it could read why.
 *
 * What it must not do is widen what an error discloses. Two rules, both of
 * which have bitten a real system:
 *
 * - **A 5xx never carries its own message.** An unforeseen error's message is a
 *   stack frame, a connection string or a SQL fragment; PostgreSQL's unique
 *   violations quote the *values* that collided, which here are phone numbers
 *   and idempotency keys (invariant 10). The real error goes to the log, where
 *   pino's redaction applies; the client gets a fixed sentence.
 * - **A 4xx's detail is whatever the thrower wrote**, because those messages are
 *   written for the caller — but the thrower is `errors.ts`-coded domain code
 *   or Nest, never a database driver.
 */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();

    const document = this.describe(exception, instanceOf(request.url));

    if (document.status >= SERVER_ERROR) {
      /*
       * Loud, and with the real error attached.
       *
       * `request.log` is pino, configured with this app's redaction rules
       * (main.api.ts hands the logger to the Fastify adapter). Logging through
       * `console` instead would bypass them, and a 500's error object is
       * precisely where a masked phone number would otherwise reappear in
       * plaintext.
       */
      request.log.error(
        { err: exception, code: document.code, instance: document.instance },
        'request failed',
      );
    }

    void reply.status(document.status).header('content-type', PROBLEM_CONTENT_TYPE).send(document);
  }

  private describe(exception: unknown, instance: string): ProblemDocument {
    if (exception instanceof ZodError) {
      /*
       * A Zod failure reaching here means a handler parsed without catching.
       * Controllers normally convert it themselves, but a schema used deeper in
       * a service would otherwise become an opaque 500 — and the caller's own
       * malformed field is the single most useful thing to tell them.
       */
      return problemFor({
        status: HttpStatus.BAD_REQUEST,
        code: 'VALIDATION_FAILED',
        detail: 'The request body failed validation.',
        instance,
        errors: exception.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      });
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const { code, detail, errors } = readHttpExceptionBody(body, exception.message);

      return problemFor({
        status,
        ...(code === undefined ? {} : { code }),
        // A 5xx thrown deliberately — a failed courier call, say — still must
        // not echo its message, because "deliberately" is not the same as
        // "written for a stranger".
        ...(status >= SERVER_ERROR
          ? { detail: 'Something went wrong on our side. The failure has been logged.' }
          : { detail }),
        instance,
        ...(errors === undefined ? {} : { errors }),
      });
    }

    return problemFor({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'INTERNAL_ERROR',
      detail: 'Something went wrong on our side. The failure has been logged.',
      instance,
    });
  }
}

interface ExceptionBody {
  readonly code: string | undefined;
  readonly detail: string | undefined;
  readonly errors: readonly { readonly path: string; readonly message: string }[] | undefined;
}

/**
 * Read a code and a detail out of whatever was thrown.
 *
 * Nest allows three shapes and the codebase uses all three: a bare string
 * (`new BadRequestException('Say why the period must reopen.')`), Nest's own
 * `{ statusCode, message, error }`, and the ledger's `{ code, message }`. A
 * fourth, `{ message: string[] }`, is what a validation pipe produces. Guessing
 * wrong here means either losing the code — so a client that branches on
 * `PERIOD_CLOSED` silently stops working — or publishing Nest's `"Bad Request"`
 * as if it were a stable code.
 */
export function readHttpExceptionBody(body: unknown, fallback: string): ExceptionBody {
  if (typeof body === 'string') {
    return { code: undefined, detail: body, errors: undefined };
  }

  if (typeof body !== 'object' || body === null) {
    return { code: undefined, detail: fallback, errors: undefined };
  }

  const record = body as Record<string, unknown>;
  const code = typeof record.code === 'string' ? record.code : undefined;
  const raw = record.message ?? record.detail;

  if (Array.isArray(raw)) {
    const messages = raw.filter((entry): entry is string => typeof entry === 'string');
    return {
      code,
      detail: 'The request body failed validation.',
      // No path: a pipe's array is flat strings. Empty paths still beat
      // dropping the list, which is the only thing that names the bad fields.
      errors: messages.map((message) => ({ path: '', message })),
    };
  }

  return {
    code,
    detail: typeof raw === 'string' && raw !== '' ? raw : fallback,
    errors: undefined,
  };
}
