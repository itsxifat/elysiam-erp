import { isErrorCode, type ErrorCode } from '@elysium/contracts';

/**
 * RFC 9457 problem details, as the shape and the rules rather than as a filter
 * (architecture §23, D-087).
 *
 * Pure so it can be tested without booting Nest, and so the two places that
 * produce an error body — the exception filter, and the Fastify-level rate
 * limiter that answers before Nest is ever reached — build the same document
 * from the same code table. They used to disagree: `sendRateLimited` hand-rolled
 * `{ type: 'about:blank', title, status, code, detail }` while the ledger
 * returned `{ code, message }`, so a client had to know which layer refused it.
 */

/** RFC 9457 §3: the media type is the signal that a body is problem details. */
export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface ProblemDocument {
  /**
   * A URI reference naming the problem type.
   *
   * Relative on purpose — RFC 9457 §3.1.1 allows it, and a relative reference
   * resolves against the request URI, so the same document is correct whether
   * this API is reached at `api.elysium.test` or through a tunnel in
   * development. An absolute URL baked in here would be wrong in four of the
   * five environments and would have to be configuration.
   */
  readonly type: string;
  /** Short, human-readable, and the same for every occurrence of a type. */
  readonly title: string;
  readonly status: number;
  /** The stable code clients branch on. An extension member, per RFC 9457 §3.2. */
  readonly code: ErrorCode;
  /** This occurrence, in prose. Safe to show a user; never a stack or SQL. */
  readonly detail?: string;
  /**
   * The request that failed, as a path with no query string.
   *
   * Deliberately not `request.url`: a query string carries filters, and filters
   * here carry customer phone numbers (`?phone=…` on the buyer list). An error
   * body is the thing most likely to be pasted into a bug report or a Sentry
   * issue, so invariant 10 applies to it more than to most responses.
   */
  readonly instance?: string;
  /**
   * Field-level validation failures, when there are any. Present only for
   * `VALIDATION_FAILED`, so a form can mark the offending inputs rather than
   * showing one sentence about the first of them.
   */
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
  /** See `ProblemInput.reason`. */
  readonly reason?: string;
}

/**
 * The code a bare HTTP status becomes.
 *
 * Every failure gets a code, including the ones no domain module raised: a Nest
 * `ForbiddenException` from the ability guard, a 404 from an unmatched route, a
 * 500 from something unforeseen. Without this table those answers would carry
 * no `code` at all and a client would have to branch on the status — which is
 * ambiguous exactly where it matters, since 409 is both `PERIOD_CLOSED` (never
 * retry) and `IDEMPOTENCY_IN_FLIGHT` (retry shortly).
 */
const CODE_BY_STATUS: Readonly<Record<number, ErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  500: 'INTERNAL_ERROR',
  503: 'SERVICE_UNAVAILABLE',
};

/**
 * The title for a code: the code, in words.
 *
 * Generated rather than listed, because a hand-written table of 40 titles is a
 * table that will be missing the code somebody adds next week — and a problem
 * document with no title is a lint failure at best and a blank dialog at worst.
 * Titles are English and are not shown to users; `detail` is what reaches a
 * screen, and that goes through i18n at the edge that renders it.
 */
export function titleFor(code: ErrorCode): string {
  const words = code.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** `PERIOD_CLOSED` → `/problems/period-closed`. */
export function typeFor(code: ErrorCode): string {
  return `/problems/${code.toLowerCase().replace(/_/g, '-')}`;
}

export function codeForStatus(status: number): ErrorCode {
  return CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED');
}

export interface ProblemInput {
  readonly status: number;
  /**
   * Omitted means "derive it from the status". Typed `string` rather than
   * `ErrorCode`: the whole job of `problemFor` is to sanitise a code that came
   * from a service and may not be in the published set.
   */
  readonly code?: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
  /**
   * Why, as a machine token, when the code alone leaves a client guessing — a promo
   * code refused as `limit_reached` versus `min_order_not_met` sends the desk agent to
   * different places. An RFC 9457 extension member. Only ever a `snake_case` token from
   * a closed list in `packages/domain`, never prose: see `readHttpExceptionBody`.
   */
  readonly reason?: string;
}

/**
 * Build the document.
 *
 * An unrecognised `code` is replaced by the status's code rather than passed
 * through. The codes are a contract (`errors.ts` says renaming one breaks every
 * client that branches on it), and a typo'd code emitted from some service is
 * indistinguishable, to a client, from a code it has not been taught yet — so
 * it would silently fall into the client's default branch. Replacing it with
 * the status's own code at least keeps the value inside the published set.
 */
export function problemFor(input: ProblemInput): ProblemDocument {
  const code =
    input.code !== undefined && isErrorCode(input.code) ? input.code : codeForStatus(input.status);

  return {
    type: typeFor(code),
    title: titleFor(code),
    status: input.status,
    code,
    ...(input.detail === undefined || input.detail === '' ? {} : { detail: input.detail }),
    ...(input.instance === undefined ? {} : { instance: input.instance }),
    ...(input.errors === undefined || input.errors.length === 0 ? {} : { errors: input.errors }),
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  };
}

/**
 * The path, with the query string removed.
 *
 * See `instance` above for why. Also strips a trailing `?` so `/v1/orders?`
 * and `/v1/orders` produce the same instance, which matters when an operations
 * dashboard groups problems by it.
 */
export function instanceOf(url: string): string {
  return url.split('?')[0] ?? url;
}
