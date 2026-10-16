import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
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
  PACKING_CAMERA_PASSWORD_REQUIRED: 400,
  PACKING_CAMERA_LIMIT: 409,
  PACKING_CAMERA_IN_USE: 409,
  PACKING_PREVIEW_UNAVAILABLE: 503,
  WEBSITE_CREDENTIALS_MISSING: 409,
  CONFLICT: 409,
  FORBIDDEN: 403,
  // M46: Labels and Packaging (D-800 to D-826).
  TERMINAL_NOT_FOUND: 404,
  TERMINAL_DEVICE_INVALID: 404,
  TERMINAL_NOT_ASSIGNED: 403,
  PRINTER_INVALID: 400,
  PRINT_NO_PRINTER: 409,
  PRINT_REASON_REQUIRED: 400,
  PRINT_JOB_STATE: 409,
  LOTS_LOCKED: 409,
  LOT_CLOSE_REFUSED: 409,
  ORDER_LOTS_NOT_HANDED: 409,
  ORDER_NOT_FOUND: 404,
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
    case 503:
      return new ServiceUnavailableException(body);
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
    // M46: two terminals or printers of a brand never share a name.
    if ((current as { code?: unknown }).code === '23505') {
      const constraint = (current as { constraint_name?: unknown }).constraint_name;
      if (constraint === 'packing_terminals_org_name_idx') {
        return packingHttpError('CONFLICT', 'Another terminal already has that name.');
      }
      if (constraint === 'printers_org_name_live_idx') {
        return packingHttpError('CONFLICT', 'Another printer already has that name.');
      }
    }
    // M46: a terminal's location that is not one of this brand's.
    if (
      (current as { code?: unknown }).code === '23503' &&
      (current as { constraint_name?: unknown }).constraint_name ===
        'packing_terminals_org_id_location_id_fk'
    ) {
      return packingHttpError('NOT_FOUND', 'No such stock location.');
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
