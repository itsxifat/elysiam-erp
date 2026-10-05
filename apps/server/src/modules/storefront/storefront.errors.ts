import { HttpException, HttpStatus } from '@nestjs/common';
import { isErrorCode, type ErrorCode } from '@elysium/contracts';

/**
 * The website's refusals, as problems with codes from `errors.ts` (§23).
 *
 * Two audiences. The console's screens get the storefront's own codes
 * (`STOREFRONT_NOT_FOUND`, `STOREFRONT_INVALID`, `STOREFRONT_IN_USE`) and the catalog's when
 * the catalog refused (a product that does not exist). The website's server gets the
 * platform's general ones — `UNAUTHENTICATED`, `RATE_LIMITED`, `SERVICE_UNAVAILABLE`,
 * `NOT_FOUND`, `VALIDATION_FAILED` — and, like the intake, one sentence for every failed
 * authentication.
 */
export class StorefrontError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    /** Seconds, for a 429. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'StorefrontError';
  }

  toHttp(): HttpException {
    return new HttpException({ code: this.code, message: this.message }, this.status);
  }
}

export const storefrontNotFound = (what: string): StorefrontError =>
  new StorefrontError(
    'STOREFRONT_NOT_FOUND',
    HttpStatus.NOT_FOUND,
    `No such ${what} in this brand.`,
  );

export const storefrontInvalid = (message: string): StorefrontError =>
  new StorefrontError('STOREFRONT_INVALID', HttpStatus.BAD_REQUEST, message);

/**
 * One sentence for an unknown, revoked or malformed key, a stale timestamp and a wrong
 * signature. Telling them apart would tell a prober which half of a forged request was
 * right; the server log says which check failed.
 */
export function notAuthenticated(): StorefrontError {
  return new StorefrontError(
    'UNAUTHENTICATED',
    HttpStatus.UNAUTHORIZED,
    'The request was not accepted: check the key id, the timestamp and the signature.',
  );
}

const STATUS_BY_CODE: Readonly<Partial<Record<string, number>>> = {
  CATALOG_NOT_FOUND: HttpStatus.NOT_FOUND,
  CATALOG_DUPLICATE: HttpStatus.CONFLICT,
  STOREFRONT_NOT_FOUND: HttpStatus.NOT_FOUND,
  STOREFRONT_IN_USE: HttpStatus.CONFLICT,
};

/**
 * A refusal from this module or from a module it asked through its `*.api.ts` (the
 * catalog's `CatalogError` carries a contract code too), as an HTTP problem. Anything else
 * is rethrown and becomes the 500 it is.
 */
export function toStorefrontHttp(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof StorefrontError) return error.toHttp();
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string' && isErrorCode(code)) {
      return new HttpException(
        { code, message: error.message },
        STATUS_BY_CODE[code] ?? HttpStatus.BAD_REQUEST,
      );
    }
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      const sqlstate = (current as { code?: unknown }).code;
      const constraint = (current as { constraint_name?: unknown }).constraint_name;
      if (sqlstate === '23505' && constraint === 'size_charts_org_name_idx') {
        return new HttpException(
          { code: 'STOREFRONT_INVALID', message: 'Another size chart already has that name.' },
          HttpStatus.CONFLICT,
        );
      }
      if (sqlstate === '23503') {
        // A composite foreign key: a file, a category, a location or a chart that is not
        // this brand's. One answer, because which one would say what exists elsewhere.
        return new HttpException(
          {
            code: 'STOREFRONT_NOT_FOUND',
            message: 'Something this refers to is not in this brand.',
          },
          HttpStatus.NOT_FOUND,
        );
      }
    }
  }
  return error;
}

export async function mapStorefrontErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toStorefrontHttp(error);
  }
}
