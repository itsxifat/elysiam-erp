import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type * as Router from '@tanstack/react-router';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../i18n/locale.js';
import type { ReadyOrder } from './api.js';

vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));
// The order number's link needs the router; the panel around it is what is tested here.
vi.mock('@tanstack/react-router', async (original) => ({
  ...(await original<typeof Router>()),
  Link: ({ children }: { readonly children?: ReactNode }) => <a href="/orders">{children}</a>,
}));

const { ReadyPanel } = await import('./queue-panels.js');

/**
 * Ready for label (D-917): nothing prints by itself, so a confirmed order waits here until
 * someone releases the queue. Print all labels prints the label of every order listed, with no
 * ticking; Print selected prints the ticked ones; neither prints a slip. The server is a stubbed
 * `fetch`.
 */

function order(no: string): ReadyOrder {
  return {
    orderId: `00000000-0000-4000-8000-00000000000${no}`,
    orderNo: `EL-100${no}`,
    consignmentNo: null,
    courier: null,
    customer: `Customer ${no}`,
    locationId: null,
    bookedAt: null,
    lotCount: 1,
    labelsPrinted: 0,
    pieces: 2,
    codPoisha: '125000',
  };
}

let root: Root | null = null;
let host: HTMLElement;
let ready: ReadyOrder[];
let prints: { orderIds: string[]; documents: string[] }[];

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  prints = [];
  ready = [order('1'), order('2')];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/v1/labels/ready') return Promise.resolve(respond({ items: ready }));
      if (url.pathname === '/v1/team/me') {
        return Promise.resolve(respond({ profile: { hubLocationId: null } }));
      }
      if (url.pathname === '/v1/inventory/locations')
        return Promise.resolve(respond({ items: [] }));
      if (url.pathname === '/v1/labels/print' && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as {
          orderIds: string[];
          documents: string[];
        };
        prints.push(body);
        return Promise.resolve(
          respond({ jobs: body.orderIds.map((orderId) => ({ id: `job-${orderId}`, orderId })) }),
        );
      }
      return Promise.resolve(respond({}));
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
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(): Promise<void> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  act(() => {
    root ??= createRoot(host);
    root.render(
      <LocaleProvider>
        <QueryClientProvider client={queryClient}>
          <ReadyPanel />
        </QueryClientProvider>
      </LocaleProvider>,
    );
  });
  await settle();
}

const button = (testId: string) =>
  host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);

describe('Ready for label', () => {
  it('prints the label of every order listed with one press, and no slip', async () => {
    await render();
    const all = button('print-all-labels');
    expect(all?.textContent).toBe('Print all labels (2)');
    expect(all?.disabled).toBe(false);
    // Labels only from here: no button prints the slip.
    expect(host.textContent).not.toMatch(/slip/i);

    await act(async () => {
      all?.click();
      await Promise.resolve();
    });
    await settle();
    expect(prints).toEqual([{ orderIds: ready.map((one) => one.orderId), documents: ['label'] }]);
    expect(host.querySelector('[data-testid="ready-notice"]')?.textContent).toBe('2 labels queued');
  });

  it('prints only the ticked orders with Print selected, labels only', async () => {
    await render();
    expect(button('print-selected-labels')?.disabled).toBe(true);
    const tick = host.querySelector<HTMLElement>(
      `[aria-label="Select ${ready[1]?.orderNo ?? ''}"]`,
    );
    await act(async () => {
      tick?.click();
      await Promise.resolve();
    });
    expect(button('print-selected-labels')?.disabled).toBe(false);
    await act(async () => {
      button('print-selected-labels')?.click();
      await Promise.resolve();
    });
    await settle();
    expect(prints).toEqual([{ orderIds: [ready[1]?.orderId], documents: ['label'] }]);
  });

  it('describes the queue, and has nothing to print when it is empty', async () => {
    ready = [];
    await render();
    expect(host.querySelector('[data-testid="ready-lead"]')?.textContent).toContain(
      'Nothing prints by itself',
    );
    expect(host.textContent).toContain('Nothing is waiting for a label');
    expect(button('print-all-labels')?.textContent).toBe('Print all labels (0)');
    expect(button('print-all-labels')?.disabled).toBe(true);
    expect(button('print-selected-labels')?.disabled).toBe(true);
  });
});
