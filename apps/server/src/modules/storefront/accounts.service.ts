import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';

import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type {
  accountEmailSchema,
  changePasswordSchema,
  googleSignInSchema,
  registerAccountSchema,
  resetPasswordSchema,
  signInSchema,
  updateAccountSchema,
  verifyEmailSchema,
} from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';
import { normalizeBdPhone } from '@elysium/domain';
import { maskEmail } from '@elysium/domain/notify';
import {
  BCRYPT_COST,
  codeState,
  EMAIL_CODE_TTL_SECONDS,
  normaliseCode,
  normaliseEmail,
  passwordProblem,
  RESET_TOKEN_TTL_SECONDS,
} from '@elysium/domain/storefront';
import { compare, hash } from 'bcryptjs';
import type { Logger } from 'pino';

import { AuditService } from '../../platform/audit/audit.service.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import { createLogger } from '../../platform/logging/logger.js';
import { NOTIFY_API, type NotifyApi } from '../notify/notify.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import * as buying from './buying.repository.js';
import { STOREFRONT_RATE_LIMITER } from './signature.guard.js';
import { STOREFRONT_CONFIG, type StorefrontConfig } from './storefront.config.js';
import { StorefrontError } from './storefront.errors.js';
import { StorefrontService } from './storefront.service.js';
import { codeHash, newCode, newToken, tokenHash } from './tokens.js';

type Client = { readonly ip: string; readonly userAgent?: string | undefined } | undefined;

/**
 * A bcrypt hash of a random string nobody knows, compared against when there is no account, so
 * an unknown address costs a sign-in the same time as a wrong password. Made once, on first use.
 */
let dummyHash: Promise<string> | undefined;
function dummy(): Promise<string> {
  dummyHash ??= hash(newToken(), BCRYPT_COST);
  return dummyHash;
}

/**
 * Shopper accounts (M34, D-522, D-523): sign-up with an email code, sign-in, Google, password
 * resets, the profile, and the account's orders.
 *
 * The website keeps its own session (next-auth) and asks here, signed, server to server; this
 * module never sets a cookie and answers with the account's id and what the website shows.
 *
 * - **Passwords** are bcrypt, cost 12 (the old site's own, so its imported hashes keep
 *   working); at least eight characters for a new one, at most bcrypt's 72 bytes.
 * - **Codes and links are stored hashed** (`tokens.ts`): a six-digit code as an HMAC under the
 *   server's key, five tries and fifteen minutes; a reset link as its SHA-256, one hour, used
 *   once, and every other reset link ends with it.
 * - **Limits per shopper and per address** (D-534): the website's server is one address for
 *   every shopper, so it names the shopper's (`client.ip`) and the limits count that, and the
 *   email, and the website's key as a ceiling.
 * - **Google** (D-522): the website verified Google's ID token; this links or creates only for
 *   an address Google says is verified, and never links Google to an account whose email was
 *   never verified — that account was registered by somebody who may not own the inbox.
 * - **Claiming guest orders** (D-523): when an email is verified (by code, by Google or by a
 *   reset link), the past guest orders that gave that email, or gave no email and the account's
 *   phone, join the account.
 */
@Injectable()
export class AccountsService {
  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('storefront');
    return this.cachedLogger;
  }

  constructor(
    @Inject(STOREFRONT_CONFIG) private readonly config: StorefrontConfig,
    @Inject(STOREFRONT_RATE_LIMITER) private readonly limiter: RateLimitStore,
    @Inject(NOTIFY_API) private readonly notify: NotifyApi,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    private readonly settings: StorefrontService,
    private readonly audit: AuditService,
  ) {}

  // --- sign-up ------------------------------------------------------------------------------------

  async register(orgId: string, input: z.infer<typeof registerAccountSchema>) {
    await this.limitWrites(orgId, input.client);
    const email = this.emailOf(input.email);
    this.assertPassword(input.password);
    const phone = input.phone === undefined ? null : this.phoneOf(input.phone);
    await this.limitCodes(orgId, email);
    const passwordHash = await hash(input.password, BCRYPT_COST);
    // English unless the website names a language; everything is sent in English (D-750).
    const locale = input.locale ?? 'en';

    const outcome = await withOrg({ orgId, userId: 'storefront:account' }, async (tx) => {
      const existing = await buying.accountByEmail(tx, orgId, email, { forUpdate: true });
      if (existing !== undefined && existing.email_verified_at !== null) return 'exists' as const;
      let accountId: string;
      if (existing === undefined) {
        const inserted = await buying.insertAccount(tx, {
          orgId,
          email,
          passwordHash,
          googleSub: null,
          name: input.name,
          phoneE164: phone,
          customerId:
            phone === null ? null : ((await this.orders.buyerIdByPhone(tx, orgId, phone)) ?? null),
          locale,
          source: 'website',
          emailVerifiedAt: null,
        });
        if (inserted === undefined) return 'exists' as const;
        accountId = inserted;
      } else {
        // An unverified sign-up is somebody's claim on an inbox they have not proved: the newest
        // sign-up's password and name stand, and the code goes to the inbox either way.
        await buying.refreshUnverified(tx, {
          orgId,
          id: existing.id,
          passwordHash,
          name: input.name,
          phoneE164: phone,
          locale,
        });
        accountId = existing.id;
      }
      await this.sendEmailCode(tx, orgId, { accountId, email, name: input.name });
      await this.audit.record(tx, {
        orgId,
        actorUserId: 'storefront:account',
        operation: 'create',
        action: 'storefront.account_registered',
        entityType: 'storefront.customer_account',
        entityId: accountId,
        after: { emailMasked: maskEmail(email), ...(phone === null ? {} : { phone }) },
      });
      return { accountId };
    });
    if (outcome === 'exists') {
      throw new StorefrontError(
        'ACCOUNT_EXISTS',
        HttpStatus.CONFLICT,
        'An account with this email already exists. Sign in, or reset the password.',
      );
    }
    return { accountId: outcome.accountId, requiresVerification: true, email };
  }

  async verifyEmail(orgId: string, input: z.infer<typeof verifyEmailSchema>) {
    await this.limitWrites(orgId, input.client);
    const email = this.emailOf(input.email);
    const code = normaliseCode(input.code);
    const master = this.master();
    const now = new Date();

    // The tries are counted in a transaction that commits, and the refusal thrown after it.
    const outcome = await withOrg({ orgId, userId: 'storefront:account' }, async (tx) => {
      const account = await buying.accountByEmail(tx, orgId, email, { forUpdate: true });
      if (account === undefined) return { ok: false as const, reason: 'invalid' };
      if (account.email_verified_at !== null) {
        return { ok: true as const, account: await this.mustView(tx, orgId, account.id) };
      }
      const stored = await buying.latestCode(tx, orgId, account.id, 'verify_email');
      if (stored === undefined) return { ok: false as const, reason: 'invalid' };
      const state = codeState(
        {
          expiresAt: new Date(stored.expires_at),
          attempts: stored.attempts,
          consumedAt: stored.consumed_at === null ? null : new Date(stored.consumed_at),
        },
        now,
      );
      if (state !== 'usable') return { ok: false as const, reason: state };
      const expected = Buffer.from(stored.code_hash, 'hex');
      const given = Buffer.from(
        codeHash(master, { purpose: 'verify_email', accountId: account.id, code: code ?? '' }),
        'hex',
      );
      if (code === null || !timingSafeEqual(expected, given)) {
        await buying.countTry(tx, orgId, stored.id);
        return { ok: false as const, reason: 'wrong' };
      }
      await buying.consumeCode(tx, orgId, stored.id);
      await buying.markVerified(tx, orgId, account.id);
      const claimed = await buying.claimGuestOrders(tx, {
        orgId,
        accountId: account.id,
        email: account.email,
      });
      await this.audit.record(tx, {
        orgId,
        actorUserId: 'storefront:account',
        operation: 'update',
        action: 'storefront.account_verified',
        entityType: 'storefront.customer_account',
        entityId: account.id,
        after: { claimedOrders: claimed },
      });
      return { ok: true as const, account: await this.mustView(tx, orgId, account.id) };
    });
    if (!outcome.ok) {
      throw new StorefrontError(
        'ACCOUNT_CODE_INVALID',
        HttpStatus.BAD_REQUEST,
        outcome.reason === 'locked'
          ? 'Too many wrong tries. Ask for a new code.'
          : outcome.reason === 'expired' || outcome.reason === 'used'
            ? 'That code has expired. Ask for a new one.'
            : 'That code is not right.',
      );
    }
    return { account: outcome.account };
  }

  /** A new code for an unverified account. Always the same answer, so it says nothing (D-522). */
  async resendCode(orgId: string, input: z.infer<typeof accountEmailSchema>) {
    await this.limitWrites(orgId, input.client);
    const email = this.emailOf(input.email);
    await this.limitCodes(orgId, email);
    await withOrg({ orgId, userId: 'storefront:account' }, async (tx) => {
      const account = await buying.accountByEmail(tx, orgId, email, { forUpdate: true });
      if (account?.email_verified_at !== null) return;
      await this.sendEmailCode(tx, orgId, {
        accountId: account.id,
        email,
        name: account.name,
      });
    });
    return { ok: true };
  }

  // --- sign-in ------------------------------------------------------------------------------------

  async signIn(orgId: string, input: z.infer<typeof signInSchema>) {
    const email = this.emailOf(input.email);
    const perTen = this.config.STOREFRONT_SIGN_IN_PER_10_MINUTES;
    await this.limit(`signin:ip:${orgId}:${input.client?.ip ?? 'site'}`, perTen, 600);
    await this.limit(`signin:email:${emailBucket(orgId, email)}`, perTen, 600);

    const account = await withOrg({ orgId, userId: 'storefront:account' }, (tx) =>
      buying.accountByEmail(tx, orgId, email),
    );
    // Compared even when there is nothing to compare, so a missing account costs the same.
    const ok = await compare(input.password, account?.password_hash ?? (await dummy()));
    if (account?.password_hash == null || !ok) {
      throw new StorefrontError(
        'ACCOUNT_CREDENTIALS_INVALID',
        HttpStatus.UNAUTHORIZED,
        'The email or the password is not right.',
      );
    }
    if (account.email_verified_at === null) {
      throw new StorefrontError(
        'ACCOUNT_EMAIL_UNVERIFIED',
        HttpStatus.FORBIDDEN,
        'Verify the email address with the code we sent, then sign in.',
      );
    }
    return withOrg({ orgId, userId: 'storefront:account' }, async (tx) => {
      await buying.touchSignIn(tx, orgId, account.id);
      return { account: await this.mustView(tx, orgId, account.id) };
    });
  }

  async google(
    orgId: string,
    input: z.infer<typeof googleSignInSchema>,
  ): Promise<{
    readonly account: Awaited<ReturnType<AccountsService['viewOf']>>;
    readonly created: boolean;
  }> {
    await this.limitWrites(orgId, input.client);
    const email = this.emailOf(input.email);
    const outcome = await withOrg({ orgId, userId: 'storefront:account' }, async (tx) => {
      const bySub = await buying.accountByGoogleSub(tx, orgId, input.googleSub);
      if (bySub !== undefined) {
        await buying.touchSignIn(tx, orgId, bySub.id);
        return { created: false, accountId: bySub.id };
      }
      const byEmail = await buying.accountByEmail(tx, orgId, email, { forUpdate: true });
      if (byEmail === undefined) {
        const accountId = await buying.insertAccount(tx, {
          orgId,
          email,
          passwordHash: null,
          googleSub: input.googleSub,
          name: (input.name ?? '').trim() || email.slice(0, email.indexOf('@')).slice(0, 120),
          phoneE164: null,
          customerId: null,
          locale: input.locale ?? 'en',
          source: 'google',
          emailVerifiedAt: new Date(),
        });
        if (accountId === undefined) return 'race' as const;
        await buying.claimGuestOrders(tx, { orgId, accountId, email });
        await buying.touchSignIn(tx, orgId, accountId);
        await this.audit.record(tx, {
          orgId,
          actorUserId: 'storefront:account',
          operation: 'create',
          action: 'storefront.account_google_created',
          entityType: 'storefront.customer_account',
          entityId: accountId,
          after: { emailMasked: maskEmail(email) },
        });
        return { created: true, accountId };
      }
      if (byEmail.email_verified_at === null) return 'unverified' as const;
      if (byEmail.google_sub !== null && byEmail.google_sub !== input.googleSub) {
        return 'conflict' as const;
      }
      if (byEmail.google_sub === null) {
        await buying.linkGoogle(tx, orgId, byEmail.id, input.googleSub);
        await this.audit.record(tx, {
          orgId,
          actorUserId: 'storefront:account',
          operation: 'update',
          action: 'storefront.account_google_linked',
          entityType: 'storefront.customer_account',
          entityId: byEmail.id,
          after: { emailMasked: maskEmail(email) },
        });
      }
      await buying.touchSignIn(tx, orgId, byEmail.id);
      return { created: false, accountId: byEmail.id };
    });
    if (outcome === 'race') return this.google(orgId, input);
    if (outcome === 'unverified') {
      throw new StorefrontError(
        'ACCOUNT_EMAIL_UNVERIFIED',
        HttpStatus.CONFLICT,
        'An account with this email is waiting for its email code. Verify it, or reset the password, then sign in with Google.',
      );
    }
    if (outcome === 'conflict') {
      throw new StorefrontError(
        'ACCOUNT_GOOGLE_CONFLICT',
        HttpStatus.CONFLICT,
        'This email’s account is linked to a different Google login.',
      );
    }
    const account = await withOrg({ orgId }, (tx) => this.viewOf(tx, orgId, outcome.accountId));
    return { account, created: outcome.created };
  }

  // --- passwords ----------------------------------------------------------------------------------

  /** A reset link to the inbox, if there is an account. Always the same answer (D-522). */
  async forgotPassword(orgId: string, input: z.infer<typeof accountEmailSchema>) {
    await this.limitWrites(orgId, input.client);
    const email = this.emailOf(input.email);
    await this.limitCodes(orgId, email);
    await withOrg({ orgId, userId: 'storefront:account' }, async (tx) => {
      const account = await buying.accountByEmail(tx, orgId, email, { forUpdate: true });
      if (account === undefined) return;
      const token = newToken();
      await buying.issueCode(tx, {
        orgId,
        accountId: account.id,
        purpose: 'reset_password',
        codeHash: tokenHash(token),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_SECONDS * 1000),
      });
      const settings = await this.settings.settingsIn(tx, orgId);
      const site = settings.siteInfo.siteUrl.replace(/\/+$/, '');
      await this.notify.queueEmail(tx, orgId, {
        templateKey: 'account.password_reset',
        to: email,
        values: {
          brand: settings.siteInfo.siteName,
          name: account.name,
          resetUrl: site.startsWith('https://') ? `${site}/auth/reset-password?token=${token}` : '',
        },
        refType: 'storefront.customer_account',
        refId: account.id,
      });
    });
    return { ok: true };
  }

  async resetPassword(orgId: string, input: z.infer<typeof resetPasswordSchema>) {
    await this.limitWrites(orgId, input.client);
    this.assertPassword(input.password);
    const passwordHash = await hash(input.password, BCRYPT_COST);
    const accountId = await withOrg({ orgId, userId: 'storefront:account' }, async (tx) => {
      const stored = await buying.codeByHash(tx, orgId, 'reset_password', tokenHash(input.token));
      if (stored === undefined) return null;
      const state = codeState(
        {
          expiresAt: new Date(stored.expires_at),
          attempts: 0,
          consumedAt: stored.consumed_at === null ? null : new Date(stored.consumed_at),
        },
        new Date(),
      );
      if (state !== 'usable') return null;
      await buying.consumeAll(tx, orgId, stored.account_id, 'reset_password');
      await buying.setPasswordHash(tx, orgId, stored.account_id, passwordHash);
      // The link reached the inbox, which is what an email code proves too.
      await buying.markVerified(tx, orgId, stored.account_id);
      const account = await buying.accountById(tx, orgId, stored.account_id);
      if (account !== undefined) {
        await buying.claimGuestOrders(tx, {
          orgId,
          accountId: account.id,
          email: account.email,
        });
      }
      await this.audit.record(tx, {
        orgId,
        actorUserId: 'storefront:account',
        operation: 'update',
        action: 'storefront.account_password_reset',
        entityType: 'storefront.customer_account',
        entityId: stored.account_id,
      });
      return stored.account_id;
    });
    if (accountId === null) {
      throw new StorefrontError(
        'ACCOUNT_CODE_INVALID',
        HttpStatus.BAD_REQUEST,
        'That reset link has expired or was already used. Ask for a new one.',
      );
    }
    return { accountId };
  }

  async changePassword(
    orgId: string,
    accountId: string,
    input: z.infer<typeof changePasswordSchema>,
  ) {
    this.assertPassword(input.newPassword);
    await this.limit(`change:${orgId}:${accountId}`, 10, 900);
    const account = await withOrg({ orgId }, (tx) => buying.accountById(tx, orgId, accountId));
    if (account === undefined) throw notFound();
    if (account.password_hash === null) {
      throw new StorefrontError(
        'ACCOUNT_NO_PASSWORD',
        HttpStatus.CONFLICT,
        'This account signs in with Google and has no password to change.',
      );
    }
    if (!(await compare(input.currentPassword, account.password_hash))) {
      throw new StorefrontError(
        'ACCOUNT_CREDENTIALS_INVALID',
        HttpStatus.UNAUTHORIZED,
        'The current password is not right.',
      );
    }
    const passwordHash = await hash(input.newPassword, BCRYPT_COST);
    await withOrg({ orgId, userId: 'storefront:account' }, async (tx) => {
      await buying.setPasswordHash(tx, orgId, accountId, passwordHash);
      await buying.consumeAll(tx, orgId, accountId, 'reset_password');
      await this.audit.record(tx, {
        orgId,
        actorUserId: 'storefront:account',
        operation: 'update',
        action: 'storefront.account_password_changed',
        entityType: 'storefront.customer_account',
        entityId: accountId,
      });
    });
    return { ok: true };
  }

  // --- the profile --------------------------------------------------------------------------------

  async profile(orgId: string, accountId: string) {
    const account = await withOrg({ orgId }, (tx) => this.viewOf(tx, orgId, accountId));
    if (account === undefined) throw notFound();
    return { account };
  }

  async updateProfile(
    orgId: string,
    accountId: string,
    input: z.infer<typeof updateAccountSchema>,
  ) {
    const phone =
      input.phone === undefined
        ? undefined
        : input.phone === null
          ? null
          : this.phoneOf(input.phone);
    return withOrg({ orgId, userId: 'storefront:account' }, async (tx) => {
      const account = await buying.accountById(tx, orgId, accountId, { forUpdate: true });
      if (account === undefined) throw notFound();
      let addresses: unknown;
      if (input.addresses !== undefined) {
        let defaultSeen = false;
        const checked = [];
        for (const address of input.addresses) {
          const area = await this.orders.deliveryZoneForArea(
            tx,
            orgId,
            address.districtId,
            address.thanaId,
          );
          if (!area.valid) {
            throw new StorefrontError(
              'VALIDATION_FAILED',
              HttpStatus.BAD_REQUEST,
              'addresses: a thana is not one of its district’s.',
            );
          }
          const isDefault: boolean = address.isDefault === true && !defaultSeen;
          defaultSeen ||= isDefault;
          checked.push({
            id: address.id ?? randomUUID(),
            label: address.label ?? null,
            name: address.name,
            phone: this.phoneOf(address.phone),
            districtId: address.districtId,
            thanaId: address.thanaId,
            area: address.area ?? null,
            addressLine: address.addressLine,
            isDefault,
          });
        }
        addresses = checked;
      }
      // A new phone may name another buyer; the link follows the phone (D-533).
      const customerId =
        phone === undefined || phone === account.phone_e164
          ? undefined
          : phone === null
            ? null
            : ((await this.orders.buyerIdByPhone(tx, orgId, phone)) ?? null);
      await buying.updateProfile(tx, {
        orgId,
        id: accountId,
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(phone === undefined ? {} : { phoneE164: phone }),
        ...(customerId === undefined ? {} : { customerId }),
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        ...(addresses === undefined ? {} : { addresses }),
      });
      return { account: await this.mustView(tx, orgId, accountId) };
    });
  }

  private async mustView(tx: Tx, orgId: string, accountId: string) {
    const view = await this.viewOf(tx, orgId, accountId);
    if (view === undefined) throw notFound();
    return view;
  }

  /** The account as the website shows it: never a hash, never Google's id. */
  async viewOf(tx: Tx, orgId: string, accountId: string) {
    const row = await buying.accountById(tx, orgId, accountId);
    if (row === undefined) return undefined;
    return {
      id: row.id,
      email: row.email,
      emailVerified: row.email_verified_at !== null,
      name: row.name,
      phone: row.phone_e164,
      locale: row.locale,
      hasPassword: row.password_hash !== null,
      googleLinked: row.google_sub !== null,
      addresses: Array.isArray(row.addresses) ? (row.addresses as unknown[]) : [],
      createdAt: new Date(row.created_at).toISOString(),
    };
  }

  // --- the pieces ---------------------------------------------------------------------------------

  private async sendEmailCode(
    tx: Tx,
    orgId: string,
    input: {
      readonly accountId: string;
      readonly email: string;
      readonly name: string;
    },
  ): Promise<void> {
    const code = newCode();
    await buying.issueCode(tx, {
      orgId,
      accountId: input.accountId,
      purpose: 'verify_email',
      codeHash: codeHash(this.master(), {
        purpose: 'verify_email',
        accountId: input.accountId,
        code,
      }),
      expiresAt: new Date(Date.now() + EMAIL_CODE_TTL_SECONDS * 1000),
    });
    const settings = await this.settings.settingsIn(tx, orgId);
    const queued = await this.notify.queueEmail(tx, orgId, {
      templateKey: 'account.email_code',
      to: input.email,
      values: { brand: settings.siteInfo.siteName, name: input.name, code },
      refType: 'storefront.customer_account',
      refId: input.accountId,
    });
    if (queued.state === 'skipped') {
      this.logger.warn(
        { reason: queued.reason, to: maskEmail(input.email) },
        'an email code could not be sent: the brand has no email server switched on',
      );
    }
  }

  private master(): string {
    const master = this.config.INTAKE_KEY_SECRET;
    if (master === undefined) {
      throw new StorefrontError(
        'SERVICE_UNAVAILABLE',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Accounts are not configured on this server.',
      );
    }
    return master;
  }

  private emailOf(input: string): string {
    const email = normaliseEmail(input);
    if (email === null) {
      throw new StorefrontError(
        'VALIDATION_FAILED',
        HttpStatus.BAD_REQUEST,
        'email: that is not an email address.',
      );
    }
    return email;
  }

  private phoneOf(input: string): string {
    try {
      return normalizeBdPhone(input);
    } catch {
      throw new StorefrontError(
        'ORDER_PHONE_INVALID',
        HttpStatus.BAD_REQUEST,
        'That is not a Bangladeshi mobile number.',
      );
    }
  }

  private assertPassword(password: string): void {
    const problem = passwordProblem(password);
    if (problem === null) return;
    throw new StorefrontError(
      'VALIDATION_FAILED',
      HttpStatus.BAD_REQUEST,
      problem === 'too_short'
        ? 'password: at least eight characters.'
        : 'password: at most 72 bytes.',
    );
  }

  private async limitWrites(orgId: string, client: Client): Promise<void> {
    await this.limit(
      `acct:ip:${orgId}:${client?.ip ?? 'site'}`,
      this.config.STOREFRONT_ACCOUNT_WRITES_PER_15_MINUTES,
      900,
    );
  }

  private async limitCodes(orgId: string, email: string): Promise<void> {
    await this.limit(
      `codes:${emailBucket(orgId, email)}`,
      this.config.STOREFRONT_CODE_SENDS_PER_15_MINUTES,
      900,
    );
  }

  private async limit(bucket: string, perWindow: number, windowSeconds: number): Promise<void> {
    const decision = await this.limiter.hit(`storefront:${bucket}`, perWindow, windowSeconds);
    if (!decision.allowed) {
      throw new StorefrontError(
        'RATE_LIMITED',
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many tries. Wait a few minutes and try again.',
        decision.retryAfterSeconds ?? windowSeconds,
      );
    }
  }
}

/** A counter key for an address that is not the address (invariant 10: Valkey keys are listable). */
function emailBucket(orgId: string, email: string): string {
  return createHash('sha256').update(`${orgId}:${email}`).digest('hex').slice(0, 32);
}

function notFound(): StorefrontError {
  return new StorefrontError('ACCOUNT_NOT_FOUND', HttpStatus.NOT_FOUND, 'No such account.');
}
