import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  type HttpException,
} from '@nestjs/common';
import type { ErrorCode } from '@elysium/contracts';

import { toLedgerHttpError } from '../ledger/ledger.errors.js';

/**
 * What the wallets module refuses, and with which status (architecture §23).
 *
 * The codes come from `packages/contracts/src/errors.ts` like every other
 * module's, so a client branches on the code and never on the wording. The
 * ledger's own failures pass through `toLedgerHttpError` unchanged — a closed
 * period or an unbalanced draft is the ledger's answer, and restating it here
 * would give the same condition two codes.
 */

const STATUS: Readonly<Partial<Record<ErrorCode, number>>> = {
  RECEIPT_REQUIRED: 400,
  CLOSING_ALREADY_RECORDED: 409,
  WALLET_INACTIVE: 409,
  // A wallet outside the caller's branch scope answers exactly as one that does
  // not exist. Any other answer is a way of enumerating other branches' tills.
  LEDGER_ACCOUNT_NOT_FOUND: 404,
  IDEMPOTENCY_CONFLICT: 409,
  APPROVAL_REQUIRED: 409,
  // The consolidated view is the platform super admin's: an ordinary org admin
  // holds `read LedgerReport` at `org`, so this is a refusal about scope rather
  // than about the ability, and 403 is the honest status for it.
  FORBIDDEN: 403,
};

export function walletsHttpError(code: ErrorCode, message: string): HttpException {
  const body = { code, message };
  switch (STATUS[code] ?? 400) {
    case 403:
      return new ForbiddenException(body);
    case 404:
      return new NotFoundException(body);
    case 409:
      return new ConflictException(body);
    default:
      return new BadRequestException(body);
  }
}

/** Run `work`, translating wallet and ledger failures on the way out. */
export async function mapWalletErrors<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    // Already an HTTP error (including everything `walletsHttpError` built) or a
    // ledger failure the ledger has a code for. Anything else becomes a 500 and
    // a log line, which is the right outcome for a fault we did not anticipate.
    throw toLedgerHttpError(error);
  }
}
