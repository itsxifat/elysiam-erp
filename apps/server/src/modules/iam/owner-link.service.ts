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
 * 3. **Single use.** The `jti` is recorded before anything is created (`on conflict do
 *    nothing`); a link whose `jti` is already there is refused. A link that fails after
 *    this point is spent, and the owner asks for a new one.
 * 4. **The owner's identity.** Found by the email the link names, or made: a super admin
 *    flagged as an owner, with no password and no membership. A staff account, a local
 *    super admin or a switched-off identity with that email is never taken over.
 * 5. **The session**, made inside Better Auth (`auth.api.createOwnerSession`, server-only)
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

    const orgId = await this.recordUseAndFindBrand(claims, audience);
    const userId = await this.ownerIdentity(claims);

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

  /**
   * Spend the link's `jti`, and find the brand it opens. One transaction: a link is spent
   * whether or not the rest succeeds, and a use older than a day is forgotten on the way.
   */
  private async recordUseAndFindBrand(claims: OwnerLinkClaims, audience: string): Promise<string> {
    return withGlobal(async (tx) => {
      const inserted = await tx.execute<{ jti: string }>(sql`
        insert into iam.owner_link_uses (jti) values (${claims.jti})
        on conflict (jti) do nothing
        returning jti
      `);
      if (inserted.length === 0) throw new OwnerLinkRefused('replayed');
      await tx.execute(
        sql`delete from iam.owner_link_uses where used_at < now() - interval '1 day'`,
      );
      const [brand] = await tx.execute<{ id: string }>(sql`
        select id from org.organizations
        where slug = ${audience} and is_active and not is_training
      `);
      if (brand === undefined) throw new OwnerLinkRefused('brand_missing');
      return brand.id;
    });
  }

  /**
   * The owner's identity here, by the link's email: made on the first link, its name kept
   * to the minter's on later ones. Never anyone else's account.
   *
   * Through `iam.ensure_owner_identity` (migration 0104), which runs as the owner role:
   * nothing the application role does may set `is_super_admin` or `is_owner` (0015, 0104),
   * and that function makes an owner only for a link spent in the last few minutes.
   */
  private async ownerIdentity(claims: OwnerLinkClaims): Promise<string> {
    try {
      return await withGlobal(async (tx) => {
        const [row] = await tx.execute<{ id: string }>(sql`
          select iam.ensure_owner_identity(${claims.jti}, ${claims.sub}, ${claims.name}) as id
        `);
        if (row === undefined) throw new OwnerLinkRefused('identity_conflict');
        return row.id;
      });
    } catch (error) {
      const text = String((error as { cause?: unknown }).cause ?? error);
      if (text.includes('OWNER_IDENTITY_INACTIVE')) throw new OwnerLinkRefused('identity_inactive');
      if (text.includes('OWNER_IDENTITY_')) throw new OwnerLinkRefused('identity_conflict');
      throw error;
    }
  }
}
