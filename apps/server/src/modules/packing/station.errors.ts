import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { isErrorCode, type ErrorCode } from '@elysium/contracts';

/**
 * The packing station's refusals as problem+json (M38b, §23): a contract code and a sentence
 * a packer can act on.
 */

const STATUS: Partial<Record<ErrorCode, number>> = {
  NOT_FOUND: 404,
  SHIPMENT_NOT_FOUND: 404,
  PACKING_NOT_PACKABLE: 409,
  PACKING_INCOMPLETE: 409,
  PACKING_NOTHING_TO_REMOVE: 409,
  PACKING_VIDEO_INVALID: 409,
  PACKING_VIDEO_GONE: 410,
  PACKING_CAMERA_INVALID: 409,
  WEBSITE_CREDENTIALS_MISSING: 409,
  CONFLICT: 409,
  FORBIDDEN: 403,
};

export class PackingError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PackingError';
  }
}

export function packingHttpError(code: ErrorCode, message: string): HttpException {
  const body = { code, message };
  switch (STATUS[code] ?? 400) {
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    case 410:
      return new GoneException(body);
    case 403:
      return new ForbiddenException(body);
    default:
      return new BadRequestException(body);
  }
}

/** The order machine's refusal of `pack`, said as the station says it. */
const ORDER_CODES: Partial<Record<ErrorCode, ErrorCode>> = {
  ORDER_TRANSITION_INVALID: 'PACKING_NOT_PACKABLE',
  ORDER_IMMUTABLE: 'PACKING_NOT_PACKABLE',
};

function toPackingHttpError(error: unknown): unknown {
  if (error instanceof HttpException) return error;
  if (error instanceof PackingError) return packingHttpError(error.code, error.message);
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    // One file is one part's video: the same upload attached to a second part (two attaches
    // racing, or a file id reused for another recording) is the caller's mistake, not ours.
    if (
      (current as { code?: unknown }).code === '23505' &&
      (current as { constraint_name?: unknown }).constraint_name === 'packing_videos_file_idx'
    ) {
      return packingHttpError(
        'PACKING_VIDEO_INVALID',
        'That video is already attached to another recording.',
      );
    }
    // The tables' triggers (migrations 0130 and 0133) raise `CONFLICT: <sentence>`.
    const prefixed = /^CONFLICT: (.*)$/s.exec(current.message);
    if (prefixed !== null) return packingHttpError('CONFLICT', prefixed[1] ?? current.message);
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && isErrorCode(code)) {
      return packingHttpError(ORDER_CODES[code] ?? code, current.message);
    }
  }
  return error;
}

export async function mapPackingErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw toPackingHttpError(error);
  }
}
