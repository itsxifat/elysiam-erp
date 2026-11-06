import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type * as Ui from '@elysium/ui';

import { LocaleProvider } from '../../i18n/locale.js';

vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));
vi.mock('../../auth/session.js', () => ({
  useAbility: () => ({ can: (action: string, subject: string) => may(action, subject) }),
}));
// The kit's select is Radix, which jsdom cannot open; a native one takes the same props.
vi.mock('@elysium/ui', async (original) => ({
  ...(await original<typeof Ui>()),
  Select: ({
    id,
    value,
    onValueChange,
    options,
  }: {
    readonly id?: string;
    readonly value: string;
    readonly onValueChange: (value: string) => void;
    readonly options: readonly { value: string; label: string }[];
  }) => (
    <select id={id} value={value} onChange={(event) => onValueChange(event.target.value)}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));

const { LocationsPage } = await import('./locations-page.js');

/**
 * The Locations page (D-951), in a document: every location with its kind and whose it is,
 * and the add form moved from Catalog setup, which now offers a branch for a warehouse too.
 * The server is a stubbed `fetch`.
 */

let may: (action: string, subject: string) => boolean;
let root: Root | null = null;
let host: HTMLElement;
let queryClient: QueryClient;
let posted: unknown[];
let locations: unknown[];

const HEAD_OFFICE = { id: '11111111-1111-4111-8111-111111111111', code: 'HQ', name: 'Head Office' };
const GULSHAN = { id: '22222222-2222-4222-8222-222222222222', code: 'GUL', name: 'Gulshan' };

function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  may = () => true;
  posted = [];
  locations = [
    {
      id: 'l-1',
      branchId: HEAD_OFFICE.id,
      code: 'WH-01',
      name: 'Main Warehouse',
      kind: 'warehouse',
      isActive: true,
    },
    { id: 'l-2', branchId: null, code: 'DMG', name: 'Damaged', kind: 'damaged', isActive: false },
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      if (init?.method === 'POST' && url.pathname === '/v1/inventory/locations') {
        posted.push(JSON.parse(typeof init.body === 'string' ? init.body : 'null'));
        return Promise.resolve(respond(201, { id: 'l-new' }));
      }
      if (url.pathname === '/v1/inventory/locations') {
        return Promise.resolve(respond(200, { items: locations }));
      }
      if (url.pathname === '/v1/hr/branch-options') {
        return Promise.resolve(respond(200, { items: [HEAD_OFFICE, GULSHAN] }));
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
          <LocationsPage />
        </QueryClientProvider>
      </LocaleProvider>,
    );
  });
  await settle();
}

/** The control a visible label names. */
function field<T extends HTMLElement>(label: string): T {
  const found = [...host.querySelectorAll('label')].find(
    (entry) => entry.textContent?.trim() === label,
  );
  const control = found === undefined ? null : document.getElementById(found.htmlFor);
  if (control === null) throw new Error(`No field "${label}"`);
  return control as T;
}

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    Reflect.set(HTMLInputElement.prototype, 'value', value, input);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function choose(select: HTMLSelectElement, value: string): void {
  act(() => {
    Reflect.set(HTMLSelectElement.prototype, 'value', value, select);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function add(): Promise<void> {
  const button = [...host.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === 'Add location',
  );
  if (button === undefined) throw new Error('No "Add location" button');
  expect(button.disabled).toBe(false);
  act(() => button.click());
  await settle();
}

const rows = () => [...host.querySelectorAll('li')].map((row) => row.textContent ?? '');
const options = (select: HTMLSelectElement) =>
  [...select.options].map((option) => option.textContent);

describe('the Locations page', () => {
  it('lists every location with its code, kind and whose it is', async () => {
    await render();
    expect(host.querySelector('h1')?.textContent).toBe('Locations');
    const [warehouse, damaged] = rows();
    expect(warehouse).toContain('Main Warehouse');
    expect(warehouse).toContain('WH-01');
    expect(warehouse).toContain('Warehouse');
    expect(warehouse).toContain('Head Office');
    expect(damaged).toContain('Damaged stock');
    expect(damaged).toContain('Whole brand');
    expect(damaged).toContain('Archived');
  });

  it('says there are none yet and still offers the form', async () => {
    locations = [];
    await render();
    expect(host.textContent).toContain('No stock locations yet.');
    expect(host.querySelectorAll('li')).toHaveLength(0);
    expect(field<HTMLInputElement>('Location name')).toBeTruthy();
  });

  it('adds a showroom under the branch chosen, the first one unless another is picked', async () => {
    await render();
    const branch = field<HTMLSelectElement>('Branch');
    expect(options(branch)).toEqual(['Head Office', 'Gulshan']);
    type(field<HTMLInputElement>('Location name'), 'Gulshan showroom');
    choose(branch, GULSHAN.id);
    await add();
    expect(posted).toEqual([
      { code: 'GULSHANSHOWROOM', name: 'Gulshan showroom', kind: 'showroom', branchId: GULSHAN.id },
    ]);
  });

  it('adds a warehouse for the whole brand unless a branch is picked', async () => {
    await render();
    choose(field<HTMLSelectElement>('Kind'), 'warehouse');
    const branch = field<HTMLSelectElement>('Branch');
    expect(options(branch)).toEqual(['No branch: the whole brand', 'Head Office', 'Gulshan']);
    expect(branch.value).toBe('');

    type(field<HTMLInputElement>('Location name'), 'Regional store');
    await add();
    type(field<HTMLInputElement>('Location name'), 'Main warehouse');
    choose(field<HTMLSelectElement>('Branch'), HEAD_OFFICE.id);
    await add();

    expect(posted).toEqual([
      { code: 'REGIONALSTORE', name: 'Regional store', kind: 'warehouse' },
      {
        code: 'MAINWAREHOUSE',
        name: 'Main warehouse',
        kind: 'warehouse',
        branchId: HEAD_OFFICE.id,
      },
    ]);
  });

  it('shows the list but no form to a role that may only read stock', async () => {
    may = (action, subject) => action === 'read' && subject === 'Stock';
    await render();
    expect(rows()).toHaveLength(2);
    expect(host.textContent).not.toContain('Add location');
    expect(host.textContent).not.toContain('Head Office');
  });
});
