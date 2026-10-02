import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';

/**
 * What the staff routes refuse, and with which status (gaps-users-auth, §23).
 *
 * Codes from `packages/contracts/src/errors.ts`, so the console branches on the code.
 * No message here starts "You cannot": the route-matrix suite reads that phrase as the
 * guard's refusal, and these are the handler's.
 */

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  USER_NOT_FOUND: HttpStatus.NOT_FOUND,
  USER_SELF_MANAGEMENT: HttpStatus.FORBIDDEN,
  USER_PROTECTED: HttpStatus.FORBIDDEN,
  USER_INACTIVE: HttpStatus.CONFLICT,
  CREDENTIAL_RESET_PENDING: HttpStatus.CONFLICT,
  CREDENTIAL_NOTHING_TO_RESET: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  CONFLICT: HttpStatus.CONFLICT,
  VALIDATION_FAILED: HttpStatus.BAD_REQUEST,
};

export function usersHttpError(code: ErrorCode, message: string): HttpException {
  const body = { code, message };
  const status: number = STATUS[code] ?? HttpStatus.BAD_REQUEST;
  if (status === Number(HttpStatus.FORBIDDEN)) return new ForbiddenException(body);
  if (status === Number(HttpStatus.NOT_FOUND)) return new NotFoundException(body);
  if (status === Number(HttpStatus.CONFLICT)) return new ConflictException(body);
  if (status === Number(HttpStatus.TOO_MANY_REQUESTS)) {
    return new HttpException(body, HttpStatus.TOO_MANY_REQUESTS);
  }
  return new BadRequestException(body);
}

/** The PostgreSQL error a statement failed with, found through Drizzle's wrapper. */
export function pgCode(error: unknown): string | undefined {
  for (let current = error; current instanceof Error; current = current.cause) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}
