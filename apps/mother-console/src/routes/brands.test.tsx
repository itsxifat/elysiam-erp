import type { BrandStatusWire } from '@elysium/mother-shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { endpoints } from '../api.js';
import { LocaleProvider } from '../i18n/locale.js';
import { BrandsPage } from './brands.js';

/**
 * The Brands screen after D-700: brands are added, re-pointed and re-keyed on the server,
 * so the screen says so and offers none of the three; the name, address and "read this
 * brand" are all an owner changes here, and the edit never sends a connection.
 */

const BRAND: BrandStatusWire = {
  id: '6f1c2d4e-0000-4000-8000-000000000001',
  slug: 'oura-lifestyle',
  displayName: 'Oura Lifestyle',
  adminUrl: 'https://erp.oura.example',
  isActive: true,
  figuresAt: new Date().toISOString(),
  lastAttemptAt: new Date().toISOString(),
  lastError: null,
  schema: 'ok',
  brandMigrations: 133,
  expectedMigrations: 133,
  hasOwnerLinkKey: true,
  ownerLinkKeyFingerprint: '0123456789abcdef',
  connectionFingerprint: 'abcdef012345',
};

function show() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <LocaleProvider>
      <QueryClientProvider client={client}>
        <BrandsPage />
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(endpoints, 'brands').mockResolvedValue({ brands: [BRAND] });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Brands', () => {
  it('says brands are added on the server, and offers no add, re-point or new key', async () => {
    show();
    expect(await screen.findByRole('heading', { name: 'Oura Lifestyle' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Brands are added on the server' })).toBeTruthy();
    expect(screen.getByText(/no database password is ever typed into a browser/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /add a brand/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /replace the key|make a key/i })).toBeNull();
    expect(screen.getByText('Made and replaced on the server.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeTruthy();
  });

  it('edits the name, address and reading, and never sends a connection', async () => {
    const update = vi.spyOn(endpoints, 'updateBrand').mockResolvedValue(BRAND);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText(/read connection/i)).toBeNull();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Oura' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(BRAND.id, {
        displayName: 'Oura',
        adminUrl: BRAND.adminUrl,
        isActive: true,
      }),
    );
  });

  it('tells an owner with no brands to ask the operator', async () => {
    vi.spyOn(endpoints, 'brands').mockResolvedValue({ brands: [] });
    show();
    expect(await screen.findByText(/Ask the operator to add the first brand/)).toBeTruthy();
  });
});
