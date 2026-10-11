import { en as accountEn } from '@elysium/i18n/locales/sections/account.en';
import { describe, expect, it, vi } from 'vitest';

import type { AccountView, SessionView } from './api.js';

vi.mock('../../env.js', () => ({ env: { VITE_API_URL: 'http://api.test' } }));

const { ApiError } = await import('../../api.js');
const {
  codesFile,
  codesFileName,
  codesRunningLow,
  deviceName,
  digitsOnly,
  groupKey,
  keyFromUri,
  orderSessions,
  passwordProblems,
  refusalText,
  requirementText,
  turnOffBlockedText,
} = await import('./logic.js');
const { fill } = await import('./messages.js');

/** My account's decisions (M40): what the page says, read against the English strings. */

const t = (key: keyof typeof accountEn, values?: Readonly<Record<string, string>>) =>
  fill(accountEn[key], values ?? {});
const roleName = (role: string) =>
  ({ sales: 'Sales', org_admin: 'Organization admin' })[role] ?? role;

function view(
  overrides: Partial<Omit<AccountView, 'twoFactor'>> & {
    twoFactor?: Partial<AccountView['twoFactor']>;
  } = {},
): AccountView {
  const { twoFactor, ...rest } = overrides;
  return {
    userId: 'usr_1',
    name: 'Rahima',
    email: 'rahima@example.invalid',
    roles: ['sales'],
    isSuperAdmin: false,
    isOwner: false,
    hasPassword: true,
    lastSignInAt: null,
    ...rest,
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
      ...twoFactor,
    },
  };
}

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    id: 's1',
    browser: 'Chrome',
    system: 'Windows',
    kind: 'desktop',
    address: '103.12.45.x',
    createdAt: '2026-10-10T08:00:00.000Z',
    lastActiveAt: '2026-10-11T08:00:00.000Z',
    expiresAt: '2026-10-11T20:00:00.000Z',
    current: false,
    ownerLink: false,
    ...overrides,
  };
}

describe('requirementText', () => {
  it('names the roles that require it, or says it is the person’s choice', () => {
    expect(requirementText(view(), t, roleName)).toBe('No: your choice');
    expect(
      requirementText(
        view({ twoFactor: { required: true, requiredByRoles: ['org_admin', 'sales'] } }),
        t,
        roleName,
      ),
    ).toBe('Yes, for your role: Organization admin, Sales');
    expect(requirementText(view({ isSuperAdmin: true }), t, roleName)).toBe(
      'Yes: super admins always use it',
    );
    expect(requirementText(view({ isOwner: true, isSuperAdmin: true }), t, roleName)).toBe(
      'Your owner sign-in link checks it',
    );
    expect(
      requirementText(
        view({ twoFactor: { required: true, requiredElsewhere: true } }),
        t,
        roleName,
      ),
    ).toBe('Yes, for another of your roles');
  });
});

describe('turnOffBlockedText', () => {
  it('explains a disabled Turn off, and says nothing when it is allowed', () => {
    expect(turnOffBlockedText(view({ twoFactor: { turnOffBlockedBy: 'role' } }), t)).toBe(
      'Your role requires it, so it stays on.',
    );
    expect(turnOffBlockedText(view({ twoFactor: { turnOffBlockedBy: 'super_admin' } }), t)).toMatch(
      /Super admins/,
    );
    expect(turnOffBlockedText(view({ twoFactor: { canTurnOff: true } }), t)).toBeNull();
  });
});

describe('devices', () => {
  it('names a device by browser and system, or by its kind', () => {
    expect(deviceName(session(), t)).toBe('Chrome on Windows');
    expect(deviceName(session({ browser: null, system: 'Android', kind: 'phone' }), t)).toBe(
      'Android',
    );
    expect(deviceName(session({ browser: null, system: null, kind: 'phone' }), t)).toBe('Phone');
  });

  it('puts this device first, then the most recently active', () => {
    const ordered = orderSessions([
      session({ id: 'old', lastActiveAt: '2026-10-01T00:00:00.000Z' }),
      session({ id: 'new', lastActiveAt: '2026-10-11T00:00:00.000Z' }),
      session({ id: 'here', current: true, lastActiveAt: '2026-09-01T00:00:00.000Z' }),
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(['here', 'new', 'old']);
  });
});

describe('refusalText', () => {
  it('maps every refusal the account routes send to the section’s own words', () => {
    const cases: [string, number, string][] = [
      ['ACCOUNT_PASSWORD_INVALID', 400, 'That password is wrong.'],
      ['INVALID_PASSWORD', 400, 'That password is wrong.'],
      ['TWO_FACTOR_CODE_INVALID', 400, accountEn['account.error.code']],
      ['INVALID_CODE', 401, accountEn['account.error.code']],
      ['TWO_FACTOR_LOCKED', 429, accountEn['account.error.locked']],
      ['TWO_FACTOR_REPLACEMENT_EXPIRED', 409, accountEn['account.error.expired']],
      ['TWO_FACTOR_REQUIRED', 409, accountEn['account.error.required']],
      ['RATE_LIMITED', 429, accountEn['account.error.locked']],
    ];
    for (const [code, status, words] of cases) {
      expect(refusalText(new ApiError(status, code, 'detail in English'), t), code).toBe(words);
    }
    expect(refusalText(new Error('boom'), t)).toBe(accountEn['account.error.generic']);
  });
});

describe('passwordProblems', () => {
  const base = {
    current: 'old-password',
    password: 'a-new-long-passphrase',
    confirm: 'a-new-long-passphrase',
    signOutOthers: true,
  };

  it('passes a good form', () => {
    expect(passwordProblems(base, t)).toEqual({});
  });

  it('says what is wrong, field by field', () => {
    expect(passwordProblems({ ...base, current: '' }, t).current).toBe(
      'Enter your current password.',
    );
    expect(passwordProblems({ ...base, password: 'short', confirm: 'short' }, t).password).toBe(
      'Use at least 12 characters.',
    );
    expect(passwordProblems({ ...base, confirm: 'something-else-here' }, t).confirm).toBe(
      'The two new passwords differ.',
    );
    expect(passwordProblems({ ...base, current: base.password }, t).password).toBe(
      'The new password is the same as the current one.',
    );
  });
});

describe('the authenticator key and the recovery codes', () => {
  it('takes the key out of the address and groups it for typing', () => {
    const uri =
      'otpauth://totp/Brand:rahima%40example.invalid?secret=JBSWY3DPEHPK3PXPJBSW&issuer=Brand';
    expect(keyFromUri(uri)).toBe('JBSWY3DPEHPK3PXPJBSW');
    expect(groupKey('JBSWY3DPEHPK3PXP')).toBe('JBSW Y3DP EHPK 3PXP');
    expect(keyFromUri('not a uri')).toBe('');
  });

  it('writes the codes one per line, named after the brand when it can', () => {
    expect(codesFile(['aaaaa-bbbbb', 'ccccc-ddddd'])).toBe('aaaaa-bbbbb\nccccc-ddddd\n');
    expect(codesFileName('elysium-lifestyle-bd')).toBe('elysium-lifestyle-bd-recovery-codes.txt');
    expect(codesFileName('../etc')).toBe('recovery-codes.txt');
    expect(codesFileName(null)).toBe('recovery-codes.txt');
  });

  it('keeps six digits of whatever is typed or pasted', () => {
    expect(digitsOnly('123 456')).toBe('123456');
    expect(digitsOnly('12-34-5678')).toBe('123456');
    expect(digitsOnly('abc')).toBe('');
  });

  it('nudges when three or fewer recovery codes are left', () => {
    expect(codesRunningLow(null)).toBe(false);
    expect(codesRunningLow(4)).toBe(false);
    expect(codesRunningLow(3)).toBe(true);
  });
});
