import { z } from 'zod';

import { FakeNarrativeProvider, type NarrativeProvider } from './providers/narrative.provider.js';

/**
 * The analytics module's configuration (M24). Parsed here rather than in `serverEnv()` for
 * the reason the marketing and courier configs give: parallel milestones edit that file.
 *
 * - `ANALYTICS_NARRATIVE_PROVIDER`: `fake` only (D-327). The per-org flag
 *   `analytics.llm_narrative` decides whether a brand sees a narrative at all.
 *
 * The leaderboard's weights (`ANALYTICS_LEADERBOARD_WEIGHTS`, D-323) left with the
 * leaderboard (D-471): a brand's ERP ranks no brands.
 */
const schema = z.object({
  ANALYTICS_NARRATIVE_PROVIDER: z.enum(['fake']).default('fake'),
});

export interface AnalyticsConfig {
  readonly narrativeProvider: 'fake';
}

export const ANALYTICS_CONFIG = Symbol('AnalyticsConfig');

export function analyticsConfig(env: NodeJS.ProcessEnv = process.env): AnalyticsConfig {
  const parsed = schema.parse(
    Object.fromEntries(Object.entries(env).filter(([, value]) => value !== '')),
  );
  return { narrativeProvider: parsed.ANALYTICS_NARRATIVE_PROVIDER };
}

export function narrativeProviderFor(config: AnalyticsConfig): NarrativeProvider {
  switch (config.narrativeProvider) {
    case 'fake':
      return new FakeNarrativeProvider();
  }
}
