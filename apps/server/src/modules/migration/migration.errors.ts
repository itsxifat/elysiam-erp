import type { ErrorCode } from '@elysium/contracts';
import type { ImportProblem } from '@elysium/domain';

/**
 * Data migration failures (M14a), with a stable code from `packages/contracts/src/errors.ts`.
 *
 * There is no HTTP edge (D-214): the operator's command prints the code, the message and,
 * for a refused file, every problem by line and column. A refusal always means nothing
 * was changed, because it is thrown from inside the transaction that would have written.
 */
export class MigrationError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly problems: readonly ImportProblem[] = [],
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/**
 * The trigger codes of migration 0082 (and the ledger's), as a `MigrationError`.
 *
 * A trigger refusal arrives as a driver error whose message starts with the code; mapped
 * here so a refused change reads the same whichever layer noticed it.
 */
export function asMigrationError(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const text = `${error.message} ${String((error as { cause?: { message?: string } }).cause?.message ?? '')}`;
  for (const code of ['MIGRATION_BATCH_IMMUTABLE', 'MIGRATION_OPENING_IMMUTABLE'] as const) {
    if (text.includes(code)) return new MigrationError(code, text.slice(text.indexOf(code)).trim());
  }
  return error;
}
