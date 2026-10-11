import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LocaleProvider } from '../../i18n/locale.js';
import type { AccountView, SessionView } from './api.js';

vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));

const { SessionProvider } = await import('../../auth/session.js');
const { AccountPage } = await import('./account-page.js');
const { TotpQr } = await import('../../auth/totp-qr.js');
const { wouldWall } = await import('../settings/security.js');

/**
 * My account's screen (M40): what it offers a person from what the server says about them, and
 * what it sends. The server is a stubbed `fetch`; every refusal and permission is the server's.
 */

const ORG = '6b0f3a0e-8f0e-4c55-9d0b-2b4a1f2b7c11';

let root: Root | null = null;
let host: HTMLElement;
let requests: { method: string; path: string; body: unknown }[];
let account: AccountView;
let sessions: SessionView[];

function baseAccount(overrides: Partial<AccountView> = {}): AccountView {
  return {
    userId: 'usr_1',
    name: 'Rahima Akter',
    email: 'rahima@example.invalid',
    roles: ['sales'],
    isSuperAdmin: false,
    isOwner: false,
    hasPassword: true,
    lastSignInAt: '2026-10-11T04:00:00.000Z',
    twoFactor: {
      enabled: false,
      enabledAt: null,
      backupCodesLeft: null,
      lockedUntil: null,
      required: false,
      requiredByRoles: [],
      requiredElsewhere: false,
      canTurnOff: false,
      turnOffBlockedBy: null,
    },
    ...overrides,
  };
}

const HERE: SessionView = {
  id: 'here',
  browser: 'Firefox',
  system: 'Linux',
  kind: 'desktop',
  address: '10.2.0.x',
  createdAt: '2026-10-11T04:00:00.000Z',
  lastActiveAt: '2026-10-11T05:00:00.000Z',
  expiresAt: '2026-10-11T16:00:00.000Z',
  current: true,
  ownerLink: false,
};
const PHONE: SessionView = {
  ...HERE,
  id: 'phone',
  browser: 'Chrome',
  system: 'Android',
  kind: 'phone',
  current: false,
};

function respond(body: unknown, status = 200): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  requests = [];
  account = baseAccount();
  sessions = [HERE, PHONE];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: URL | string, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      requests.push({ method, path: url.pathname, body });
      if (url.pathname === '/v1/account') return Promise.resolve(respond(account));
      if (url.pathname === '/v1/account/sessions' && method === 'GET') {
        return Promise.resolve(respond({ items: sessions }));
      }
      if (url.pathname.startsWith('/v1/account/sessions/') && method === 'DELETE') {
        sessions = sessions.filter((entry) => !url.pathname.endsWith(entry.id));
        return Promise.resolve(respond({ sessionId: 'phone', ended: true }));
      }
      return Promise.resolve(respond({ code: 'NOT_FOUND' }, 404));
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
    root = createRoot(host);
    root.render(
      <LocaleProvider>
        <QueryClientProvider client={queryClient}>
          <SessionProvider
            value={{
              orgs: [{ orgId: ORG, slug: 'brand', displayName: 'Brand', roles: ['sales'] }],
              context: {
                userId: 'usr_1',
                orgId: ORG,
                roles: [...account.roles],
                branchIds: [],
                isSuperAdmin: account.isSuperAdmin,
                requestId: 'r',
              },
            }}
          >
            <AccountPage />
          </SessionProvider>
        </QueryClientProvider>
      </LocaleProvider>,
    );
  });
  await settle();
}

const text = () => host.textContent ?? '';
const button = (name: string | RegExp) =>
  [...host.querySelectorAll('button')].find((entry) =>
    typeof name === 'string'
      ? entry.textContent?.trim() === name || entry.getAttribute('aria-label') === name
      : name.test(entry.textContent ?? '') || name.test(entry.getAttribute('aria-label') ?? ''),
  );

describe('two-step sign-in', () => {
  it('offers a sales person without it the set-up, and says it is their choice', async () => {
    await render();
    expect(text()).toContain('My account');
    expect(text()).toContain('Off');
    expect(text()).toContain('No: your choice');
    expect(button('Set up two-step sign-in')).toBeDefined();
    expect(button('Turn off')).toBeUndefined();
  });

  it('shows an admin it is required, with Turn off disabled and the reason beside it', async () => {
    account = baseAccount({
      roles: ['org_admin'],
      twoFactor: {
        enabled: true,
        enabledAt: '2026-10-01T04:00:00.000Z',
        backupCodesLeft: 10,
        lockedUntil: null,
        required: true,
        requiredByRoles: ['org_admin'],
        requiredElsewhere: false,
        canTurnOff: false,
        turnOffBlockedBy: 'role',
      },
    });
    await render();
    expect(text()).toContain('Yes, for your role: Organization admin');
    const off = button('Turn off');
    expect(off?.disabled).toBe(true);
    expect(off?.getAttribute('aria-describedby')).toBe('two-factor-blocked');
    expect(host.querySelector('#two-factor-blocked')?.textContent).toBe(
      'Your role requires it, so it stays on.',
    );
    expect(button('Set up on a new phone')).toBeDefined();
    expect(button('New recovery codes')).toBeDefined();
  });

  it('lets a person whose role does not require it turn it off', async () => {
    account = baseAccount({
      twoFactor: {
        ...baseAccount().twoFactor,
        enabled: true,
        backupCodesLeft: 2,
        canTurnOff: true,
      },
    });
    await render();
    expect(button('Turn off')?.disabled).toBe(false);
    // Few codes left: a nudge to make new ones.
    expect(text()).toContain('Only a few recovery codes are left');
  });
});

describe('devices', () => {
  it('lists this device first, and signs another out with its own labelled button', async () => {
    await render();
    const rows = [...host.querySelectorAll('tbody tr')];
    expect(rows[0]?.textContent).toContain('This device');
    expect(rows[0]?.querySelector('button')).toBeNull();
    const signOut = button('Sign out Chrome on Android');
    expect(signOut).toBeDefined();
    act(() => {
      signOut?.click();
    });
    await settle();
    expect(requests).toContainEqual(
      expect.objectContaining({ method: 'DELETE', path: '/v1/account/sessions/phone' }),
    );
    expect(text()).toContain('That device is signed out.');
  });
});

describe('the password form', () => {
  it('says what is wrong before anything is sent', async () => {
    await render();
    const form = host.querySelector<HTMLInputElement>('#password-new')?.form;
    const set = (id: string, value: string) => {
      const input = host.querySelector<HTMLInputElement>(`#${id}`);
      if (input === null) throw new Error(`no ${id}`);
      // React tracks a controlled input's value through the prototype's setter, so the test
      // sets it there, as a person typing would.
      // eslint-disable-next-line @typescript-eslint/unbound-method -- called with `input` below
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    act(() => {
      set('password-current', 'old-password');
      set('password-new', 'a-new-long-passphrase');
      set('password-confirm', 'something-else-here');
    });
    act(() => {
      form?.requestSubmit();
    });
    expect(text()).toContain('The two new passwords differ.');
    expect(requests.some((entry) => entry.path === '/api/auth/change-password')).toBe(false);
  });
});

describe('the QR code', () => {
  it('draws the address as an image with an accessible name, on the scan tokens', () => {
    act(() => {
      root = createRoot(host);
      root.render(<TotpQr uri="otpauth://totp/Brand:a?secret=JBSWY3DPEHPK3PXP" label="QR code" />);
    });
    const svg = host.querySelector('svg');
    expect(svg?.getAttribute('role')).toBe('img');
    expect(svg?.getAttribute('aria-label')).toBe('QR code');
    expect(svg?.getAttribute('class')).toContain('bg-scan-surface');
    expect(svg?.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
  });
});

describe('Settings → Security', () => {
  it('counts the people a save would wall: only roles switched on now, without a factor', () => {
    const policy = {
      superAdminsAlways: true as const,
      isDefault: true,
      roles: [
        {
          role: 'org_admin' as const,
          required: true,
          byDefault: true,
          members: 2,
          withoutTwoFactor: 1,
        },
        {
          role: 'sales' as const,
          required: false,
          byDefault: false,
          members: 5,
          withoutTwoFactor: 3,
        },
        { role: 'hr' as const, required: false, byDefault: false, members: 1, withoutTwoFactor: 0 },
      ],
    };
    expect(wouldWall(policy, new Set(['org_admin']))).toBe(0);
    expect(wouldWall(policy, new Set(['org_admin', 'sales', 'hr']))).toBe(3);
    expect(wouldWall(policy, new Set([]))).toBe(0);
  });
});
