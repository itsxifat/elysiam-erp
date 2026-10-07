import type { BrandStatusWire } from '@elysium/mother-shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { LocaleProvider } from '../i18n/locale.js';
import { BrandFreshness } from './brand-status.js';

/**
 * Check 4 on the screen (D-486): a brand that could not be read keeps its last figures, shown
 * with their age, and a labelled error badge; a good read shows no badge.
 */
const base: BrandStatusWire = {
  id: 'b1',
  slug: 'oura-lifestyle',
  displayName: 'Oura Lifestyle',
  adminUrl: 'https://erp.example.com',
  isActive: true,
  figuresAt: new Date(Date.now() - 2 * 3_600_000).toISOString(),
  lastAttemptAt: new Date().toISOString(),
  lastError: null,
  schema: 'ok',
  brandMigrations: 133,
  expectedMigrations: 133,
  hasOwnerLinkKey: true,
  ownerLinkKeyFingerprint: null,
  connectionFingerprint: 'fp',
} as BrandStatusWire;

function show(brand: BrandStatusWire): void {
  render(
    <LocaleProvider>
      <BrandFreshness brand={brand} />
    </LocaleProvider>,
  );
}

describe('BrandFreshness', () => {
  afterEach(cleanup);

  it('a failed read after the last good one: the figures’ age and a labelled error badge', () => {
    show({ ...base, lastError: { code: 'unreachable', at: new Date().toISOString() } });
    expect(screen.getByText(/Figures from/)).toBeTruthy();
    expect(screen.getByText('Could not read')).toBeTruthy();
  });

  it('a good read: the age and no badge', () => {
    show(base);
    expect(screen.getByText(/Figures from/)).toBeTruthy();
    expect(screen.queryByText('Could not read')).toBeNull();
  });
});
