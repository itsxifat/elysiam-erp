import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../i18n/locale.js';
import type * as Parts from './parts.js';

vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));
// The frame needs the router and a session; the page inside it is what is tested here.
vi.mock('../../auth/session.js', () => ({
  useAbility: () => ({
    // `update Catalog` is the delivery zones' ability, which changing the default also needs.
    can: (_action: string, subject: string) =>
      subject === 'Catalog' ? mayUpdate && mayEditZones : mayUpdate,
  }),
}));
vi.mock('./parts.js', async (original) => ({
  ...(await original<typeof Parts>()),
  SettingsPage: ({ children }: { readonly children: ReactNode }) => <>{children}</>,
}));

const { CouriersPage } = await import('./couriers.js');

/**
 * Settings → Couriers made simple (D-913), in a document: "Add courier" offers three choices,
 * step 2 asks only the chosen courier's keys as password fields, Save calls
 * `POST /v1/courier/connections`, and the courier's refusal is shown under the fields. The
 * server is a stubbed `fetch`.
 */

let mayUpdate = true;
let mayEditZones = true;
let root: Root | null = null;
let host: HTMLElement;
let queryClient: QueryClient;
let posted: { path: string; body: unknown }[];
let accounts: unknown[];
/** What `GET /v1/courier/accounts` says of the zones' default beside the items. */
let accountsDefault: Record<string, unknown>;
let connectAnswer: { status: number; body: unknown };

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': status >= 400 ? 'application/problem+json' : 'application/json',
    },
  });
}

const PROVIDERS = [
  {
    code: 'steadfast',
    name: 'Steadfast',
    connect: 'api',
    verified: false,
    enabled: true,
    supportsWebhook: true,
    credentialFields: ['apiKey', 'secretKey'],
  },
  {
    code: 'pathao',
    name: 'Pathao',
    connect: 'api',
    verified: false,
    enabled: false,
    supportsWebhook: true,
    credentialFields: ['clientId', 'clientSecret', 'storeId'],
  },
  {
    code: 'carrybee',
    name: 'Carrybee',
    connect: 'panel',
    verified: false,
    enabled: true,
    supportsWebhook: false,
    credentialFields: [],
  },
  {
    code: 'fake',
    name: 'Fake',
    verified: true,
    enabled: true,
    supportsWebhook: true,
    credentialFields: [],
  },
];

beforeEach(() => {
  mayUpdate = true;
  mayEditZones = true;
  posted = [];
  accounts = [];
  accountsDefault = {};
  connectAnswer = {
    status: 200,
    body: {
      courierId: 'c-1',
      accountId: 'a-1',
      connected: true,
      isDefault: true,
      message: 'Steadfast is connected.',
    },
  };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST') {
        posted.push({
          path: url.pathname,
          body: JSON.parse(typeof init.body === 'string' ? init.body : 'null'),
        });
        if (url.pathname === '/v1/courier/connections') {
          return Promise.resolve(respond(connectAnswer.status, connectAnswer.body));
        }
        return Promise.resolve(respond(200, {}));
      }
      if (url.pathname === '/v1/courier/accounts') {
        return Promise.resolve(respond(200, { items: accounts, ...accountsDefault }));
      }
      if (url.pathname === '/v1/courier/providers') {
        return Promise.resolve(respond(200, { items: PROVIDERS }));
      }
      if (url.pathname === '/v1/delivery-zones') {
        return Promise.resolve(respond(200, { zones: [], couriers: [] }));
      }
      return Promise.resolve(respond(200, {}));
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
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(): Promise<void> {
  act(() => {
    root ??= createRoot(host);
    root.render(
      <LocaleProvider>
        <QueryClientProvider client={queryClient}>
          <CouriersPage />
        </QueryClientProvider>
      </LocaleProvider>,
    );
  });
  await settle();
}

function button(name: string, within: ParentNode = document): HTMLButtonElement {
  const found = [...within.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === name || entry.textContent?.includes(name),
  );
  if (found === undefined) throw new Error(`No button "${name}"`);
  return found;
}

const dialog = () => document.querySelector('[role="dialog"]');

function nth<T>(list: readonly T[], index: number): T {
  const found = list[index];
  if (found === undefined) throw new Error(`Nothing at ${String(index)}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  act(() => target.click());
  await settle();
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    // Through the prototype's setter, as a person typing would, so React sees the change.
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('Settings → Couriers', () => {
  it('starts empty, then connects Steadfast with only its two keys, as the default', async () => {
    await render();
    expect(host.textContent).toContain('No courier yet');

    await click(button('Add courier'));
    const choose = dialog();
    expect(choose?.textContent).toContain('Add a courier');
    const choices = [...(choose?.querySelectorAll<HTMLButtonElement>('li button') ?? [])];
    expect(choices.map((entry) => entry.textContent)).toEqual([
      'SteadfastBooks parcels for you',
      'PathaoSwitched off on this server',
      'CarrybeeBooked in its own panel',
    ]);
    expect(choices.map((entry) => entry.disabled)).toEqual([false, true, false]);

    await click(nth(choices, 0));
    const form = dialog();
    expect(form?.textContent).toContain('Connect Steadfast');
    const inputs = [...(form?.querySelectorAll('input') ?? [])];
    expect(inputs.map((input) => [input.name, input.type, input.value])).toEqual([
      ['apiKey', 'password', ''],
      ['secretKey', 'password', ''],
    ]);
    const toggle = form?.querySelector('[role="switch"]');
    // No courier is the default yet, so the first one starts as the default.
    expect(toggle?.getAttribute('aria-checked')).toBe('true');

    type(nth(inputs, 0), ' the-api-key ');
    type(nth(inputs, 1), 'the-secret');
    accounts = [
      {
        id: 'a-1',
        courierId: 'c-1',
        label: 'Steadfast',
        providerCode: 'steadfast',
        isActive: true,
        verified: false,
        hasCredentials: true,
        name: 'Steadfast',
        isDefault: true,
      },
    ];
    await click(button('Save', form ?? document));

    expect(posted).toEqual([
      {
        path: '/v1/courier/connections',
        body: {
          provider: 'steadfast',
          credentials: { apiKey: 'the-api-key', secretKey: 'the-secret' },
          isDefault: true,
        },
      },
    ]);
    expect(dialog()).toBeNull();
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Steadfast is connected.');
    const row = host.querySelector('li');
    expect(row?.textContent).toContain('Steadfast');
    expect(row?.textContent).toContain('Connected');
    expect(row?.textContent).toContain('Default');
    expect(row?.textContent).toContain('Change keys');
  });

  it('shows the courier’s refusal under the fields and saves nothing', async () => {
    connectAnswer = {
      status: 400,
      body: {
        type: 'about:blank',
        title: 'Steadfast refused the keys',
        status: 400,
        code: 'COURIER_CREDENTIALS_REJECTED',
        detail: 'Steadfast says the API key or secret key is wrong.',
      },
    };
    await render();
    await click(button('Add courier'));
    await click(button('Steadfast', dialog() ?? document));
    const form = dialog();
    const inputs = [...(form?.querySelectorAll('input') ?? [])];
    await click(button('Save', form ?? document));
    // Nothing typed: refused here, before any request.
    expect(posted).toEqual([]);
    expect(form?.querySelector('[role="alert"]')?.textContent).toBe('Type every key.');

    type(nth(inputs, 0), 'wrong');
    type(nth(inputs, 1), 'wrong');
    await click(button('Save', form ?? document));
    expect(posted).toHaveLength(1);
    expect(dialog()).not.toBeNull();
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toMatch(/Steadfast/);
  });

  it('adds Carrybee with no keys and its one plain line', async () => {
    connectAnswer = {
      status: 200,
      body: {
        courierId: 'c-cb',
        accountId: null,
        connected: false,
        isDefault: false,
        message: 'Carrybee is added.',
      },
    };
    await render();
    await click(button('Add courier'));
    await click(button('Carrybee', dialog() ?? document));
    const form = dialog();
    expect(form?.textContent).toContain(
      'Carrybee has no API connection yet: book its parcels in Carrybee’s merchant panel.',
    );
    expect(form?.querySelectorAll('input')).toHaveLength(0);
    act(() => form?.querySelector<HTMLElement>('[role="switch"]')?.click());
    await click(button('Save', form ?? document));
    expect(posted).toEqual([
      {
        path: '/v1/courier/connections',
        body: { provider: 'carrybee', credentials: {}, isDefault: false },
      },
    ]);
    expect(host.querySelector('[role="status"]')?.textContent).toContain('Carrybee is added.');
  });

  it('offers nothing to change to a role without courier settlement access', async () => {
    mayUpdate = false;
    accounts = [
      {
        id: 'a-1',
        courierId: 'c-1',
        label: 'Steadfast',
        providerCode: 'steadfast',
        isActive: true,
        verified: false,
        hasCredentials: true,
        name: 'Steadfast',
        isDefault: false,
      },
    ];
    await render();
    expect(host.textContent).toContain('Changing them needs access to courier settlements.');
    expect([...host.querySelectorAll('button')].map((entry) => entry.textContent)).toEqual([]);
  });

  it('"Make default" sends no keys, and asks for them when the server wants them again', async () => {
    accounts = [
      {
        id: 'a-1',
        courierId: 'c-1',
        label: 'Steadfast',
        providerCode: 'steadfast',
        isActive: true,
        verified: false,
        hasCredentials: true,
        name: 'Steadfast',
        isDefault: false,
      },
    ];
    connectAnswer = {
      status: 400,
      body: { status: 400, code: 'COURIER_ACCOUNT_INVALID', detail: 'Steadfast needs apiKey.' },
    };
    await render();
    await click(button('Make default'));
    expect(posted).toEqual([
      {
        path: '/v1/courier/connections',
        body: { provider: 'steadfast', credentials: {}, isDefault: true },
      },
    ]);
    const form = dialog();
    expect(form?.textContent).toContain('Change Steadfast’s keys');
    expect(form?.querySelector('[role="alert"]')?.textContent).toBe(
      'Type Steadfast’s keys again to make it the default.',
    );
    expect(form?.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('true');
    expect([...(form?.querySelectorAll('input') ?? [])].map((input) => input.value)).toEqual([
      '',
      '',
    ]);
  });

  it('does not start as the default when the own rider is, and says what turning it on replaces', async () => {
    accountsDefault = {
      defaultCourierId: 'own-rider',
      defaultCourierName: 'Own rider',
      zonesMixed: false,
    };
    await render();
    await click(button('Add courier'));
    await click(button('Steadfast', dialog() ?? document));
    const form = dialog();
    const toggle = form?.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(form?.querySelector('[role="note"]')).toBeNull();

    await click(toggle ?? document.body);
    expect(form?.querySelector('[role="note"]')?.textContent).toBe(
      'New orders go to Own rider now. Turning this on gives every delivery zone Steadfast instead.',
    );
  });

  it('does not start as the default when the zones use different couriers, and warns', async () => {
    accountsDefault = { defaultCourierId: null, defaultCourierName: null, zonesMixed: true };
    await render();
    await click(button('Add courier'));
    await click(button('Carrybee', dialog() ?? document));
    const form = dialog();
    const toggle = form?.querySelector<HTMLElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    await click(toggle ?? document.body);
    expect(form?.querySelector('[role="note"]')?.textContent).toBe(
      'Your delivery zones use different couriers now. Turning this on gives every zone Carrybee.',
    );
    await click(button('Save', form ?? document));
    expect(posted).toEqual([
      {
        path: '/v1/courier/connections',
        body: { provider: 'carrybee', credentials: {}, isDefault: true },
      },
    ]);
  });

  it('a role that cannot edit delivery zones connects couriers but never moves the default', async () => {
    mayEditZones = false;
    accounts = [
      {
        id: 'a-1',
        courierId: 'c-1',
        label: 'Steadfast',
        providerCode: 'steadfast',
        isActive: true,
        verified: false,
        hasCredentials: true,
        name: 'Steadfast',
        isDefault: false,
      },
    ];
    await render();
    expect(host.textContent).toContain('Change keys');
    expect(host.textContent).not.toContain('Make default');

    await click(button('Add courier'));
    await click(button('Carrybee', dialog() ?? document));
    const form = dialog();
    const toggle = form?.querySelector<HTMLButtonElement>('[role="switch"]');
    expect(toggle?.getAttribute('aria-checked')).toBe('false');
    expect(toggle?.disabled).toBe(true);
    expect(form?.textContent).toContain(
      'Changing the default courier needs access to delivery zones, which your role does not have.',
    );
  });
});
