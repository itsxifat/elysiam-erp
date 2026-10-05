import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';
import { OrderError } from '@elysium/domain';

import { isStillReferenced } from '../../platform/references/references.js';

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
  // M39a (D-632): a template that was sent, or that the system sends.
  NOTIFY_IN_USE: 409,
  NOT_FOUND: 404,
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
    if (isStillReferenced(cause)) {
      // 0119's guard on a sent template (D-632), behind the delete's own count.
      throw notifyHttpError(
        new NotifyError('NOTIFY_IN_USE', 'This template was sent, so it is switched off instead.'),
      );
    }
    // A phone that is not a Bangladeshi mobile is the caller's input, not a server fault.
    // `normalizeBdPhone` is the order domain's, so its refusal carries the order code.
    if (cause instanceof OrderError && cause.code === 'ORDER_PHONE_INVALID') {
      throw new BadRequestException({ code: cause.code, message: cause.message });
    }
    throw cause;
  }
}
