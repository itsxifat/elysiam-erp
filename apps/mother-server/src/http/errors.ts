import { isMotherErrorCode, type MotherErrorCode } from '@elysium/mother-shared';

/**
 * A refusal the mother means to make, with a stable code and a sentence safe to show an
 * owner. Anything else that escapes a handler becomes a 500 with no detail (D-480).
 */
export class MotherError extends Error {
  constructor(
    readonly code: MotherErrorCode,
    message: string,
    readonly status: number = statusFor(code),
    readonly errors?: readonly { readonly path: string; readonly message: string }[],
  ) {
    super(message);
    this.name = 'MotherError';
  }
}

function statusFor(code: MotherErrorCode): number {
  switch (code) {
    case 'VALIDATION_FAILED':
    case 'INVALID_PASSWORD':
    case 'INVALID_CODE':
      return 400;
    case 'UNAUTHENTICATED':
      return 401;
    case 'FORBIDDEN':
    case 'TWO_FACTOR_ENROLMENT_REQUIRED':
    case 'ACCOUNT_INACTIVE':
    case 'SELF_ACTION_REFUSED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'METHOD_NOT_ALLOWED':
      return 405;
    case 'CONFLICT':
    case 'BRAND_SLUG_TAKEN':
    case 'LAST_OWNER':
    case 'RESET_NOT_DECIDABLE':
    case 'EMAIL_TAKEN':
    case 'OWNER_LINK_KEY_MISSING':
    case 'BRAND_INACTIVE':
    case 'BRAND_VERSION_MISMATCH':
    case 'TWO_FACTOR_SETUP_EXPIRED':
      return 409;
    case 'PAYLOAD_TOO_LARGE':
      return 413;
    case 'UNSUPPORTED_MEDIA_TYPE':
      return 415;
    case 'BRAND_CONNECTION_REFUSED':
      return 422;
    case 'RATE_LIMITED':
      return 429;
    case 'BRAND_UNREACHABLE':
      return 502;
    case 'SERVICE_UNAVAILABLE':
      return 503;
    case 'INTERNAL_ERROR':
    case 'SECRETS_KEY_INVALID':
      return 500;
  }
}

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

export interface ProblemDocument {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: MotherErrorCode;
  readonly detail?: string;
  readonly instance?: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}

const CODE_BY_STATUS: Readonly<Record<number, MotherErrorCode>> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'RATE_LIMITED',
  503: 'SERVICE_UNAVAILABLE',
};

/** RFC 9457: the same document whichever layer refuses (§23, D-087's rule, mother copy). */
export function problemFor(input: {
  readonly status: number;
  readonly code?: string;
  readonly detail?: string;
  readonly instance?: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}): ProblemDocument {
  const code: MotherErrorCode =
    input.code !== undefined && isMotherErrorCode(input.code)
      ? input.code
      : (CODE_BY_STATUS[input.status] ??
        (input.status >= 500 ? 'INTERNAL_ERROR' : 'VALIDATION_FAILED'));
  const words = code.toLowerCase().replace(/_/g, ' ');
  return {
    type: `/problems/${code.toLowerCase().replace(/_/g, '-')}`,
    title: words.charAt(0).toUpperCase() + words.slice(1),
    status: input.status,
    code,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.instance === undefined ? {} : { instance: input.instance }),
    ...(input.errors === undefined ? {} : { errors: input.errors }),
  };
}

/** The path a problem names: never the query string, which can carry anything. */
export function instanceOf(url: string): string {
  return url.split('?')[0] ?? '';
}
