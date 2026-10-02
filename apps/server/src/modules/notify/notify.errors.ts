import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';
import { OrderError } from '@elysium/domain';

/**
 * Notify failures, as the API reports them (architecture §23, D-087): a stable `code`
 * from `packages/contracts/src/errors.ts` and a message, so a client branches on the code.
 */
export class NotifyError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'NotifyError';
  }
}

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  NOTIFY_TEMPLATE_INVALID: 400,
  NOTIFY_MESSAGE_IMMUTABLE: 409,
};

export function notifyHttpError(error: NotifyError): HttpException {
  const body = { code: error.code, message: error.message };
  switch (STATUS[error.code] ?? 400) {
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    default:
      return new BadRequestException(body);
  }
}

export async function mapNotifyErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof NotifyError) throw notifyHttpError(cause);
    // A phone that is not a Bangladeshi mobile is the caller's input, not a server fault.
    // `normalizeBdPhone` is the order domain's, so its refusal carries the order code.
    if (cause instanceof OrderError && cause.code === 'ORDER_PHONE_INVALID') {
      throw new BadRequestException({ code: cause.code, message: cause.message });
    }
    throw cause;
  }
}
