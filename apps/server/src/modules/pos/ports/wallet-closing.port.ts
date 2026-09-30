import type { AuditableRequest } from '../../../platform/audit/audit.interceptor.js';
import type { ActiveContext } from '../../../platform/http/context.js';

/**
 * M08's daily closing, reused rather than rebuilt (architecture §6, §7; M23 brief).
 *
 * A branch's end of day is a till count per wallet, a derived expectation, and a
 * `closing_variance` approval when they differ — which is exactly what
 * `ClosingsService.close` already does, including the executor that posts the
 * variance once a checker decides it. A second implementation here would be a
 * second place the expected balance is derived and a second approval path for the
 * same money, and the two would disagree the first time either changed.
 *
 * The shape below is `ClosingsService.close`'s own signature. `WalletsModule`
 * exports the service for this purpose, and `PosModule` binds
 * `{ provide: POS_WALLET_CLOSING, useExisting: ClosingsService }`.
 */

export interface WalletClosingInput {
  readonly closingId: string;
  readonly walletId: string;
  readonly businessDate: string;
  readonly countedPoisha: string;
  readonly memo?: string;
}

export interface WalletClosingResult {
  readonly closingId: string;
  readonly walletId: string;
  readonly businessDate: string;
  readonly expectedPoisha: string;
  readonly countedPoisha: string;
  readonly variancePoisha: string;
  readonly status: 'balanced' | 'pending_approval' | 'posted';
  readonly approvalId: string | null;
  readonly journalId: string | null;
}

export interface WalletClosingPort {
  /** Idempotent per `closingId`: M08 returns the existing closing for a repeat. */
  close(
    context: ActiveContext,
    request: AuditableRequest,
    input: WalletClosingInput,
  ): Promise<WalletClosingResult>;
}

export const POS_WALLET_CLOSING = Symbol('WalletClosingPort');
