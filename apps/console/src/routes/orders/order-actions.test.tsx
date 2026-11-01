import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../i18n/locale.js';
import type { OrderDetail } from './api.js';

vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));

const { OrderActions } = await import('./order-actions.js');

/**
 * The question at Confirm (M52, D-941). The server decides when to ask, so the button answers
 * `ORDER_LOTS_REQUIRED` by asking and sends the confirm again with the answer; a confirm the
 * server takes asks nothing, and any other refusal stays a refusal.
 */

const ORDER = {
  id: '00000000-0000-4000-8000-000000000001',
  orderNo: 'EL-1001',
  assignedTo: null,
  lines: [
    { skuId: 'a', qty: 5 },
    { skuId: 'b', qty: 3 },
  ],
  amounts: { codAmountPoisha: '100000' },
  transitions: [{ trigger: 'confirm' }],
} as unknown as OrderDetail;

let root: Root | null = null;
let host: HTMLElement;
let confirms: unknown[];
let answerFor: (body: { lots?: number }) => { status: number; body: unknown };

function respond(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  confirms = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input), 'http://api.test');
      if (url.pathname.endsWith('/confirm') && init?.method === 'POST') {
        const body = JSON.parse(init.body as string) as { lots?: number };
        confirms.push(body);
        const answer = answerFor(body);
        return Promise.resolve(respond(answer.body, answer.status));
      }
      return Promise.resolve(respond({ items: [] }));
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
  for (let index = 0; index < 8; index += 1) {
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
          <OrderActions order={ORDER} mayUpdate />
        </QueryClientProvider>
      </LocaleProvider>,
    );
  });
  await settle();
}

async function pressConfirm(): Promise<void> {
  const button = [...host.querySelectorAll('button')].find(
    (entry) => entry.textContent === 'Confirm',
  );
  expect(button).toBeDefined();
  await act(async () => {
    button?.click();
    await Promise.resolve();
  });
  await settle();
}

/** Through the input's own setter, so React's controlled value hears the change. */
async function typeLots(input: HTMLInputElement | null, value: string): Promise<void> {
  await act(async () => {
    if (input !== null) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value);
    }
    input?.dispatchEvent(new Event('input', { bubbles: true }));
    await Promise.resolve();
  });
}

const lotsRequired = {
  status: 409,
  body: { code: 'ORDER_LOTS_REQUIRED', message: 'Order EL-1001 has 8 pieces.' },
};

describe('Confirm', () => {
  it('asks nothing when the server takes it', async () => {
    answerFor = () => ({ status: 200, body: { id: ORDER.id } });
    await render();
    await pressConfirm();
    expect(confirms).toEqual([{}]);
    expect(document.querySelector('[data-testid="confirm-lots"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });

  it('asks how many lots above the limit, and confirms again with the answer', async () => {
    answerFor = (body) => (body.lots === undefined ? lotsRequired : { status: 200, body: {} });
    await render();
    await pressConfirm();
    expect(confirms).toEqual([{}]);
    // A question, not a failure, and it says how many pieces and how many lots may be chosen.
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain('How many lots for EL-1001');
    expect(document.body.textContent).toContain('Pieces in this order: 8');
    expect(document.body.textContent).toContain('From 1 to 8');

    const input = document.querySelector<HTMLInputElement>('input[inputmode="numeric"]');
    expect(input?.value).toBe('1');
    await typeLots(input, '3');
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="confirm-lots"]')?.click();
      await Promise.resolve();
    });
    await settle();
    expect(confirms).toEqual([{}, { lots: 3 }]);
    expect(document.querySelector('[data-testid="confirm-lots"]')).toBeNull();
  });

  it('will not send more lots than the order has pieces', async () => {
    answerFor = () => lotsRequired;
    await render();
    await pressConfirm();
    const input = document.querySelector<HTMLInputElement>('input[inputmode="numeric"]');
    await typeLots(input, '9');
    expect(
      document.querySelector<HTMLButtonElement>('[data-testid="confirm-lots"]')?.disabled,
    ).toBe(true);
  });

  it('keeps any other refusal a refusal', async () => {
    answerFor = () => ({
      status: 409,
      body: { code: 'STOCK_INSUFFICIENT', message: 'There is not enough stock.' },
    });
    await render();
    await pressConfirm();
    expect(document.querySelector('[data-testid="confirm-lots"]')).toBeNull();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('not enough stock');
  });
});
