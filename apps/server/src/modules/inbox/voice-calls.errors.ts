import { ConflictException } from '@nestjs/common';

import { InboxError, mapInboxErrors } from './inbox.errors.js';

/**
 * M45's failures (D-780 to D-788) as the API reports them: M42's `InboxError` and mapping, with
 * the conflicts a call has (over, picked up by someone else, refused by Meta) answered 409. Its
 * own file so M42's status table stays as it was.
 */
const CONFLICTS = new Set(['INBOX_CALL_GONE', 'INBOX_CALL_TAKEN', 'INBOX_CALL_FAILED']);

export async function mapVoiceCallErrors<T>(work: () => Promise<T>): Promise<T> {
  return mapInboxErrors(async () => {
    try {
      return await work();
    } catch (cause) {
      if (cause instanceof InboxError && CONFLICTS.has(cause.code)) {
        throw new ConflictException({
          code: cause.code,
          message: cause.message,
          ...(cause.reason === undefined ? {} : { reason: cause.reason }),
        });
      }
      throw cause;
    }
  });
}
