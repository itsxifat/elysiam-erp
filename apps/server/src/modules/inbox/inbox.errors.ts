import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';

import { SealedBoxUnavailable } from '../../platform/crypto/sealed-box.js';

/**
 * Inbox failures, as the API reports them (architecture §23, D-087): a stable code from
 * `packages/contracts/src/errors.ts`, a message, and where it helps a client, a `reason` token.
 * Never a token, a secret or a customer's phone.
 */
export class InboxError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    /** A snake_case token from a closed list (problem+json's `reason`). */
    readonly reason?: string,
  ) {
    super(message);
    this.name = 'InboxError';
  }
}

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  INBOX_NOT_FOUND: 404,
  INBOX_INVALID: 400,
  INBOX_OWNER_ACK_REQUIRED: 409,
  INBOX_HANDOVER_NOT_ALLOWED: 403,
  INBOX_ASSIGNEE_INVALID: 400,
  INBOX_WINDOW_CLOSED: 409,
  INBOX_CHANNEL_NOT_READY: 409,
  INBOX_STAGE_INVALID: 409,
  INBOX_CREDENTIALS_MISSING: 409,
};

export function inboxHttpError(error: InboxError): HttpException {
  const body = {
    code: error.code,
    message: error.message,
    ...(error.reason === undefined ? {} : { reason: error.reason }),
  };
  switch (STATUS[error.code] ?? 400) {
    case 404:
      return new NotFoundException(body);
    case 403:
      return new ForbiddenException(body);
    case 409:
      return new ConflictException(body);
    default:
      return new BadRequestException(body);
  }
}

/** Run `work`, turning this module's errors into problem+json and leaving others alone. */
export async function mapInboxErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (cause) {
    if (cause instanceof InboxError) throw inboxHttpError(cause);
    if (cause instanceof SealedBoxUnavailable) {
      throw inboxHttpError(
        new InboxError(
          'INBOX_CREDENTIALS_MISSING',
          'This installation has no credentials key, so Meta secrets cannot be kept.',
        ),
      );
    }
    throw cause;
  }
}
