import {
  HttpException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { withGlobal, withOrg, type Auth } from '@elysium/db';
import type { OwnerLinkClaims, OwnerLinkRefusal } from '@elysium/domain/iam';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { createLogger } from '../../platform/logging/logger.js';
import { AUTH } from './iam.service.js';
import { OWNER_LINK_CONFIG, type OwnerLinkConfig } from './owner-link.config.js';
import { verifyOwnerLink } from './owner-link.verify.js';

/**
 * The owner sign-in link, on the brand's side (M31, D-473).
 *
 * Whoever holds the private key mints a short-lived, single-use assertion; this checks it
 * against the public key in the brand's environment and, when every rule holds, opens a
 * two-hour session for the owner it names. The format and the time and audience rules are
 * shared with the minter (`packages/domain/src/iam/owner-link.ts`); the signature is
 * Ed25519 through `node:crypto`.
 *
 * The order is the design:
 *
 * 1. **Off unless configured.** No public key, no feature: 404, as if there were no route.
 * 2. **Parse, verify, then the rules.** The signature covers the payload's base64url text,
 *    so nothing is re-serialised before it is checked; the audience must be this brand,
 *    the lifetime two minutes at most, the time now.
 * 3. **Single use, then the owner's identity**, in one statement as the owner role
 *    (`iam.accept_owner_link`): the `jti` is recorded (`on conflict do nothing`) and a link
 *    whose `jti` is already there is refused; then the owner is found by the email the link
 *    names, or made — a super admin flagged as an owner, with no password and no
 *    membership. A staff account, a local super admin or a switched-off owner with that
 *    email is never taken over, and such a refusal leaves the `jti` unspent. A link that
 *    fails after this point (the session) is spent, and the owner asks for a new one.
 * 4. **The session**, made inside Better Auth (`auth.api.createOwnerSession`, server-only)
 *    so its row and cookie are a normal sign-in's; then the audit row in the brand's log.
 *
 * Every refusal is the same `401` to the caller. The reason goes to the server's log, so
 * the person who minted the link can be told why, and a prober learns nothing.
 */

export type OwnerLinkFailure =
  OwnerLinkRefusal | 'replayed' | 'identity_conflict' | 'identity_inactive' | 'brand_missing';

class OwnerLinkRefused extends Error {
  constructor(readonly reason: OwnerLinkFailure) {
    super(`owner link refused: ${reason}`);
    this.name = 'OwnerLinkRefused';
  }
}

export interface OwnerSignIn {
  /** The `Set-Cookie` headers of the new session, for the reply. */
  readonly cookies: readonly string[];
  readonly userId: string;
  readonly expiresAt: string;
}

const REFUSED = 'This sign-in link cannot be used. Ask for a new one.';

@Injectable()
export class OwnerLinkService {
  /** The clock a link is judged by; a field so a suite can stand at a fixed time. */
  now: () => number = () => Date.now();

  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('owner-link');
    return this.cachedLogger;
  }

  constructor(
    @Inject(OWNER_LINK_CONFIG) private readonly config: OwnerLinkConfig,
    @Inject(AUTH) private readonly auth: Auth,
    private readonly audit: AuditService,
  ) {}

  /** Whether the feature is on (a key is configured). */
  get enabled(): boolean {
    return this.config.publicKey !== undefined && this.config.audience !== undefined;
  }

  async signIn(token: unknown, request: FastifyRequest): Promise<OwnerSignIn> {
    if (!this.enabled) throw new NotFoundException();
    try {
      return await this.accept(typeof token === 'string' ? token : '', request);
    } catch (error) {
      if (error instanceof OwnerLinkRefused) {
        this.logger.warn({ reason: error.reason }, 'owner sign-in link refused');
        throw new UnauthorizedException(REFUSED);
      }
      if (error instanceof HttpException) throw error;
      // Anything else is ours, not the link's: logged in full, answered as the same refusal.
      this.logger.error({ err: error }, 'owner sign-in link failed');
      throw new UnauthorizedException(REFUSED);
    }
  }

  private async accept(token: string, request: FastifyRequest): Promise<OwnerSignIn> {
    const { publicKey, audience } = this.config;
    if (publicKey === undefined || audience === undefined) throw new NotFoundException();

    const verdict = verifyOwnerLink(token, {
      publicKey,
      audience,
      nowSeconds: Math.floor(this.now() / 1000),
    });
    if (!verdict.ok) throw new OwnerLinkRefused(verdict.reason);
    const claims = verdict.claims;

    const orgId = await this.brandId(audience);
    const userId = await this.spendAndFindOwner(claims);

    const headers = new Headers();
    const userAgent = request.headers['user-agent'];
    if (typeof userAgent === 'string') headers.set('user-agent', userAgent);
    headers.set('x-forwarded-for', request.ip);
    const created = await this.auth.api.createOwnerSession({
      body: { userId, activeOrgId: orgId },
      headers,
      returnHeaders: true,
    });
    const cookies = created.headers?.getSetCookie() ?? [];
    if (cookies.length === 0) throw new Error('the owner session was made without a cookie');

    const requestId = (request as FastifyRequest & { requestId?: string }).requestId ?? null;
    await withOrg({ orgId, userId }, async (tx) => {
      await tx.execute(sql`update iam.users set last_sign_in_at = now() where id = ${userId}`);
      await this.audit.record(tx, {
        orgId,
        actorUserId: userId,
        operation: 'login',
        action: 'auth.owner_link_signed_in',
        entityType: 'User',
        entityId: userId,
        before: null,
        after: { linkId: claims.jti, expiresAt: created.response.expiresAt },
        ip: request.ip,
        userAgent: typeof userAgent === 'string' ? userAgent : null,
        requestId,
        request: request as unknown as AuditableRequest,
      });
    });

    return { cookies, userId, expiresAt: created.response.expiresAt };
  }

  /** The brand the link opens: this deployment's, active and not the training org. */
  private async brandId(audience: string): Promise<string> {
    const [brand] = await withGlobal((tx) =>
      tx.execute<{ id: string }>(sql`
        select id from org.organizations
        where slug = ${audience} and is_active and not is_training
      `),
    );
    if (brand === undefined) throw new OwnerLinkRefused('brand_missing');
    return brand.id;
  }

  /**
   * Spend the link's `jti` and find or make its owner, in one statement as the owner role
   * (`iam.accept_owner_link`, migration 0107): a `jti` already spent is refused, uses older
   * than a day are forgotten, an owner is made on the first link and keeps the minter's
   * name on later ones, and an address belonging to anyone else is never taken over. The
   * application role can neither write the single-use record nor set `is_super_admin` or
   * `is_owner` itself (0015, 0104, 0105). A refusal rolls the whole statement back.
   */
  private async spendAndFindOwner(claims: OwnerLinkClaims): Promise<string> {
    let id: string | null | undefined;
    try {
      const rows = await withGlobal((tx) =>
        tx.execute<{ id: string | null }>(sql`
          select iam.accept_owner_link(${claims.jti}, ${claims.sub}, ${claims.name}) as id
        `),
      );
      id = rows[0]?.id;
    } catch (error) {
      const text = causes(error);
      if (text.includes('OWNER_LINK_REPLAYED')) throw new OwnerLinkRefused('replayed');
      if (text.includes('OWNER_LINK_INVALID')) throw new OwnerLinkRefused('malformed');
      if (text.includes('OWNER_IDENTITY_INACTIVE')) throw new OwnerLinkRefused('identity_inactive');
      if (text.includes('OWNER_IDENTITY_')) throw new OwnerLinkRefused('identity_conflict');
      throw error;
    }
    if (typeof id !== 'string' || id === '') throw new OwnerLinkRefused('identity_conflict');
    return id;
  }
}

/** Every message down an error's causes: a database refusal arrives wrapped by the driver. */
function causes(error: unknown): string {
  const messages: string[] = [];
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    messages.push(cause.message);
  }
  return messages.join(' | ');
}
