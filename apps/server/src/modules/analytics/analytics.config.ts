import { parseWeights, type LeaderboardWeights } from '@elysium/domain/analytics';
import { z } from 'zod';

import { FakeNarrativeProvider, type NarrativeProvider } from './providers/narrative.provider.js';

/**
 * The analytics module's configuration (M24). Parsed here rather than in `serverEnv()` for
 * the reason the marketing and courier configs give: parallel milestones edit that file.
 *
 * - `ANALYTICS_LEADERBOARD_WEIGHTS`: JSON of metric → whole-number weight 0–100, merged
 *   over the defaults (D-323). A bad value stops the process at boot rather than ranking
 *   five brands on weights nobody chose.
 * - `ANALYTICS_NARRATIVE_PROVIDER`: `fake` only (D-327). The per-org flag
 *   `analytics.llm_narrative` decides whether a brand sees a narrative at all.
 */
const schema = z.object({
  ANALYTICS_LEADERBOARD_WEIGHTS: z.string().optional(),
  ANALYTICS_NARRATIVE_PROVIDER: z.enum(['fake']).default('fake'),
});

export interface AnalyticsConfig {
  readonly weights: LeaderboardWeights;
  readonly narrativeProvider: 'fake';
}

export const ANALYTICS_CONFIG = Symbol('AnalyticsConfig');

export function analyticsConfig(env: NodeJS.ProcessEnv = process.env): AnalyticsConfig {
  const parsed = schema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
  let weights: unknown;
  try {
    weights =
      parsed.ANALYTICS_LEADERBOARD_WEIGHTS === undefined
        ? undefined
        : (JSON.parse(parsed.ANALYTICS_LEADERBOARD_WEIGHTS) as unknown);
  } catch {
    throw new Error('ANALYTICS_LEADERBOARD_WEIGHTS must be JSON, e.g. {"roas":3,"returnRate":2}.');
  }
  return {
    weights: parseWeights(weights),
    narrativeProvider: parsed.ANALYTICS_NARRATIVE_PROVIDER,
  };
}

export function narrativeProviderFor(config: AnalyticsConfig): NarrativeProvider {
  switch (config.narrativeProvider) {
    case 'fake':
      return new FakeNarrativeProvider();
  }
}
