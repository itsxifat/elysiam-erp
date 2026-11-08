import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../i18n/locale.js';
import type * as Parts from './parts.js';

vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));
vi.mock('./parts.js', async (original) => ({
  ...(await original<typeof Parts>()),
  SettingsPage: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

const { ZonesPage } = await import('./zones.js');

/**
 * Settings → Delivery zones (D-952): Add zone opens the form when the brand has no zone yet.
 * The form lived inside the zones table, so with none (Elysiam's case after the 2026-11-05
 * cleanup) the button did nothing.
 */

let root: Root | null = null;
let host: HTMLElement;
let zones: unknown[];

beforeEach(() => {
  zones = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | string) => {
      const url = new URL(String(input));
      const body =
        url.pathname === '/v1/delivery-zones'
          ? { zones, couriers: [{ id: 'c-1', code: 'steadfast', name: 'Steadfast' }] }
          : {};
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.unstubAllGlobals();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(): Promise<void> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root ??= createRoot(host);
    root.render(
      <LocaleProvider>
        <QueryClientProvider client={client}>
          <ZonesPage />
        </QueryClientProvider>
      </LocaleProvider>,
    );
  });
  await settle();
}

function addZone(): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes('Add zone'),
  );
  if (found === undefined) throw new Error('No "Add zone" button');
  return found;
}

describe('Settings → Delivery zones', () => {
  it('opens the form from Add zone when the brand has no zone yet', async () => {
    await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => addZone().click());
    await settle();
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // The courier list is offered, so the new zone can name Steadfast.
    expect(dialog?.textContent).toContain('Delivery zone');
  });

  it('still opens it beside existing zones', async () => {
    zones = [
      {
        id: 'z-1',
        code: 'inside_dhaka',
        nameEn: 'Inside Dhaka',
        chargePoisha: '6000',
        defaultCourierId: 'c-1',
        position: 1,
        isActive: true,
      },
    ];
    await render();
    act(() => addZone().click());
    await settle();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
