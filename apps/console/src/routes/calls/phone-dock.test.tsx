import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../i18n/locale.js';
import type { MyPhone } from './api.js';
import type { EnvoPhone, EnvoPhoneEvent } from './widget.js';

vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));

const { Dock } = await import('./phone-dock.js');

/**
 * The console's phone (M47, D-843): Envo's widget is started once per connection, extension and
 * start, never once per render (the review's envo-2: an unstable dependency once tore the phone
 * down on every render), and a ringing card that names nobody asks who is calling again. Envo's
 * widget is a fake on `window.Envo`; the server is a stubbed `fetch`.
 */

const PHONE: MyPhone = {
  connectionId: 'c0f3a0e8-8f0e-4c55-9d0b-2b4a1f2b7c11',
  connectionName: 'Envo',
  extension: '101',
  baseUrl: 'https://envo.example',
  ready: true,
  notReady: null,
};

let root: Root | null = null;
let host: HTMLElement;
let requests: { method: string; path: string }[];
let widget: { [K in keyof Omit<EnvoPhone, 'status'>]: ReturnType<typeof vi.fn> };
let started: { onEvent: (event: EnvoPhoneEvent) => void }[];
let queryClient: QueryClient;

function respond(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  requests = [];
  started = [];
  widget = {
    call: vi.fn(),
    answer: vi.fn(),
    hangup: vi.fn(),
    open: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
  };
  vi.stubGlobal('Envo', {
    phone: vi.fn((options: { onEvent: (event: EnvoPhoneEvent) => void }) => {
      started.push(options);
      return { ...widget, status: { registration: 'idle', call: 'idle', extension: '101' } };
    }),
  });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ method: init?.method ?? 'GET', path: url.pathname });
      if (url.pathname === '/v1/telephony/phone/token') {
        return Promise.resolve(
          respond({
            token: 'jwt-for-the-web-phone',
            extension: '101',
            expiresAt: '2026-10-18T10:02:00.000Z',
            baseUrl: PHONE.baseUrl,
            sipDomain: null,
          }),
        );
      }
      if (url.pathname === '/v1/telephony/lookup') {
        return Promise.resolve(
          respond({ phone: '+8801712345678', customer: null, openOrders: [], ringBack: null }),
        );
      }
      return Promise.resolve(respond({}));
    }),
  );
  host = document.createElement('div');
  document.body.append(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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

function render(phone: MyPhone): void {
  act(() => {
    root ??= createRoot(host);
    root.render(
      <LocaleProvider>
        <QueryClientProvider client={queryClient}>
          <Dock phone={phone} />
        </QueryClientProvider>
      </LocaleProvider>,
    );
  });
}

const fire = async (type: EnvoPhoneEvent['type'], detail?: Record<string, unknown>) => {
  act(() => started.at(-1)?.onEvent({ type, ...(detail === undefined ? {} : { detail }) }));
  await settle();
};
const count = (path: string) => requests.filter((entry) => entry.path === path).length;

describe('the console’s phone', () => {
  it('starts Envo’s widget once and keeps it through renders, events and a ringing call', async () => {
    render(PHONE);
    await settle();
    expect(started).toHaveLength(1);
    await fire('ready');
    await fire('registered');
    // The same phone again, as a new object (a refetch, a parent's render): the same widget.
    render({ ...PHONE });
    await settle();
    await fire('incoming', { from: '01712345678', name: '' });
    render({ ...PHONE });
    await settle();
    expect(started).toHaveLength(1);
    expect(widget.destroy).not.toHaveBeenCalled();
    expect(count('/v1/telephony/phone/token')).toBe(1);
    // The ringing card, with Envo's own panel closed behind it.
    expect(widget.close).toHaveBeenCalled();
    expect(host.textContent).toContain('Caller');
    expect(host.textContent).not.toContain('Not a customer');
  });

  it('starts again only for another extension, destroying the widget it let go of', async () => {
    render(PHONE);
    await settle();
    await fire('ready');
    render({ ...PHONE, extension: '102' });
    await settle();
    expect(started).toHaveLength(2);
    expect(widget.destroy).toHaveBeenCalledOnce();
    expect(count('/v1/telephony/phone/token')).toBe(2);
  });

  it('asks who is calling again while a ringing card names nobody', async () => {
    render(PHONE);
    await settle();
    await fire('ready');
    await fire('registered');
    await fire('incoming', { from: '01712345678', name: '' });
    const first = count('/v1/telephony/lookup');
    expect(first).toBeGreaterThanOrEqual(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 2_300));
    });
    await settle();
    expect(count('/v1/telephony/lookup')).toBeGreaterThan(first);
  });
});
