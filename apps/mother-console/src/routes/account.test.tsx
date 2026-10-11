import type { AccountSessionWire, AccountWire } from '@elysium/mother-shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError, endpoints } from '../api.js';
import { LocaleProvider } from '../i18n/locale.js';
import {
  AccountPage,
  accountErrorKey,
  deviceLabel,
  NewPhoneDialog,
  RecoveryCodesDialog,
} from './account.js';

/**
 * My account (M40, D-701 to D-705): what the screen offers and what it sends. The server's
 * rules are tested in `http.db.test.ts`; these pin the screen: two-step sign-in shown as
 * required with no way to turn it off, this device marked and never offered a sign-out,
 * the password checked before it is sent, and the codes shown once behind a "saved" tick.
 */

const ACCOUNT: AccountWire = {
  id: 'own_1',
  name: 'Owner A',
  email: 'owner.a@example.com',
  createdAt: '2026-10-01T04:00:00.000Z',
  lastSignInAt: '2026-10-11T04:00:00.000Z',
  passwordChangedAt: '2026-10-02T04:00:00.000Z',
  twoFactor: { enabled: true, backupCodesLeft: 7, backupCodesIssued: 10 },
};

const SESSIONS: AccountSessionWire[] = [
  {
    id: 'sess_here',
    current: true,
    browser: 'Chrome',
    os: 'Windows',
    address: '103.129.*.*',
    createdAt: '2026-10-11T04:00:00.000Z',
    lastActiveAt: '2026-10-11T05:00:00.000Z',
    expiresAt: '2026-10-11T12:00:00.000Z',
  },
  {
    id: 'sess_phone',
    current: false,
    browser: 'Safari',
    os: 'iPhone',
    address: '37.111.*.*',
    createdAt: '2026-10-11T03:00:00.000Z',
    lastActiveAt: '2026-10-11T03:30:00.000Z',
    expiresAt: '2026-10-11T11:00:00.000Z',
  },
];

function wrap(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <LocaleProvider>
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </LocaleProvider>,
  );
}

beforeEach(() => {
  vi.spyOn(endpoints, 'account').mockResolvedValue(ACCOUNT);
  vi.spyOn(endpoints, 'sessions').mockResolvedValue({ sessions: SESSIONS });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('My account', () => {
  it('shows two-step sign-in as on and required, with no way to turn it off', async () => {
    wrap(<AccountPage />);
    expect(await screen.findByText(/cannot be turned off/)).toBeTruthy();
    expect(screen.getByText('On')).toBeTruthy();
    expect(screen.getByText('7 of 10')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Set up on a new phone/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /New recovery codes/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /turn off|disable/i })).toBeNull();
  });

  it('marks this device, masks addresses, and offers sign-out only for the others', async () => {
    wrap(<AccountPage />);
    const table = await screen.findByRole('table', { name: 'Devices' });
    const [, here, phone] = within(table).getAllByRole('row');
    if (here === undefined || phone === undefined) throw new Error('expected two device rows');
    expect(within(here).getByText('This device')).toBeTruthy();
    expect(within(here).queryByRole('button')).toBeNull();
    expect(within(table).getByText('103.129.*.*')).toBeTruthy();
    const signOut = within(phone).getByRole('button', {
      name: 'Sign out: Safari · iPhone',
    });
    const ended = vi.spyOn(endpoints, 'signOutSession').mockResolvedValue({ ok: true });
    fireEvent.click(signOut);
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(ended).toHaveBeenCalledWith('sess_phone'));
  });

  it('signs every other device out after a confirmation', async () => {
    wrap(<AccountPage />);
    await screen.findByRole('table', { name: 'Devices' });
    const all = vi.spyOn(endpoints, 'signOutOtherSessions').mockResolvedValue({ signedOut: 1 });
    fireEvent.click(screen.getByRole('button', { name: 'Sign out all other devices' }));
    const dialog = await screen.findByRole('dialog');
    expect(all).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Sign out all other devices' }));
    await waitFor(() => expect(all).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('Your other devices are signed out.')).toBeTruthy();
  });

  it('checks the new password before sending it, and signs other devices out by default', async () => {
    const change = vi
      .spyOn(endpoints, 'changePassword')
      .mockResolvedValue({ signedOutOtherDevices: 1 });
    wrap(<AccountPage />);
    const current = await screen.findByLabelText('Current password');
    const next = screen.getByLabelText('New password');
    const repeat = screen.getByLabelText('Repeat the new password');
    const submit = screen.getByRole('button', { name: 'Change password' });

    fireEvent.change(current, { target: { value: 'old-password-1234' } });
    fireEvent.change(next, { target: { value: 'short' } });
    fireEvent.click(submit);
    expect(await screen.findByText('Use at least 12 characters.')).toBeTruthy();

    fireEvent.change(next, { target: { value: 'a-new-password-1234' } });
    fireEvent.change(repeat, { target: { value: 'a-new-password-12345' } });
    fireEvent.click(submit);
    expect(await screen.findByText('The two passwords differ.')).toBeTruthy();
    expect(change).not.toHaveBeenCalled();

    fireEvent.change(repeat, { target: { value: 'a-new-password-1234' } });
    fireEvent.click(submit);
    await waitFor(() =>
      expect(change).toHaveBeenCalledWith({
        currentPassword: 'old-password-1234',
        newPassword: 'a-new-password-1234',
        signOutOtherDevices: true,
      }),
    );
    expect(
      await screen.findByText('Password changed. Your other devices are signed out.'),
    ).toBeTruthy();
  });

  it('says a wrong current password in plain words', async () => {
    vi.spyOn(endpoints, 'changePassword').mockRejectedValue(
      new ApiError(400, 'INVALID_PASSWORD', 'That password is not right.'),
    );
    wrap(<AccountPage />);
    fireEvent.change(await screen.findByLabelText('Current password'), {
      target: { value: 'wrong-password-123' },
    });
    fireEvent.change(screen.getByLabelText('New password'), {
      target: { value: 'a-new-password-1234' },
    });
    fireEvent.change(screen.getByLabelText('Repeat the new password'), {
      target: { value: 'a-new-password-1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Change password' }));
    expect(await screen.findByText('That password is not right.')).toBeTruthy();
  });

  it('renames me and refreshes the name the shell shows', async () => {
    const rename = vi
      .spyOn(endpoints, 'rename')
      .mockResolvedValue({ ...ACCOUNT, name: 'Owner Dee' });
    wrap(<AccountPage />);
    const save = await screen.findByRole('button', { name: 'Save name' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Owner Dee' } });
    fireEvent.click(save);
    await waitFor(() => expect(rename).toHaveBeenCalledWith('Owner Dee'));
    expect(await screen.findByText('Name saved.')).toBeTruthy();
  });
});

describe('new phone and recovery codes', () => {
  it('moves two-step sign-in in two steps: proof now, then the new phone’s code', async () => {
    const start = vi.spyOn(endpoints, 'startNewApp').mockResolvedValue({
      totpURI:
        'otpauth://totp/Owner%20console:owner.a%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Owner+console',
      expiresAt: '2026-10-11T05:10:00.000Z',
    });
    const confirm = vi.spyOn(endpoints, 'confirmNewApp').mockResolvedValue({ ok: true });
    wrap(<NewPhoneDialog onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Your password'), {
      target: { value: 'my-password-1234' },
    });
    fireEvent.change(screen.getByLabelText('Code from your current app'), {
      target: { value: '123 456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(start).toHaveBeenCalledWith('my-password-1234', '123 456'));
    expect(await screen.findByText('JBSWY3DPEHPK3PXP')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Open in an authenticator app on this device' });
    expect(link.getAttribute('href')).toMatch(/^otpauth:\/\/totp\//);

    fireEvent.change(screen.getByLabelText('Code the new phone shows'), {
      target: { value: '654 321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Switch to the new phone' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith('654321'));
    expect(await screen.findByText(/now uses the new phone/)).toBeTruthy();
  });

  it('goes back to the start when the new key has expired', async () => {
    vi.spyOn(endpoints, 'startNewApp').mockResolvedValue({
      totpURI: 'otpauth://totp/x:y?secret=JBSWY3DPEHPK3PXP',
      expiresAt: '2026-10-11T05:10:00.000Z',
    });
    vi.spyOn(endpoints, 'confirmNewApp').mockRejectedValue(
      new ApiError(409, 'TWO_FACTOR_SETUP_EXPIRED', 'expired'),
    );
    wrap(<NewPhoneDialog onClose={() => undefined} />);
    fireEvent.change(screen.getByLabelText('Your password'), { target: { value: 'p' } });
    fireEvent.change(screen.getByLabelText('Code from your current app'), {
      target: { value: '123456' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.change(await screen.findByLabelText('Code the new phone shows'), {
      target: { value: '654321' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Switch to the new phone' }));
    expect(await screen.findByText(/not confirmed in time/)).toBeTruthy();
    expect(screen.getByLabelText('Your password')).toBeTruthy();
  });

  it('shows new codes once, and closes only once they are saved', async () => {
    const codes = Array.from({ length: 10 }, (_, index) => `abcde-${String(10000 + index)}`);
    vi.spyOn(endpoints, 'renewBackupCodes').mockResolvedValue({ backupCodes: codes });
    const closed = vi.fn();
    wrap(<RecoveryCodesDialog onClose={closed} />);
    fireEvent.change(screen.getByLabelText('Your password'), {
      target: { value: 'my-password-1234' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Make new codes' }));
    const list = await screen.findByRole('list', { name: 'Your new recovery codes' });
    expect(within(list).getAllByRole('listitem').length).toBe(10);
    expect(screen.getByRole('button', { name: 'Print' })).toBeTruthy();
    const done = screen.getByRole('button', { name: 'Done' });
    expect((done as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('I have saved my recovery codes'));
    expect((done as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(done);
    expect(closed).toHaveBeenCalled();
  });
});

describe('account helpers', () => {
  it('words each refusal', () => {
    expect(accountErrorKey(new ApiError(400, 'INVALID_PASSWORD', ''))).toBe(
      'account.error.password',
    );
    expect(accountErrorKey(new ApiError(400, 'INVALID_CODE', ''))).toBe('account.error.code');
    expect(accountErrorKey(new ApiError(429, 'RATE_LIMITED', ''))).toBe('account.error.locked');
    expect(accountErrorKey(new ApiError(409, 'TWO_FACTOR_SETUP_EXPIRED', ''))).toBe(
      'account.error.expired',
    );
    expect(accountErrorKey(new Error('x'))).toBe('common.errorDetail');
  });

  it('names a device, or says it is unknown', () => {
    const t = (key: string) =>
      key === 'account.devices.unknownBrowser' ? 'Unknown browser' : 'unknown system';
    expect(deviceLabel({ browser: 'Chrome', os: 'Windows' }, t)).toBe('Chrome · Windows');
    expect(deviceLabel({ browser: null, os: null }, t)).toBe('Unknown browser · unknown system');
  });
});
