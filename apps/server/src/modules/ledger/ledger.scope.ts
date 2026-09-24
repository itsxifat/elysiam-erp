import { NotFoundException } from '@nestjs/common';
import type { ScopedRow } from '@elysium/contracts';

import { assertInScope } from '../../platform/auth/scope.js';
import { ledgerHttpError } from './ledger.errors.js';

/**
 * `assertInScope`, answering exactly as a missing account does.
 *
 * The plain helper's bare "Not found." differs from the ledger's
 * `LEDGER_ACCOUNT_NOT_FOUND` body, so a branch manager could tell "a wallet in
 * another branch" from "no such wallet" (M03 security review L1). Out of
 * scope and nonexistent must be the same answer.
 */
export function assertAccountInScope(request: object, row: ScopedRow, message: string): void {
  try {
    assertInScope(request, row);
  } catch (error) {
    if (error instanceof NotFoundException) {
      throw ledgerHttpError('LEDGER_ACCOUNT_NOT_FOUND', message);
    }
    throw error;
  }
}
