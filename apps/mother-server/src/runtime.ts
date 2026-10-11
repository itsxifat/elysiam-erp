import type { LeaderboardWeights } from '@elysium/domain/analytics';
import type { Logger } from 'pino';

import type { BrandPools } from './brands/pools.js';
import type { SecretsKey } from './crypto/secrets.js';
import type { PullBrandJob } from './jobs/jobs.js';

/**
 * What the API's handlers need from the process that runs them: built once by
 * `main.api.ts` (or by a test), handed to Nest as one provider.
 */
export interface MotherRuntime {
  /** The origin the owner opens; links the mother hands out start here (D-491). */
  readonly publicUrl: string;
  readonly secrets: () => SecretsKey;
  readonly pools: BrandPools;
  /** Queue a pull for the worker. */
  readonly enqueuePull: (job: PullBrandJob) => Promise<void>;
  readonly weights: LeaderboardWeights;
  readonly clock: () => Date;
  readonly logger: Logger;
}

export const RUNTIME = Symbol('MOTHER_RUNTIME');

/** Better Auth's hasher and sealer for My account (M40), resolved once at start-up. */
export const ACCOUNT_CRYPTO = Symbol('MOTHER_ACCOUNT_CRYPTO');
