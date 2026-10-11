import { changeOwnPasswordSchema } from '@elysium/contracts';
import type { AccountKey } from '@elysium/i18n';

import { ApiError } from '../../api.js';
import type { AccountView, SessionView } from './api.js';

/**
 * My account's decisions that are not drawing (M40): what to say about two-step sign-in, how to
 * name a device, which refusal maps to which words, and what is wrong with a password form.
 * Pure, so the page's unit tests read them without a browser.
 */

type T = (key: AccountKey, values?: Readonly<Record<string, string>>) => string;

/** "Yes, for your role: Sales" / "Yes: super admins always use it" / "No: your choice". */
export function requirementText(
  view: AccountView,
  t: T,
  roleName: (role: string) => string,
): string {
  if (view.isOwner) return t('account.twoFactor.requiredOwner');
  if (view.isSuperAdmin) return t('account.twoFactor.requiredSuperAdmin');
  if (view.twoFactor.requiredByRoles.length > 0) {
    return t('account.twoFactor.requiredRole', {
      roles: view.twoFactor.requiredByRoles.map(roleName).join(', '),
    });
  }
  if (view.twoFactor.requiredElsewhere) return t('account.twoFactor.requiredElsewhere');
  return t('account.twoFactor.notRequired');
}

/** Why "Turn off" is disabled, or null when it is not. */
const BLOCKED: Readonly<Record<'role' | 'super_admin' | 'owner', AccountKey>> = {
  role: 'account.twoFactor.blockedRole',
  super_admin: 'account.twoFactor.blockedSuperAdmin',
  owner: 'account.twoFactor.blockedOwner',
};

export function turnOffBlockedText(view: AccountView, t: T): string | null {
  const blockedBy = view.twoFactor.turnOffBlockedBy;
  return blockedBy === null ? null : t(BLOCKED[blockedBy]);
}

/** Three or fewer recovery codes left is worth a nudge. */
export function codesRunningLow(left: number | null): boolean {
  return left !== null && left <= 3;
}

/** "Chrome on Windows", or the kind of device when the browser is not known. */
export function deviceName(session: SessionView, t: T): string {
  if (session.browser !== null && session.system !== null) {
    return t('account.devices.browserOn', { browser: session.browser, system: session.system });
  }
  if (session.browser !== null) return session.browser;
  if (session.system !== null) return session.system;
  return t(`account.devices.kind.${session.kind}`);
}

/** This device first, then the most recently active. */
export function orderSessions(sessions: readonly SessionView[]): SessionView[] {
  return [...sessions].sort(
    (a, b) => Number(b.current) - Number(a.current) || b.lastActiveAt.localeCompare(a.lastActiveAt),
  );
}

/**
 * The words for a refusal. The server's codes are mapped to this section's own strings, so the
 * Bangla page never shows an English detail; anything unexpected reads as "did not work".
 */
/** The server's refusal codes (ours and Better Auth's), and this section's words for each. */
const REFUSALS: Readonly<Record<string, AccountKey>> = {
  ACCOUNT_PASSWORD_INVALID: 'account.error.password',
  INVALID_PASSWORD: 'account.error.password',
  TWO_FACTOR_CODE_INVALID: 'account.error.code',
  INVALID_CODE: 'account.error.code',
  INVALID_TWO_FACTOR_CODE: 'account.error.code',
  TWO_FACTOR_LOCKED: 'account.error.locked',
  TWO_FACTOR_REPLACEMENT_EXPIRED: 'account.error.expired',
  TWO_FACTOR_REQUIRED: 'account.error.required',
};

export function refusalText(cause: unknown, t: T): string {
  if (cause instanceof ApiError) {
    const key =
      cause.code !== null && Object.hasOwn(REFUSALS, cause.code) ? REFUSALS[cause.code] : undefined;
    if (key !== undefined) return t(key);
    if (cause.status === 429) return t('account.error.locked');
  }
  return t('account.error.generic');
}

export interface PasswordForm {
  readonly current: string;
  readonly password: string;
  readonly confirm: string;
  readonly signOutOthers: boolean;
}

/** The first thing wrong with the password form, field by field, from the shared schema. */
export function passwordProblems(
  form: PasswordForm,
  t: T,
): Partial<Record<'current' | 'password' | 'confirm', string>> {
  const parsed = changeOwnPasswordSchema.safeParse(form);
  if (parsed.success) return {};
  const problems: Partial<Record<'current' | 'password' | 'confirm', string>> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (field === 'current') problems.current ??= t('account.password.required');
    else if (field === 'confirm') problems.confirm ??= t('account.password.mismatch');
    else if (field === 'password') {
      problems.password ??=
        form.password.length < 12 || form.password.length > 128
          ? t('account.password.tooShort')
          : t('account.password.same');
    }
  }
  return problems;
}

/** The base32 key an authenticator app takes by hand, out of the `otpauth://` address. */
export function keyFromUri(totpURI: string): string {
  try {
    return new URL(totpURI).searchParams.get('secret') ?? '';
  } catch {
    return '';
  }
}

/** The key in groups of four, which is how people copy one by hand without losing their place. */
export function groupKey(key: string): string {
  return key.replace(/(.{4})(?=.)/g, '$1 ');
}

/** The recovery codes as a file: one per line. */
export function codesFile(codes: readonly string[]): string {
  return `${codes.join('\n')}\n`;
}

/** `<brand>-recovery-codes.txt` when the brand's slug is plain, else `recovery-codes.txt`. */
export function codesFileName(brandSlug: string | null | undefined): string {
  return typeof brandSlug === 'string' && /^[a-z0-9-]+$/.test(brandSlug)
    ? `${brandSlug}-recovery-codes.txt`
    : 'recovery-codes.txt';
}

/** Six digits, from whatever was typed or pasted (spaces and dashes dropped). */
export function digitsOnly(value: string): string {
  return value.replace(/\D/g, '').slice(0, 6);
}
