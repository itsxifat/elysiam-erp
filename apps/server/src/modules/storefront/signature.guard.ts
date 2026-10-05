import {
  HttpStatus,
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { withOrg } from '@elysium/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';

import { IDEMPOTENCY_HEADER } from '../../platform/http/idempotency.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import { createLogger } from '../../platform/logging/logger.js';
import { STOREFRONT_CONFIG, type StorefrontConfig } from './storefront.config.js';
import { notAuthenticated, StorefrontError } from './storefront.errors.js';
import { storefrontRawBodyOf } from './raw-body.js';
import * as repo from './storefront.repository.js';
import {
  deriveStorefrontSecret,
  fingerprint,
  KEY_HEADER,
  orgIdOf,
  SIGNATURE_HEADER,
  storefrontSignatureMatches,
  TIMESTAMP_HEADER,
  timestampFresh,
} from './signature.js';

export const STOREFRONT_RATE_LIMITER = Symbol('STOREFRONT_RATE_LIMITER');

const SITE = Symbol('storefront:site');

export interface StorefrontSite {
  readonly orgId: string;
  readonly siteKeyId: string;
  /** A write's `Idempotency-Key`, as signed; empty when none was sent (M34). */
  readonly idempotencyKey: string;
  /** A write's raw body, as signed (M34); undefined for a read. */
  readonly rawBody: Buffer | undefined;
}

/** The methods the storefront API takes: reads, and M34's signed writes. */
const WRITES: ReadonlySet<string> = new Set(['POST', 'PATCH']);

type WithSite = FastifyRequest & { [SITE]?: StorefrontSite };

/** The brand and key a verified request came from. Only set by the guard below. */
export function storefrontSiteOf(request: FastifyRequest): StorefrontSite {
  const site = (request as WithSite)[SITE];
  if (site === undefined) throw notAuthenticated().toHttp();
  return site;
}

function header(request: FastifyRequest, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * The storefront API's authentication (M33, D-506), before any handler runs.
 *
 * In this order, and the order is the design (the intake's, M11):
 *
 * 1. **The source address is rate-limited first**, so a flood costs a counter.
 * 2. **The key, its brand, its state, the clock and the signature.** Every failure here is
 *    the same 401 with the same sentence; the log says which check failed. A key id carries
 *    its brand (`pk_<org id>_…`), so the lookup runs inside that brand's `withOrg()` — no
 *    cross-org read, and another brand's key id finds nothing.
 * 3. **The key's own limit**, generous: one website is one key.
 * 4. The key's `last_used_at`, at most every five minutes.
 *
 * Reads (`GET`) sign the method, path and query; writes (`POST`, `PATCH`, M34) sign the
 * `Idempotency-Key` and the raw body bytes as well (`signature.ts`; the bytes are kept by
 * `raw-body.ts`). Anything else is refused here rather than half-verified.
 */
@Injectable()
export class StorefrontSignatureGuard implements CanActivate {
  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('storefront');
    return this.cachedLogger;
  }

  constructor(
    @Inject(STOREFRONT_CONFIG) private readonly config: StorefrontConfig,
    @Inject(STOREFRONT_RATE_LIMITER) private readonly limiter: RateLimitStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const reply = context.switchToHttp().getResponse<FastifyReply>();
    try {
      (request as WithSite)[SITE] = await this.verify(request);
      return true;
    } catch (error) {
      if (error instanceof StorefrontError) {
        if (error.retryAfter !== undefined)
          void reply.header('retry-after', String(error.retryAfter));
        throw error.toHttp();
      }
      throw error;
    }
  }

  private async verify(request: FastifyRequest): Promise<StorefrontSite> {
    await this.limit(`src:${request.ip}`, this.config.STOREFRONT_RATE_SOURCE_IP_PER_MINUTE);

    const master = this.config.INTAKE_KEY_SECRET;
    if (master === undefined) {
      // Fail closed: without the master key no secret can be derived, and a check that
      // could not run must not read as one that passed.
      this.logger.error('storefront refused a request: INTAKE_KEY_SECRET is not configured');
      throw new StorefrontError(
        'SERVICE_UNAVAILABLE',
        HttpStatus.SERVICE_UNAVAILABLE,
        'The storefront API is not configured on this server.',
      );
    }
    const write = WRITES.has(request.method);
    if (request.method !== 'GET' && !write) throw this.refuse('not a read or a write');
    const rawBody = write ? storefrontRawBodyOf(request) : undefined;
    if (write && rawBody === undefined) throw this.refuse('a write with no body to verify');
    const idempotencyKey = write ? header(request, IDEMPOTENCY_HEADER).trim() : '';

    const keyId = header(request, KEY_HEADER);
    const timestamp = header(request, TIMESTAMP_HEADER);
    const signature = header(request, SIGNATURE_HEADER);

    const orgId = orgIdOf(keyId);
    if (orgId === null) throw this.refuse('malformed key id');
    const site = await withOrg({ orgId }, (tx) => repo.siteKeyByKeyId(tx, orgId, keyId));
    if (site === undefined) throw this.refuse('unknown key id');
    if (site.revoked_at !== null) throw this.refuse('revoked key');

    const secret = deriveStorefrontSecret(master, keyId);
    if (fingerprint(secret) !== site.secret_sha256) {
      throw this.refuse('key issued under a different INTAKE_KEY_SECRET');
    }
    if (!timestampFresh(timestamp, new Date(), this.config.STOREFRONT_SIGNATURE_WINDOW_SECONDS)) {
      throw this.refuse('timestamp outside the window');
    }
    if (
      !storefrontSignatureMatches(secret, signature, {
        timestamp,
        method: request.method,
        pathAndQuery: request.url,
        ...(rawBody === undefined ? {} : { idempotencyKey, rawBody }),
      })
    ) {
      throw this.refuse('signature mismatch');
    }

    await this.limit(`key:${site.id}`, this.config.STOREFRONT_RATE_KEY_PER_MINUTE);
    await withOrg({ orgId }, (tx) => repo.touchSiteKey(tx, orgId, site.id));
    return { orgId, siteKeyId: site.id, idempotencyKey, rawBody };
  }

  private refuse(reason: string): StorefrontError {
    this.logger.warn({ reason }, 'storefront request refused');
    return notAuthenticated();
  }

  private async limit(bucket: string, perMinute: number): Promise<void> {
    const decision = await this.limiter.hit(`storefront:${bucket}`, perMinute, 60);
    if (!decision.allowed) {
      throw new StorefrontError(
        'RATE_LIMITED',
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many requests. Wait and try again.',
        decision.retryAfterSeconds ?? 60,
      );
    }
  }
}
