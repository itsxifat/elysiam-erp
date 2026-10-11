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
  type FactorProofInput,
  type PasswordChangeInput,
} from '@elysium/mother-shared';
import { generateRandomString, symmetricDecrypt, symmetricEncrypt } from 'better-auth/crypto';
import type { TransactionSql } from 'postgres';

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
 * - **Password**: the current one and a code held now; other devices signed out unless the
 *   owner unticks it.
 * - **Two-step sign-in**, which is required for everyone and cannot be turned off (D-487):
 *   moved to a new phone (the password and a code held now, then the new phone's first
 *   code), and new recovery codes (the password and a code held now; shown once).
 * - **Devices**: every session, with this one marked; sign one out, or all the others.
 *
 * Anything that changes how this person signs in asks for both factors: a stolen session
 * that has learnt the password still cannot take the account (the M40 audit's C1, W3).
 *
 * The mother does this itself rather than through Better Auth's own routes (closed in
 * `DISABLED_AUTH_PATHS`, or walled for an enrolled session), so that each change is checked
 * the way it should be and audited in the same transaction. It writes Better Auth's rows the
 * way the library does: the password hashed by its hasher, the TOTP secret and the recovery
 * codes sealed with its secret, so sign-in reads them unchanged.
 *
 * Every check runs in one transaction under the person's lock (D-705): the lockout count,
 * the password, the code (a recovery code used up there) and the change itself, so parallel
 * guesses queue behind each other and five wrong answers in fifteen minutes are exactly
 * five. A wrong answer is audited (`account.check_failed`) and committed; the change is not.
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
type CodeMethod = 'totp' | 'backup_code';

const NEW_APP_PREFIX = 'mother-new-app:';
const newAppIdentifier = (sessionId: string): string => `${NEW_APP_PREFIX}${sessionId}`;

function totp(secret: string) {
  return createOTP(secret, { digits: TOTP_DIGITS, period: TOTP_PERIOD_SECONDS });
}

/**
 * Forget the new-phone keys waiting on this person's sessions (all of them, or all but
 * one): called before those sessions end, so no key outlives the session it is bound to.
 */
export async function forgetNewAppKeys(
  tx: TransactionSql,
  userId: string,
  keepSessionId?: string,
): Promise<void> {
  await tx`
    delete from auth.verifications
    where identifier in (
      select ${NEW_APP_PREFIX}::text || s.id from auth.sessions s
      where s.user_id = ${userId}
        ${keepSessionId === undefined ? tx`` : tx`and s.id <> ${keepSessionId}`}
    )
  `;
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
 * Is this the factor held now? The app's code, or a recovery code, which is used up inside
 * the caller's transaction (the factor row is locked, so a sign-in using the same code at
 * once waits and then fails its own compare-and-set).
 */
async function matchCurrentCode(
  tx: TransactionSql,
  crypto: AccountCrypto,
  userId: string,
  code: string,
): Promise<CodeMethod | null> {
  const [factor] = await tx<{ id: string; secret: string; backup_codes: string }[]>`
    select id, secret, backup_codes from auth.two_factors
    where user_id = ${userId} and verified
    order by id limit 1
    for update
  `;
  if (factor === undefined) {
    throw new MotherError('CONFLICT', 'Two-step sign-in is not set up for this account.');
  }
  if (/^\d{6}$/.test(code)) {
    return (await totp(await crypto.open(factor.secret)).verify(code)) ? 'totp' : null;
  }
  const codes = await readBackupCodes(crypto, factor.backup_codes);
  if (codes?.includes(code) !== true) return null;
  const left = await crypto.seal(JSON.stringify(codes.filter((entry) => entry !== code)));
  await tx`update auth.two_factors set backup_codes = ${left} where id = ${factor.id}`;
  return 'backup_code';
}

type Outcome<T> =
  | { readonly kind: 'ok'; readonly value: T }
  | { readonly kind: 'locked' }
  | { readonly kind: 'refused'; readonly failed: 'password' | 'code' };

/**
 * Check the password (and, when given, a code held now) and make the change, all in one
 * transaction under this person's lock. A wrong answer commits only its audit row.
 */
async function withProof<T>(
  crypto: AccountCrypto,
  actor: Actor,
  step: Step,
  proof: { readonly password: string; readonly code?: string },
  change: (tx: TransactionSql, checkedWith: CodeMethod | null) => Promise<T>,
): Promise<T> {
  const outcome = await inMother(async (tx): Promise<Outcome<T>> => {
    await tx`
      select pg_advisory_xact_lock(hashtextextended(${`mother.account-check:${actor.userId}`}, 0))
    `;
    const [failures] = await tx<{ count: number }[]>`
      select count(*)::int as count from mother.audit_log
      where actor_user_id = ${actor.userId} and action = ${CHECK_FAILED}
        and occurred_at > now() - make_interval(mins => ${LOCKOUT_MINUTES})
    `;
    if ((failures?.count ?? 0) >= LOCKOUT_FAILURES) return { kind: 'locked' };
    const refused = async (failed: 'password' | 'code'): Promise<Outcome<T>> => {
      await recordAudit(
        {
          actorUserId: actor.userId,
          action: CHECK_FAILED,
          entityType: 'person',
          entityId: actor.userId,
          detail: { step, failed },
          ipAddress: actor.ipAddress,
          requestId: actor.requestId,
        },
        tx,
      );
      return { kind: 'refused', failed };
    };
    const [account] = await tx<{ password: string | null }[]>`
      select password from auth.accounts
      where user_id = ${actor.userId} and provider_id = 'credential'
    `;
    const stored = account?.password ?? null;
    if (stored === null || !(await crypto.verifyPassword(stored, proof.password))) {
      return refused('password');
    }
    let checkedWith: CodeMethod | null = null;
    if (proof.code !== undefined) {
      checkedWith = await matchCurrentCode(tx, crypto, actor.userId, proof.code);
      if (checkedWith === null) return refused('code');
    }
    return { kind: 'ok', value: await change(tx, checkedWith) };
  });
  switch (outcome.kind) {
    case 'ok':
      return outcome.value;
    case 'locked':
      throw new MotherError(
        'RATE_LIMITED',
        `Too many wrong answers. Wait ${String(LOCKOUT_MINUTES)} minutes and try again.`,
      );
    case 'refused':
      throw outcome.failed === 'password'
        ? new MotherError('INVALID_PASSWORD', 'That password is not right.')
        : new MotherError('INVALID_CODE', 'That code did not work.');
  }
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

/** End every other session of this person (and the new-phone keys waiting on them). */
async function endOtherSessions(
  tx: TransactionSql,
  userId: string,
  keepSessionId: string,
): Promise<number> {
  await forgetNewAppKeys(tx, userId, keepSessionId);
  const ended = await tx`
    delete from auth.sessions where user_id = ${userId} and id <> ${keepSessionId}
    returning id
  `;
  return ended.length;
}

// --- password -----------------------------------------------------------------------------

export async function changePassword(
  crypto: AccountCrypto,
  actor: Actor,
  sessionId: string,
  input: PasswordChangeInput,
): Promise<{ readonly signedOutOtherDevices: number }> {
  const hash = await crypto.hashPassword(input.newPassword);
  return withProof(
    crypto,
    actor,
    'password',
    { password: input.currentPassword, code: input.code },
    async (tx, checkedWith) => {
      const updated = await tx`
        update auth.accounts set password = ${hash}, updated_at = now()
        where user_id = ${actor.userId} and provider_id = 'credential'
        returning id
      `;
      if (updated.length === 0) {
        throw new MotherError('CONFLICT', 'This account has no password to change.');
      }
      // A password link still open for this person (an invite, the operator's) is void now,
      // and so is a sign-in that passed the old password and waits for its code.
      await tx`
        delete from auth.verifications
        where value = ${actor.userId}
          and (identifier like 'reset-password:%' or identifier like '2fa-%')
      `;
      const ended = input.signOutOtherDevices
        ? await endOtherSessions(tx, actor.userId, sessionId)
        : 0;
      await recordAudit(
        {
          actorUserId: actor.userId,
          action: 'account.password_changed',
          entityType: 'person',
          entityId: actor.userId,
          detail: { checkedWith, otherDevicesSignedOut: ended },
          ipAddress: actor.ipAddress,
          requestId: actor.requestId,
        },
        tx,
      );
      return { signedOutOtherDevices: ended };
    },
  );
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
  input: FactorProofInput,
): Promise<AuthenticatorSetupWire> {
  // The library's own recipe for a TOTP secret (`/two-factor/enable`).
  const secret = generateRandomString(32);
  const sealed = await crypto.seal(secret);
  const identifier = newAppIdentifier(sessionId);
  return withProof(crypto, actor, 'new_app', input, async (tx, checkedWith) => {
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
        detail: { checkedWith },
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

/**
 * Step 2: the new phone's first code. Only then does the new key replace the old one, and,
 * if the owner asks (a lost or stolen phone), every other session ends with it.
 */
export async function confirmNewAuthenticator(
  crypto: AccountCrypto,
  actor: Actor,
  sessionId: string,
  input: ConfirmAuthenticatorInput,
): Promise<{ readonly signedOutOtherDevices: number }> {
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
  return inMother(async (tx) => {
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
    const ended = input.signOutOtherDevices
      ? await endOtherSessions(tx, actor.userId, sessionId)
      : 0;
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'account.two_factor.new_app_confirmed',
        entityType: 'person',
        entityId: actor.userId,
        detail: { otherDevicesSignedOut: ended },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
    return { signedOutOtherDevices: ended };
  });
}

/**
 * New recovery codes (D-703): the password and a code held now, because the codes are
 * themselves a second factor. The old ones stop working; these are shown once.
 */
export async function renewBackupCodes(
  crypto: AccountCrypto,
  actor: Actor,
  input: FactorProofInput,
): Promise<BackupCodesWire> {
  // The library's own recipe (`generateBackupCodes`): letters and digits, `xxxxx-xxxxx`.
  const codes = Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const raw = generateRandomString(BACKUP_CODE_LENGTH, 'a-z', '0-9', 'A-Z');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
  const sealed = await crypto.seal(JSON.stringify(codes));
  await withProof(crypto, actor, 'backup_codes', input, async (tx, checkedWith) => {
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
        detail: { count: codes.length, checkedWith },
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
    await tx`
      delete from auth.verifications
      where identifier = ${newAppIdentifier(sessionId)}
        and exists (select 1 from auth.sessions
                    where id = ${sessionId} and user_id = ${actor.userId})
    `;
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
    const signedOut = await endOtherSessions(tx, actor.userId, currentSessionId);
    await recordAudit(
      {
        actorUserId: actor.userId,
        action: 'account.sessions.signed_out_others',
        entityType: 'person',
        entityId: actor.userId,
        detail: { count: signedOut },
        ipAddress: actor.ipAddress,
        requestId: actor.requestId,
      },
      tx,
    );
    return { signedOut };
  });
}
