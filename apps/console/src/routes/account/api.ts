import type { MembershipRole } from '@elysium/contracts';

import { api } from '../../api.js';

/**
 * My account's endpoints (M40), typed to what the server returns. The password and the first
 * set-up go to Better Auth's own endpoints, as sign-in does; the rest are `/v1/account`. A code
 * or a secret is never logged, stored or put in a URL here.
 */

export interface TwoFactorView {
  readonly enabled: boolean;
  readonly enabledAt: string | null;
  readonly backupCodesLeft: number | null;
  readonly lockedUntil: string | null;
  readonly required: boolean;
  readonly requiredByRoles: readonly MembershipRole[];
  readonly requiredElsewhere: boolean;
  readonly canTurnOff: boolean;
  readonly turnOffBlockedBy: 'super_admin' | 'owner' | 'role' | null;
}

export interface AccountView {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  readonly roles: readonly MembershipRole[];
  readonly isSuperAdmin: boolean;
  readonly isOwner: boolean;
  readonly hasPassword: boolean;
  readonly lastSignInAt: string | null;
  readonly twoFactor: TwoFactorView;
}

export type DeviceKind = 'desktop' | 'phone' | 'tablet' | 'unknown';

export interface SessionView {
  readonly id: string;
  readonly browser: string | null;
  readonly system: string | null;
  readonly kind: DeviceKind;
  readonly address: string | null;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly expiresAt: string;
  readonly current: boolean;
  readonly ownerLink: boolean;
}

export interface Enrolment {
  readonly totpURI: string;
  readonly backupCodes: readonly string[];
}

export const ACCOUNT_QUERY_KEY = ['account'] as const;
export const SESSIONS_QUERY_KEY = ['account', 'sessions'] as const;

export const getAccount = () => api.get<AccountView>('/v1/account');
export const updateName = (name: string) =>
  api.patch<{ name: string }>('/v1/account/profile', { name });

export const listSessions = () =>
  api.get<{ items: SessionView[] }>('/v1/account/sessions').then((body) => body.items);
export const endSession = (id: string) =>
  api.delete<{ sessionId: string }>(`/v1/account/sessions/${encodeURIComponent(id)}`);
export const endOtherSessions = () =>
  api.post<{ sessionsEnded: number }>('/v1/account/sessions/sign-out-others');

/** Better Auth's own: the current password, the new one, and whether the others go. */
export const changePassword = (input: {
  readonly currentPassword: string;
  readonly newPassword: string;
  readonly revokeOtherSessions: boolean;
}) => api.post<unknown>('/api/auth/change-password', input);

/** Better Auth's own enrolment: a new secret and ten recovery codes, then a code confirms. */
export const startSetUp = (password: string) =>
  api.post<Enrolment>('/api/auth/two-factor/enable', { password, method: 'totp' });
export const confirmSetUp = (code: string) =>
  api.post<unknown>('/api/auth/two-factor/verify-totp', { code });

/** Ten new recovery codes, with the password and a code from the authenticator (D-694). */
export const newRecoveryCodes = (password: string, code: string) =>
  api.post<{ backupCodes: string[] }>('/v1/account/two-factor/recovery-codes', {
    password,
    code,
  });

export const startNewPhone = (password: string, code: string) =>
  api.post<{ totpURI: string; expiresInMinutes: number }>('/v1/account/two-factor/replace', {
    password,
    code,
  });
export const confirmNewPhone = (code: string) =>
  api.post<{ replaced: true }>('/v1/account/two-factor/replace/confirm', { code });

export const turnOffTwoFactor = (password: string, code: string) =>
  api.post<{ twoFactorEnabled: false }>('/v1/account/two-factor/turn-off', { password, code });
