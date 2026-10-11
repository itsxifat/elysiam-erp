import { randomUUID } from 'node:crypto';

import { createOTP } from '@better-auth/utils/otp';
import {
  describeUserAgent,
  maskAddress,
  type AccountNameInput,
  type AccountSessionWire,
  type AccountWire,
  type AuthenticatorSetupWire,
  type BackupCodesWire,
  type ConfirmAuthenticatorInput,
  type NewAuthenticatorInput,
  type PasswordChangeInput,
  type PasswordConfirmInput,
} from '@elysium/mother-shared';
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';

import { recordAudit, type Actor } from '../audit/audit.js';
import {
  BACKUP_CODE_COUNT,
  BACKUP_CODE_LENGTH,
  TOTP_DIGITS,
  TOTP_ISSUER,
  TOTP_PERIOD_SECONDS,
  type MotherAuth,
} from '../auth/auth.js';
import { inMother, motherSql } from '../db/client.js';
import { MotherError } from '../http/errors.js';

/**
 * My account (M40, D-701 to D-705): what a signed-in owner may change about themselves.
 *
 * - **Name**, at once.
 * - **Password**: the current one first; other devices signed out if they ask (the default).
 * - **Two-step sign-in**, which is required for everyone and cannot be turned off (D-487):
 *   moved to a new phone (the password and a code held now, then the new phone's first
 *   code), and new recovery codes (the password; shown once).
 * - **Devices**: every session, with this one marked; sign one out, or all the others.
 *
 * The mother does this itself rather than through Better Auth's own routes (closed in
 * `DISABLED_AUTH_PATHS`), so that each change is checked the way it should be and audited
 * in the same transaction. It writes Better Auth's rows the way the library does: the
 * password hashed by its hasher, the TOTP secret and the recovery codes sealed with its
 * secret, so sign-in reads them unchanged.
 *
 * A wrong password or code is audited (`account.check_failed`) and five of them in fifteen
 * minutes stop every check for this person until the window passes (D-705): a stolen
 * session cannot guess its way to a new phone.
 */

/** The library's hasher and sealer, as this auth instance is configured. */
export interface AccountCrypto {
  hashPassword(password: string): Promise<string>;
  verifyPassword(hash: string, password: string): Promise<boolean>;
  seal(data: string): Promise<string>;
  open(data: string): Promise<string>;
}

export async function accountCryptoFrom(auth: MotherAuth): Promise<AccountCrypto> {
  const context = await auth.$context;
  return {
    hashPassword: (password) => context.password.hash(password),
    verifyPassword: (hash, password) => context.password.verify({ hash, password }),
    seal: (data) => symmetricEncrypt({ key: context.secretConfig, data }),
    open: (data) => symmetricDecrypt({ key: context.secretConfig, data }),
  };
}

export const CHECK_FAILED = 'account.check_failed';
export const LOCKOUT_FAILURES = 5;
export const LOCKOUT_MINUTES = 15;
/** How long a new phone's key waits for its first code. */
export const NEW_APP_SECONDS = 10 * 60;

type Step = 'password' | 'new_app' | 'backup_codes';

const newAppIdentifier = (sessionId: string): string => `mother-new-app:${sessionId}`;

function totp(secret: string) {
  return createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS });
}

/** Five wrong answers in fifteen minutes, counted from the audit log, so a restart forgets nothing. */
async function assertNotLockedOut(userId: string): Promise<void> {
  const [row] = await motherSql()<{ count: number }[]>`
    select count(*)::int as count from mother.audit_log
    where actor_user_id = ${userId} and action = ${CHECK_FAILED}
      and occurred_at > now() - make_interval(mins => ${LOCKOUT_MINUTES})
  `;
  if ((row?.count ?? 0) >= LOCKOUT_FAILURES) {
    throw new MotherError(
      'RATE_LIMITED',
      `Too many wrong answers. Wait ${String(LOCKOUT_MINUTES)} minutes and try again.`,
    );
  }
}

/** Audit a wrong answer, outside any transaction (it must outlive the refusal), and refuse. */
async function refuse(actor: Actor, step: Step, failed: 'password' | 'code'): Promise<never> {
  await recordAudit({
    actorUserId: actor.userId,
    action: CHECK_FAILED,
    entityType: 'person',
    entityId: actor.userId,
    detail: { step, failed },
    ipAddress: actor.ipAddress,
    requestId: actor.requestId,
  });
  throw failed === 'password'
    ? new MotherError('INVALID_PASSWORD', 'That password is not right.')
    : new MotherError('INVALID_CODE', 'That code did not work.');
}

async function checkPassword(
  crypto: AccountCrypto,
  actor: Actor,
  password: string,
  step: Step,
): Promise<void> {
  const [row] = await motherSql()<{ password: string | null }[]>`
    select password from auth.accounts
    where user_id = ${actor.userId} and provider_id = 'credential'
  `;
  const stored = row?.password ?? null;
  if (stored === null || !(await crypto.verifyPassword(stored, password))) {
    await refuse(actor, step, 'password');
  }
}

interface FactorRow {
  readonly id: string;
  readonly secret: string;
  readonly backup_codes: string;
}

async function factorOf(userId: string): Promise<FactorRow> {
  const [row] = await motherSql()<FactorRow[]>`
    select id, secret, backup_codes from auth.two_factors
    where user_id = ${userId} and verified
    order by id limit 1
  `;
  if (row === undefined) {
    throw new MotherError('CONFLICT', 'Two-step sign-in is not set up for this account.');
  }
  return row;
}

async function readBackupCodes(crypto: AccountCrypto, sealed: string): Promise<string[] | null> {
  try {
    const parsed = JSON.parse(await crypto.open(sealed)) as unknown;
    return Array.isArray(parsed) && parsed.every((code) => typeof code === 'string')
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Proof of the factor held now: the app's code, or a recovery code, which is used up as
 * signing in with it would (the same compare-and-set on the stored list).
 */
async function checkCurrentCode(
  crypto: AccountCrypto,
  actor: Actor,
  code: string,
  step: Step,
): Promise<'totp' | 'backup_code'> {
  const factor = await factorOf(actor.userId);
  if (/^\d{6}$/.test(code)) {
    if (await totp(await crypto.open(factor.secret)).verify(code)) return 'totp';
    return refuse(actor, step, 'code');
  }
  const codes = await readBackupCodes(crypto, factor.backup_codes);
  if (codes?.includes(code) === true) {
    const left = await crypto.seal(JSON.stringify(codes.filter((entry) => entry !== code)));
    const used = await motherSql()`
      update auth.two_factors set backup_codes = ${left}
      where id = ${factor.id} and backup_codes = ${factor.backup_codes}
      returning id
    `;
    if (used.length === 1) return 'backup_code';
  }
  return refuse(actor, step, 'code');
}

// --- who I am -----------------------------------------------------------------------------

export async function accountOf(crypto: AccountCrypto, userId: string): Promise<AccountWire> {
  const [row] = await motherSql()<
    {
      id: string;
      name: string;
      email: string;
      created_at: Date;
      last_sign_in_at: Date | null;
      two_factor_enabled: boolean;
      password_changed_at: Date | null;
      backup_codes: string | null;
    }[]
  >`
    select u.id, u.name, u.email, u.created_at, u.last_sign_in_at, u.two_factor_enabled,
           (select a.updated_at from auth.accounts a
            where a.user_id = u.id and a.provider_id = 'credential' and a.password is not null
            limit 1) as password_changed_at,
           (select t.backup_codes from auth.two_factors t
            where t.user_id = u.id and t.verified order by t.id limit 1) as backup_codes
    from auth.users u where u.id = ${userId}
  `;
  if (row === undefined) throw new MotherError('NOT_FOUND', 'No such person.');
  const codes = row.backup_codes === null ? null : await readBackupCodes(crypto, row.backup_codes);
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at.toISOString(),
    lastSignInAt: row.last_sign_in_at?.toISOString() ?? null,
    passwordChangedAt: row.password_changed_at?.toISOString() ?? null,
    twoFactor: {
      enabled: row.two_factor_enabled,
      backupCodesLeft: codes?.length ?? null,
      backupCodesIssued: BACKUP_CODE_COUNT,
    },
  };
}

export async function renameSelf(actor: Actor, input: AccountNameInput): Promise<void> {
  await inMother(async (tx) => {
    const [before] = await tx<{ name: string }[]>`
      select name from auth.users where id = ${actor.userId} for update
    `;
    if (before === undefined) throw new MotherError('NOT_FOUND', 'No such person.');
    if (before.name === input.name) return;
    await tx`update auth.users set name = ${input.name}, updated_at = now() where id = ${actor.userId}`;
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'account.name_changed',
        entityType: 'person',
        entityId: actor.userId,
        detail: { from: before.name, to: input.name },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
  });
}

// --- password -----------------------------------------------------------------------------

export async function changePassword(
  crypto: AccountCrypto,
  actor: Actor,
  sessionId: string,
  input: PasswordChangeInput,
): Promise<{ readonly signedOutOtherDevices: number }> {
  await assertNotLockedOut(actor.userId);
  await checkPassword(crypto, actor, input.currentPassword, 'password');
  const hash = await crypto.hashPassword(input.newPassword);
  return inMother(async (tx) => {
    const updated = await tx`
      update auth.accounts set password = ${hash}, updated_at = now()
      where user_id = ${actor.userId} and provider_id = 'credential'
      returning id
    `;
    if (updated.length === 0) {
      throw new MotherError('CONFLICT', 'This account has no password to change.');
    }
    // A password link still open for this person (an invite, the operator's) is void now.
    await tx`
      delete from auth.verifications
      where value = ${actor.userId} and identifier like 'reset-password:%'
    `;
    const ended = input.signOutOtherDevices
      ? await tx`
          delete from auth.sessions where user_id = ${actor.userId} and id <> ${sessionId}
          returning id
        `
      : [];
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'account.password_changed',
        entityType: 'person',
        entityId: actor.userId,
        detail: { otherDevicesSignedOut: ended.length },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
    return { signedOutOtherDevices: ended.length };
  });
}

// --- two-step sign-in ---------------------------------------------------------------------

/**
 * A new phone, step 1 (D-702): the password and a code held now (from the old phone, or a
 * recovery code). The new key waits, bound to this session, until its first code comes
 * back; until then the old phone keeps working, so an abandoned move locks nobody out.
 */
export async function startNewAuthenticator(
  crypto: AccountCrypto,
  actor: Actor,
  sessionId: string,
  input: NewAuthenticatorInput,
): Promise<AuthenticatorSetupWire> {
  await assertNotLockedOut(actor.userId);
  await checkPassword(crypto, actor, input.password, 'new_app');
  const method = await checkCurrentCode(crypto, actor, input.code, 'new_app');
  // The library's own recipe for a TOTP secret (`/two-factor/enable`).
  const secret = generateRandomString(32);
  const sealed = await crypto.seal(secret);
  const identifier = newAppIdentifier(sessionId);
  return inMother(async (tx) => {
    await tx`delete from auth.verifications where identifier = ${identifier}`;
    const [row] = await tx<{ expires_at: Date }[]>`
      insert into auth.verifications (id, identifier, value, expires_at)
      values (${randomUUID()}, ${identifier}, ${sealed},
              now() + make_interval(secs => ${NEW_APP_SECONDS}))
      returning expires_at
    `;
    if (row === undefined) throw new Error('the new key insert returned nothing');
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'account.two_factor.new_app_started',
        entityType: 'person',
        entityId: actor.userId,
        detail: { checkedWith: method },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
    return {
      totpURI: totp(secret).url(TOTP_ISSUER, actor.email),
      expiresAt: row.expires_at.toISOString(),
    };
  });
}

/** Step 2: the new phone's first code. Only then does the new key replace the old one. */
export async function confirmNewAuthenticator(
  crypto: AccountCrypto,
  actor: Actor,
  sessionId: string,
  input: ConfirmAuthenticatorInput,
): Promise<void> {
  const identifier = newAppIdentifier(sessionId);
  const [pending] = await motherSql()<{ value: string }[]>`
    select value from auth.verifications where identifier = ${identifier} and expires_at > now()
  `;
  if (pending === undefined) {
    throw new MotherError(
      'TWO_FACTOR_SETUP_EXPIRED',
      'The new key was not confirmed in time. Start again.',
    );
  }
  if (!(await totp(await crypto.open(pending.value)).verify(input.code))) {
    throw new MotherError('INVALID_CODE', 'That code did not work. Try the newest one.');
  }
  await inMother(async (tx) => {
    const taken = await tx`
      delete from auth.verifications where identifier = ${identifier} and value = ${pending.value}
      returning id
    `;
    if (taken.length === 0) {
      throw new MotherError('TWO_FACTOR_SETUP_EXPIRED', 'The new key was replaced. Start again.');
    }
    const moved = await tx`
      update auth.two_factors
      set secret = ${pending.value}, verified = true, failed_verification_count = 0,
          locked_until = null
      where user_id = ${actor.userId}
      returning id
    `;
    if (moved.length === 0) {
      throw new MotherError('CONFLICT', 'Two-step sign-in is not set up for this account.');
    }
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'account.two_factor.new_app_confirmed',
        entityType: 'person',
        entityId: actor.userId,
        detail: {},
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
  });
}

/** New recovery codes (D-703): the old ones stop working; these are shown once. */
export async function renewBackupCodes(
  crypto: AccountCrypto,
  actor: Actor,
  input: PasswordConfirmInput,
): Promise<BackupCodesWire> {
  await assertNotLockedOut(actor.userId);
  await checkPassword(crypto, actor, input.password, 'backup_codes');
  // The library's own recipe (`generateBackupCodes`): letters and digits, `xxxxx-xxxxx`.
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const raw = generateRandomString(BACKUP_CODE_LENGTH, 'a-z', '0-9', 'A-Z');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const sealed = await crypto.seal(JSON.stringify(codes));
  await inMother(async (tx) => {
    const updated = await tx`
      update auth.two_factors set backup_codes = ${sealed}
      where user_id = ${actor.userId} and verified
      returning id
    `;
    if (updated.length === 0) {
      throw new MotherError('CONFLICT', 'Two-step sign-in is not set up for this account.');
    }
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'account.backup_codes.renewed',
        entityType: 'person',
        entityId: actor.userId,
        detail: { count: codes.length },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
  });
  return { backupCodes: codes };
}

// --- devices ------------------------------------------------------------------------------

export async function listMySessions(
  userId: string,
  currentSessionId: string,
): Promise<AccountSessionWire[]> {
  const rows = await motherSql()<
    {
      id: string;
      user_agent: string | null;
      ip_address: string | null;
      created_at: Date;
      last_active_at: Date;
      expires_at: Date;
    }[]
  >`
    select id, user_agent, ip_address, created_at, last_active_at, expires_at
    from auth.sessions
    where user_id = ${userId} and expires_at > now()
    order by (id = ${currentSessionId}) desc, last_active_at desc, created_at desc
  `;
  return rows.map((row) => {
    const device = describeUserAgent(row.user_agent);
    return {
      id: row.id,
      current: row.id === currentSessionId,
      browser: device.browser,
      os: device.os,
      address: maskAddress(row.ip_address),
      createdAt: row.created_at.toISOString(),
      lastActiveAt: row.last_active_at.toISOString(),
      expiresAt: row.expires_at.toISOString(),
    };
  });
}

export async function signOutSession(
  actor: Actor,
  currentSessionId: string,
  sessionId: string,
): Promise<void> {
  if (sessionId === currentSessionId) {
    throw new MotherError('CONFLICT', 'This is the device you are using: sign out instead.');
  }
  await inMother(async (tx) => {
    const [ended] = await tx<{ user_agent: string | null }[]>`
      delete from auth.sessions where id = ${sessionId} and user_id = ${actor.userId}
      returning user_agent
    `;
    if (ended === undefined) throw new MotherError('NOT_FOUND', 'That device is not signed in.');
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'account.session.signed_out',
        entityType: 'person',
        entityId: actor.userId,
        detail: { sessionId, ...describeUserAgent(ended.user_agent) },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
  });
}

export async function signOutOtherSessions(
  actor: Actor,
  currentSessionId: string,
): Promise<{ readonly signedOut: number }> {
  return inMother(async (tx) => {
    const ended = await tx`
      delete from auth.sessions where user_id = ${actor.userId} and id <> ${currentSessionId}
      returning id
    `;
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'account.sessions.signed_out_others',
        entityType: 'person',
        entityId: actor.userId,
        detail: { count: ended.length },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
    return { signedOut: ended.length };
  });
}
