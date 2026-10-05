import { describe, expect, it } from 'vitest';

import { analyticsConfig, narrativeProviderFor } from './analytics.config.js';
import { FakeNarrativeProvider } from './providers/narrative.provider.js';

/** The only narrative provider is the fake (D-327). */
describe('analyticsConfig', () => {
  it('boots with the fake provider', () => {
    const config = analyticsConfig({});
    expect(narrativeProviderFor(config)).toBeInstanceOf(FakeNarrativeProvider);
  });

  it('names no real narrative provider', () => {
    expect(() => analyticsConfig({ ANALYTICS_NARRATIVE_PROVIDER: 'anthropic' })).toThrow();
  });
});
