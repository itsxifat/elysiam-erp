import { DEFAULT_LEADERBOARD_WEIGHTS } from '@elysium/domain/analytics';
import { describe, expect, it } from 'vitest';

import { analyticsConfig, narrativeProviderFor } from './analytics.config.js';
import { FakeNarrativeProvider } from './providers/narrative.provider.js';

/** The weights are configuration (D-323), and the only narrative provider is the fake (D-327). */
describe('analyticsConfig', () => {
  it('boots with the default weights and the fake provider', () => {
    const config = analyticsConfig({});
    expect(config.weights).toEqual(DEFAULT_LEADERBOARD_WEIGHTS);
    expect(narrativeProviderFor(config)).toBeInstanceOf(FakeNarrativeProvider);
  });

  it('reads weights from the environment over the defaults', () => {
    const config = analyticsConfig({ ANALYTICS_LEADERBOARD_WEIGHTS: '{"roas":5,"cpdo":0}' });
    expect(config.weights).toEqual({ ...DEFAULT_LEADERBOARD_WEIGHTS, roas: 5, cpdo: 0 });
  });

  it('stops the process on weights nobody could have meant', () => {
    expect(() => analyticsConfig({ ANALYTICS_LEADERBOARD_WEIGHTS: 'roas=5' })).toThrow(/JSON/);
    expect(() => analyticsConfig({ ANALYTICS_LEADERBOARD_WEIGHTS: '{"responseTime":1}' })).toThrow(
      /not a leaderboard metric/,
    );
  });

  it('names no real narrative provider', () => {
    expect(() => analyticsConfig({ ANALYTICS_NARRATIVE_PROVIDER: 'anthropic' })).toThrow();
  });
});
