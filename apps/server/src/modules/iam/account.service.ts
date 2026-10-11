import { HttpException, HttpStatus, Inject, Injectable, NotFoundException } from '@nestjs/common';
import type { ErrorCode, MembershipRole } from '@elysium/contracts';
import {
  newAuthenticatorSecret,
  totpMatchesEncrypted,
  twoFactorStanding,
  withGlobal,
  withOrg,
  type Auth,
  type Tx,
} from '@elysium/db';
import {
  describeUserAgent,
  maskAddress,
  planTurnOffTwoFactor,
  type DeviceKind,
} from '@elysium/domain/iam';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import * as repo from './account.repository.js';
import { AUTH } from './iam.service.js';

/**
 * My account (M40, D-693 to D-695): a person's own name, sessions and second factor.
 *
 * Everything here acts on the caller and nobody else: every statement names the caller's own
 * id, so there is no "whose account" to decide. A change to the second factor asks again for
 * the password and a current code (or a backup code), checked before any transaction opens:
 * Better Auth checks them on its own connection, and a row lock held across that call would
 * wait on itself.
 *
 * Each change is audited in the brand being worked in, in the change's own transaction.
 */

export interface AccountView {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
  /** The person's active roles in this brand. */
  readonly roles: readonly MembershipRole[];
  readonly isSuperAdmin: boolean;
  readonly isOwner: boolean;
  /** Signs in with a password here (an owner arrives by link and has none). */
  readonly hasPassword: boolean;
  readonly lastSignInAt: string | null;
  readonly twoFactor: TwoFactorView;
}

export interface TwoFactorView {
  readonly enabled: boolean;
  /** When it was set up, or moved to a new phone; null when not recorded (before M40). */
  readonly enabledAt: string | null;
  /** Backup codes not used yet; null when it is off, or they could not be counted. */
  readonly backupCodesLeft: number | null;
  /** Locked after too many wrong codes, until then. */
  readonly lockedUntil: string | null;
  /** Something requires it: a super admin, or a role some brand's setting requires it for. */
  readonly required: boolean;
  /** The roles held here that require it. */
  readonly requiredByRoles: readonly MembershipRole[];
  /** A role held in another brand requires it. */
  readonly requiredElsewhere: boolean;
  /** It may be turned off now, by the person themselves. */
  readonly canTurnOff: boolean;
  /** Why not, when it is on and may not be turned off. */
  readonly turnOffBlockedBy: 'super_admin' | 'owner' | 'role' | null;
}

export interface SessionView {
  readonly id: string;
  readonly browser: string | null;
  readonly system: string | null;
  readonly kind: DeviceKind;
  /** The address with its last part hidden (D-695), or null. */
  readonly address: string | null;
  readonly createdAt: string;
  /** Better Auth refreshes a session at most hourly, so this is to the hour. */
  readonly lastActiveAt: string;
  readonly expiresAt: string;
  readonly current: boolean;
  /** Opened by an owner sign-in link (D-473). */
  readonly ownerLink: boolean;
}

function refusal(status: number, code: ErrorCode, message: string): HttpException {
  return new HttpException({ code, message }, status);
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/** A Better Auth refusal (a wrong password or code), as opposed to a fault. */
function isClientRefusal(error: unknown): boolean {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

const BACKUP_CODE = /^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/;

@Injectable()
export class AccountService {
  constructor(
    @Inject(AUTH) private readonly auth: Auth,
    private readonly audit: AuditService,
  ) {}

  private inOrg<T>(context: ActiveContext, work: (tx: Tx) => Promise<T>): Promise<T> {
    return withOrg(
      { orgId: context.orgId, userId: context.userId, requestId: context.requestId },
      work,
    );
  }

  // --- reading --------------------------------------------------------------------------

  async overview(context: ActiveContext): Promise<AccountView> {
    const row = await this.inOrg(context, (tx) => repo.self(tx, context.userId));
    if (row === undefined) throw new NotFoundException('No such person.');
    const standing = await twoFactorStanding(context.userId);
    const plan = planTurnOffTwoFactor({
      enabled: row.two_factor_enabled,
      isOwner: row.is_owner,
      requirement: standing.requirement,
    });
    const requiredHere = standing.requirement.requiredBy
      .filter((entry) => entry.orgId === context.orgId)
      .map((entry) => entry.role as MembershipRole);

    return {
      userId: row.id,
      name: row.name,
      email: row.email,
      roles: [...context.roles],
      isSuperAdmin: row.is_super_admin,
      isOwner: row.is_owner,
      hasPassword: row.has_password,
      lastSignInAt: iso(row.last_sign_in_at),
      twoFactor: {
        enabled: row.two_factor_enabled,
        enabledAt: iso(row.enabled_at),
        backupCodesLeft: row.two_factor_enabled ? await this.backupCodesLeft(row.id) : null,
        lockedUntil:
          row.locked_until !== null && new Date(row.locked_until).getTime() > Date.now()
            ? iso(row.locked_until)
            : null,
        required: standing.requirement.required || row.is_owner,
        requiredByRoles: [...new Set(requiredHere)],
        requiredElsewhere: standing.requirement.requiredBy.some(
          (entry) => entry.orgId !== context.orgId,
        ),
        canTurnOff: plan.allowed,
        turnOffBlockedBy: plan.allowed || plan.because === 'not_enabled' ? null : plan.because,
      },
    };
  }

  /** How many backup codes are left, counted by Better Auth; the codes never leave it. */
  private async backupCodesLeft(userId: string): Promise<number | null> {
    try {
      const result = await this.auth.api.viewBackupCodes({ body: { userId } });
      return Array.isArray(result.backupCodes) ? result.backupCodes.length : null;
    } catch {
      return null;
    }
  }

  async sessions(context: ActiveContext, currentSessionId: string): Promise<SessionView[]> {
    const rows = await this.inOrg(context, (tx) => repo.liveSessions(tx, context.userId));
    return rows.map((row) => {
      const device = describeUserAgent(row.user_agent);
      return {
        id: row.id,
        browser: device.browser,
        system: device.system,
        kind: device.kind,
        address: maskAddress(row.ip_address),
        createdAt: iso(row.created_at) ?? '',
        lastActiveAt: iso(row.updated_at) ?? '',
        expiresAt: iso(row.expires_at) ?? '',
        current: row.id === currentSessionId,
        ownerLink: row.owner_link,
      };
    });
  }

  // --- profile --------------------------------------------------------------------------

  async updateProfile(
    context: ActiveContext,
    request: AuditableRequest,
    name: string,
  ): Promise<{ name: string }> {
    return this.inOrg(context, async (tx) => {
      await repo.lockSelf(tx, context.userId);
      const before = await repo.self(tx, context.userId);
      if (before === undefined) throw new NotFoundException('No such person.');
      await repo.setName(tx, context.userId, name);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'account.profile_updated',
        entityType: 'User',
        entityId: context.userId,
        before: { name: before.name },
        after: { name },
        requestId: context.requestId,
        request,
      });
      return { name };
    });
  }

  // --- devices --------------------------------------------------------------------------

  /** Sign one of your other devices out. This device signs out with Sign out (D-695). */
  async endSession(
    context: ActiveContext,
    request: AuditableRequest,
    currentSessionId: string,
    sessionId: string,
  ): Promise<{ sessionId: string; ended: true }> {
    if (sessionId === currentSessionId) {
      throw refusal(
        HttpStatus.CONFLICT,
        'SESSION_CURRENT',
        'This is the device you are using. Use Sign out to end it.',
      );
    }
    return this.inOrg(context, async (tx) => {
      const ended = await repo.endSession(tx, context.userId, sessionId);
      if (!ended) {
        throw refusal(
          HttpStatus.NOT_FOUND,
          'SESSION_NOT_FOUND',
          'That device is not signed in any more.',
        );
      }
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'account.session_ended',
        entityType: 'User',
        entityId: context.userId,
        before: { sessionId },
        after: null,
        requestId: context.requestId,
        request,
      });
      return { sessionId, ended: true as const };
    });
  }

  /** Sign out every device but this one. */
  async endOtherSessions(
    context: ActiveContext,
    request: AuditableRequest,
    currentSessionId: string,
  ): Promise<{ sessionsEnded: number }> {
    return this.inOrg(context, async (tx) => {
      const sessionsEnded = await repo.endOtherSessions(tx, context.userId, currentSessionId);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'delete',
        action: 'account.other_sessions_ended',
        entityType: 'User',
        entityId: context.userId,
        before: null,
        after: { sessionsEnded },
        requestId: context.requestId,
        request,
      });
      return { sessionsEnded };
    });
  }

  // --- the second factor ----------------------------------------------------------------

  /**
   * Set up on a new phone, step one (D-694): with the password and a current code, a new
   * secret is made and waits ten minutes for a code from the new phone. Nothing changes yet:
   * the old phone keeps working until `confirmReplacement`.
   */
  async startReplacement(
    context: ActiveContext,
    request: AuditableRequest,
    cookie: string,
    input: { password: string; code: string },
  ): Promise<{ totpURI: string; expiresInMinutes: number }> {
    await this.confirmPassword(cookie, input.password);
    await this.confirmCode(context.userId, cookie, input.code);

    return this.inOrg(context, async (tx) => {
      await repo.lockSelf(tx, context.userId);
      const me = await repo.self(tx, context.userId);
      const factor = await repo.verifiedFactor(tx, context.userId);
      if (me === undefined || factor === undefined) throw this.notEnabled();
      const pending = await newAuthenticatorSecret(this.auth, me.email);
      await repo.savePendingSecret(tx, context.userId, pending.encryptedSecret);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'account.two_factor_replacement_started',
        entityType: 'User',
        entityId: context.userId,
        before: null,
        after: { expiresInMinutes: repo.REPLACEMENT_MINUTES },
        requestId: context.requestId,
        request,
      });
      return { totpURI: pending.totpURI, expiresInMinutes: repo.REPLACEMENT_MINUTES };
    });
  }

  /**
   * Set up on a new phone, step two: a code from the new phone replaces the old secret. The
   * backup codes stay as they were; remembered devices are forgotten.
   */
  async confirmReplacement(
    context: ActiveContext,
    request: AuditableRequest,
    code: string,
  ): Promise<{ replaced: true }> {
    return this.inOrg(context, async (tx) => {
      await repo.lockSelf(tx, context.userId);
      const pending = await repo.pendingSecret(tx, context.userId);
      if (pending === undefined) {
        throw refusal(
          HttpStatus.CONFLICT,
          'TWO_FACTOR_REPLACEMENT_EXPIRED',
          'Setting up the new phone took longer than ten minutes, or was not started. Start again.',
        );
      }
      const factor = await repo.verifiedFactor(tx, context.userId);
      if (factor === undefined) throw this.notEnabled();
      if (!(await totpMatchesEncrypted(this.auth, pending, code.trim()))) {
        throw refusal(
          HttpStatus.BAD_REQUEST,
          'TWO_FACTOR_CODE_INVALID',
          'That code is not the one the new phone shows now. Try the next one.',
        );
      }
      await repo.replaceSecret(tx, factor.id, pending);
      await repo.dropPendingSecret(tx, context.userId);
      const devicesForgotten = await repo.forgetDevices(tx, context.userId);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'account.two_factor_replaced',
        entityType: 'User',
        entityId: context.userId,
        before: { twoFactorEnabled: true },
        after: { twoFactorEnabled: true, newSecret: true, devicesForgotten },
        requestId: context.requestId,
        request,
      });
      return { replaced: true as const };
    });
  }

  /**
   * Turn your own two-step sign-in off (D-694): only while nothing requires it — no role in
   * any brand, not a super admin, not an owner — and with the password and a current code.
   * This session stays; remembered devices are forgotten.
   */
  async turnOff(
    context: ActiveContext,
    request: AuditableRequest,
    cookie: string,
    input: { password: string; code: string },
  ): Promise<{ twoFactorEnabled: false }> {
    await this.requireMayTurnOff(context.userId);
    await this.confirmPassword(cookie, input.password);
    await this.confirmCode(context.userId, cookie, input.code);

    return this.inOrg(context, async (tx) => {
      await repo.lockSelf(tx, context.userId);
      if ((await repo.verifiedFactor(tx, context.userId)) === undefined) throw this.notEnabled();
      await repo.removeFactor(tx, context.userId);
      await repo.dropPendingSecret(tx, context.userId);
      const devicesForgotten = await repo.forgetDevices(tx, context.userId);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'account.two_factor_turned_off',
        entityType: 'User',
        entityId: context.userId,
        before: { twoFactorEnabled: true },
        after: { twoFactorEnabled: false, devicesForgotten },
        requestId: context.requestId,
        request,
      });
      return { twoFactorEnabled: false as const };
    });
  }

  private async requireMayTurnOff(userId: string): Promise<void> {
    const standing = await twoFactorStanding(userId);
    const plan = planTurnOffTwoFactor({
      enabled: standing.enabled,
      isOwner: standing.isOwner,
      requirement: standing.requirement,
    });
    if (plan.allowed) return;
    if (plan.because === 'not_enabled') throw this.notEnabled();
    throw refusal(
      HttpStatus.CONFLICT,
      'TWO_FACTOR_REQUIRED',
      plan.because === 'role'
        ? 'Your role requires two-step sign-in, so it stays on. If you lost your phone, ask an admin to reset it.'
        : 'Super admins always use two-step sign-in, so it stays on.',
    );
  }

  private notEnabled(): HttpException {
    return refusal(
      HttpStatus.CONFLICT,
      'TWO_FACTOR_NOT_ENABLED',
      'Two-step sign-in is not on for your account.',
    );
  }

  /** The password, checked by Better Auth against this session's person. */
  private async confirmPassword(cookie: string, password: string): Promise<void> {
    try {
      await this.auth.api.verifyPassword({
        body: { password },
        headers: new Headers({ cookie }),
      });
    } catch (error) {
      if (!isClientRefusal(error)) throw error;
      throw refusal(HttpStatus.BAD_REQUEST, 'ACCOUNT_PASSWORD_INVALID', 'That password is wrong.');
    }
  }

  /**
   * A current code: six digits from the authenticator, checked against the stored secret, or
   * a backup code, which Better Auth checks and uses up. A wrong one counts toward Better
   * Auth's own lockout, the one sign-in uses (`CODE_LOCKOUT`).
   */
  private async confirmCode(userId: string, cookie: string, raw: string): Promise<void> {
    const code = raw.trim();
    const factor = await withGlobal((tx) => repo.verifiedFactor(tx, userId));
    if (factor === undefined) throw this.notEnabled();
    if (factor.locked_until !== null && new Date(factor.locked_until).getTime() > Date.now()) {
      throw refusal(
        HttpStatus.TOO_MANY_REQUESTS,
        'TWO_FACTOR_LOCKED',
        'Too many wrong codes. Wait a quarter of an hour, then try again.',
      );
    }

    let accepted: boolean;
    if (/^\d{6}$/.test(code)) {
      accepted = await totpMatchesEncrypted(this.auth, factor.secret, code);
    } else if (BACKUP_CODE.test(code)) {
      accepted = await this.backupCodeAccepted(cookie, code);
    } else {
      accepted = false;
    }

    await withGlobal(async (tx) => {
      if (accepted) await repo.clearCodeFailures(tx, factor.id);
      else await repo.recordCodeFailure(tx, factor.id);
    });
    if (!accepted) {
      throw refusal(
        HttpStatus.BAD_REQUEST,
        'TWO_FACTOR_CODE_INVALID',
        'That code was not accepted. Enter the code your authenticator shows now, or a backup code.',
      );
    }
  }

  private async backupCodeAccepted(cookie: string, code: string): Promise<boolean> {
    try {
      await this.auth.api.verifyBackupCode({
        body: { code, disableSession: true },
        headers: new Headers({ cookie }),
      });
      return true;
    } catch (error) {
      if (isClientRefusal(error)) return false;
      throw error;
    }
  }
}
