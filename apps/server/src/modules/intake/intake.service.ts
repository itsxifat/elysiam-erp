import { createHash } from 'node:crypto';

import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { normalizeBdPhone } from '@elysium/domain';
import type { Logger } from 'pino';
import type { FastifyRequest } from 'fastify';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { createLogger } from '../../platform/logging/logger.js';
import { IDEMPOTENCY_HEADER } from '../../platform/http/idempotency.js';
import type { RateLimitStore } from '../../platform/http/rate-limit.js';
import { CATALOG_API, type CatalogApi } from '../catalog/catalog.api.js';
import { ORDERS_API, type OrdersApi } from '../orders/orders.api.js';
import { INTAKE_CONFIG, type IntakeConfig } from './intake.config.js';
import { fromOrdersRefusal, IntakeError, notAuthenticated } from './intake.errors.js';
import * as repo from './intake.repository.js';
import {
  publicOrderSchema,
  type IssueSiteKeyInput,
  type PublicOrderInput,
} from './intake.schemas.js';
import {
  bodyHash,
  deriveSecret,
  fingerprint,
  newKeyId,
  orgIdOf,
  signatureMatches,
  timestampFresh,
} from './signature.js';
import type { TurnstileVerifier } from './turnstile.js';

/** DI tokens for the two collaborators a test replaces. */
export const INTAKE_RATE_LIMITER = Symbol('INTAKE_RATE_LIMITER');
export const TURNSTILE_VERIFIER = Symbol('TURNSTILE_VERIFIER');

/** The request headers the public API reads. Lower-case, as Node hands them over. */
export const KEY_HEADER = 'x-elysium-key';
export const TIMESTAMP_HEADER = 'x-elysium-timestamp';
export const SIGNATURE_HEADER = 'x-elysium-signature';

export interface IntakeReceipt {
  readonly orderId: string;
  readonly orderNo: string;
  readonly status: string;
}

export interface IntakeOutcome {
  readonly replayed: boolean;
  readonly receipt: IntakeReceipt;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

/**
 * The public order intake (architecture §23; M11 acceptance check 3).
 *
 * One request, in this order, and the order is the design:
 *
 * 1. **The source address is rate-limited before anything is read.** A flood costs one
 *    counter increment per request, not a database round trip.
 * 2. **The key, the timestamp and the signature**, against the raw bytes. Everything that
 *    fails here is the same 401 (see `notAuthenticated`), and nothing after this step runs
 *    for an unsigned request — so the body's schema, the SKU codes and the phone rules are
 *    invisible to anybody without a key.
 * 3. **The body is parsed**, and the phone normalised by the domain's own rule.
 * 4. **A replay is recognised before Turnstile is asked.** Tokens are single-use, so a
 *    retry of an order that already exists carries a spent token; answering it from the
 *    record is the only way a retry of a good order gets the good answer.
 * 5. **The per-site, per-visitor and per-phone limits** — only for a request that would
 *    create something. A replay is free.
 * 6. **The idempotency key is claimed** in its own short transaction, so two copies of one
 *    request cannot both reach Cloudflare.
 * 7. **Turnstile**, outside every transaction (invariant 6).
 * 8. **The order**, through `ORDERS_API.createOrder`, and the claim completed, in one
 *    transaction. `pending`, unassigned, channel from the key, UTMs in `source`.
 *
 * Any refusal after step 6 releases the claim, so the landing page can retry with the same
 * key and a fresh token.
 */
@Injectable()
export class IntakeService {
  /**
   * Built on first use, as `FraudService` does: `createLogger` parses the whole server
   * environment, and a constructor that did so would make this class unbuildable in a test
   * that hands it its collaborators directly.
   */
  private cachedLogger: Logger | undefined;

  private get logger(): Logger {
    this.cachedLogger ??= createLogger('intake');
    return this.cachedLogger;
  }

  constructor(
    @Inject(INTAKE_CONFIG) private readonly config: IntakeConfig,
    @Inject(INTAKE_RATE_LIMITER) private readonly limiter: RateLimitStore,
    @Inject(TURNSTILE_VERIFIER) private readonly turnstile: TurnstileVerifier,
    @Inject(ORDERS_API) private readonly orders: OrdersApi,
    @Inject(CATALOG_API) private readonly catalog: CatalogApi,
    private readonly audit: AuditService,
  ) {}

  // --- the public endpoint ------------------------------------------------------

  async receive(request: FastifyRequest, rawBody: Buffer): Promise<IntakeOutcome> {
    await this.limit(`src:${request.ip}`, this.config.INTAKE_RATE_SOURCE_IP_PER_MINUTE, 60);

    const master = this.config.INTAKE_KEY_SECRET;
    if (master === undefined) {
      // Fail closed: without the master key no site's secret can be derived, and a
      // verification that could not run must not read as one that passed.
      this.logger.error('intake refused a request: INTAKE_KEY_SECRET is not configured');
      throw new IntakeError(
        'SERVICE_UNAVAILABLE',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Order intake is not configured on this server.',
      );
    }

    const keyId = header(request, KEY_HEADER) ?? '';
    const timestamp = header(request, TIMESTAMP_HEADER) ?? '';
    const signature = header(request, SIGNATURE_HEADER) ?? '';
    const idempotencyKey = (header(request, IDEMPOTENCY_HEADER) ?? '').trim();

    if (idempotencyKey === '') {
      // §23: required on the public API, where the platform only offers it. Checked before
      // the signature because it is part of what is signed.
      throw new IntakeError(
        'IDEMPOTENCY_KEY_INVALID',
        HttpStatus.BAD_REQUEST,
        'An Idempotency-Key header is required on every public order.',
      );
    }

    const orgId = orgIdOf(keyId);
    if (orgId === null) throw this.refuse('malformed key id');

    const site = await withOrg({ orgId }, (tx) => repo.siteKeyByKeyId(tx, orgId, keyId));
    if (site === undefined) throw this.refuse('unknown key id');
    if (site.revoked_at !== null) throw this.refuse('revoked key');

    const secret = deriveSecret(master, keyId);
    if (fingerprint(secret) !== site.secret_sha256) {
      // The master key changed since this key was issued. Verifying against the new
      // derivation would check the request against a secret the site never received.
      throw this.refuse('key issued under a different INTAKE_KEY_SECRET');
    }
    if (!timestampFresh(timestamp, new Date(), this.config.INTAKE_SIGNATURE_WINDOW_SECONDS)) {
      throw this.refuse('timestamp outside the window');
    }
    if (!signatureMatches({ secret, header: signature, timestamp, idempotencyKey, rawBody })) {
      throw this.refuse('signature mismatch');
    }

    const input = this.parseBody(request.body);
    const phoneE164 = this.phoneOf(input);
    const requestSha256 = bodyHash(rawBody);
    const actor = { orgId, userId: `intake:${site.id}` };

    // Step 4: a replay answers from the record, before any limit or any Cloudflare call.
    const existing = await withOrg(actor, (tx) =>
      repo.submissionFor(tx, orgId, site.id, idempotencyKey),
    );
    if (existing !== undefined) return this.answerExisting(orgId, existing, requestSha256);

    const visitorIp = input.visitor?.ip ?? request.ip;
    await Promise.all([
      this.limit(`site:${site.id}`, this.config.INTAKE_RATE_SITE_PER_MINUTE, 60),
      this.limit(
        `visitor:${site.id}:${visitorIp}`,
        this.config.INTAKE_RATE_VISITOR_IP_PER_MINUTE,
        60,
      ),
      this.limit(
        `phone:${phoneBucket(orgId, phoneE164)}`,
        this.config.INTAKE_RATE_PHONE_PER_HOUR,
        3600,
      ),
    ]);

    const claimId = await withOrg(actor, (tx) =>
      repo.claimSubmission(tx, { orgId, siteKeyId: site.id, idempotencyKey, requestSha256 }),
    );
    if (claimId === undefined) {
      // Somebody claimed it between the read and here: the concurrent copy of this request.
      const raced = await withOrg(actor, (tx) =>
        repo.submissionFor(tx, orgId, site.id, idempotencyKey),
      );
      if (raced === undefined) throw this.inFlight();
      return this.answerExisting(orgId, raced, requestSha256);
    }

    try {
      const verdict = await this.turnstile.verify({
        token: input.turnstileToken,
        remoteIp: input.visitor?.ip ?? null,
        idempotencyKey: claimId,
      });
      if (!verdict.success) {
        this.logger.warn(
          { errorCodes: verdict.errorCodes, site: site.id },
          'turnstile refused an order',
        );
        throw verdict.unavailable
          ? new IntakeError(
              'SERVICE_UNAVAILABLE',
              HttpStatus.SERVICE_UNAVAILABLE,
              'The form check could not be completed. Retry with the same Idempotency-Key.',
            )
          : new IntakeError(
              'FORBIDDEN',
              HttpStatus.FORBIDDEN,
              'The form check (Turnstile) was not passed. Ask the visitor to submit again.',
            );
      }

      const receipt = await withOrg(actor, async (tx) => {
        const lines = await this.resolveLines(tx, orgId, input);
        const created = await this.orders.createOrder(tx, actor, {
          channel: site.channel === 'website' ? 'website' : 'landing_page',
          source: sourceOf(input, site.landing_page_id),
          customer: {
            phone: phoneE164,
            name: input.customer.name,
            address: {
              districtId: input.address.districtId,
              thanaId: input.address.thanaId,
              ...(input.address.area === undefined ? {} : { area: input.address.area }),
              addressLine: input.address.addressLine,
            },
          },
          shipTo: {
            name: input.customer.name,
            districtId: input.address.districtId,
            thanaId: input.address.thanaId,
            ...(input.address.area === undefined ? {} : { area: input.address.area }),
            addressLine: input.address.addressLine,
          },
          lines,
          ...(input.notes === undefined ? {} : { notes: input.notes }),
        });
        const completed = await repo.completeSubmission(tx, {
          orgId,
          id: claimId,
          orderId: created.id,
        });
        if (!completed) throw this.inFlight();
        await repo.touchSiteKey(tx, orgId, site.id);
        await this.audit.record(tx, {
          orgId,
          actorUserId: actor.userId,
          operation: 'create',
          action: 'intake.order_received',
          entityType: 'order',
          entityId: created.id,
          // `phone`, so the audit redactor masks it (invariant 10).
          after: {
            orderNo: created.orderNo,
            siteKeyId: site.id,
            channel: site.channel,
            phone: phoneE164,
          },
          ip: request.ip,
          userAgent: header(request, 'user-agent') ?? null,
          request: request as unknown as AuditableRequest,
        });
        return { orderId: created.id, orderNo: created.orderNo, status: created.status };
      });
      return { replayed: false, receipt };
    } catch (error) {
      await withOrg(actor, (tx) => repo.releaseSubmission(tx, orgId, claimId)).catch(
        (releaseError: unknown) => {
          // The claim then stays pending and a retry takes it over after the stale window;
          // the client is told why its request failed either way.
          this.logger.error({ err: releaseError }, 'intake could not release a failed claim');
        },
      );
      throw this.asHttp(error);
    }
  }

  // --- key management -----------------------------------------------------------

  /**
   * Issue a key for a site. The secret is in this response and in no other, ever.
   *
   * Not stored and not recoverable from anything stored: a site that loses it is issued a
   * new key and the old one revoked. That is deliberate — "show me the secret again" is a
   * feature that exists only if the secret sits somewhere an attacker can also ask.
   */
  async issueKey(context: ActiveContext, request: AuditableRequest, input: IssueSiteKeyInput) {
    const master = this.config.INTAKE_KEY_SECRET;
    if (master === undefined) {
      throw new IntakeError(
        'SERVICE_UNAVAILABLE',
        HttpStatus.SERVICE_UNAVAILABLE,
        'Set INTAKE_KEY_SECRET before issuing site keys.',
      ).toHttp();
    }
    const keyId = newKeyId(context.orgId);
    const secret = deriveSecret(master, keyId);

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const row = await repo.insertSiteKey(tx, {
        orgId: context.orgId,
        label: input.label,
        channel: input.channel,
        landingPageId: input.landingPageId ?? null,
        keyId,
        secretSha256: fingerprint(secret),
        createdBy: context.userId,
      });
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'intake.site_key_issued',
        entityType: 'intake.site_key',
        entityId: row.id,
        // The key id is public; the secret is not in here, under any name.
        after: { label: input.label, channel: input.channel, keyId },
        request,
      });
      return { ...toSiteKeyView(row), secret };
    });
  }

  async listKeys(context: ActiveContext) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await repo.listSiteKeys(tx, context.orgId)).map(toSiteKeyView),
    }));
  }

  async revokeKey(context: ActiveContext, request: AuditableRequest, id: string) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const revoked = await repo.revokeSiteKey(tx, {
        orgId: context.orgId,
        id,
        revokedBy: context.userId,
      });
      const row = await repo.siteKeyById(tx, context.orgId, id);
      if (row === undefined) {
        throw new HttpException({ code: 'NOT_FOUND', message: 'No such site key.' }, 404);
      }
      if (revoked) {
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: 'update',
          action: 'intake.site_key_revoked',
          entityType: 'intake.site_key',
          entityId: id,
          after: { keyId: row.key_id },
          request,
        });
      }
      return toSiteKeyView(row);
    });
  }

  // --- the pieces ---------------------------------------------------------------

  private refuse(why: string): IntakeError {
    this.logger.warn({ why }, 'intake refused an unauthenticated request');
    return notAuthenticated();
  }

  private inFlight(): IntakeError {
    return new IntakeError(
      'IDEMPOTENCY_IN_FLIGHT',
      HttpStatus.CONFLICT,
      'That request is still being processed. Retry in a moment with the same Idempotency-Key.',
    );
  }

  private async limit(bucket: string, perWindow: number, windowSeconds: number): Promise<void> {
    const decision = await this.limiter.hit(`intake:${bucket}`, perWindow, windowSeconds);
    if (!decision.allowed) {
      throw new IntakeError(
        'RATE_LIMITED',
        HttpStatus.TOO_MANY_REQUESTS,
        'Too many orders from this source. Wait and try again.',
        decision.retryAfterSeconds ?? windowSeconds,
      );
    }
  }

  private parseBody(body: unknown): PublicOrderInput {
    const parsed = publicOrderSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new IntakeError(
        'VALIDATION_FAILED',
        HttpStatus.BAD_REQUEST,
        issue === undefined
          ? 'The order is not valid.'
          : `${issue.path.join('.')}: ${issue.message}`,
      );
    }
    return parsed.data;
  }

  private phoneOf(input: PublicOrderInput): string {
    try {
      return normalizeBdPhone(input.customer.phone);
    } catch (error) {
      throw fromOrdersRefusal(error) ?? error;
    }
  }

  /** A request whose key was used before: the same order, or a refusal saying why not. */
  private async answerExisting(
    orgId: string,
    existing: repo.SubmissionRow,
    requestSha256: string,
  ): Promise<IntakeOutcome> {
    if (existing.request_sha256 !== requestSha256) {
      throw new IntakeError(
        'IDEMPOTENCY_CONFLICT',
        HttpStatus.CONFLICT,
        'That Idempotency-Key was already used for a different order.',
      );
    }
    if (existing.status !== 'completed' || existing.order_id === null) throw this.inFlight();

    const orderId = existing.order_id;
    const summary = await withOrg({ orgId }, (tx) => this.orders.summary(tx, orgId, orderId));
    if (summary === undefined) throw this.inFlight();
    return {
      replayed: true,
      receipt: { orderId: summary.id, orderNo: summary.orderNo, status: summary.status },
    };
  }

  /** SKU codes to ids, through the catalog's interface (invariant 12). */
  private async resolveLines(
    tx: Parameters<CatalogApi['skuByCode']>[0],
    orgId: string,
    input: PublicOrderInput,
  ): Promise<{ skuId: string; qty: number }[]> {
    const lines: { skuId: string; qty: number }[] = [];
    for (const line of input.lines) {
      if (line.skuId !== undefined) {
        lines.push({ skuId: line.skuId, qty: line.qty });
        continue;
      }
      const sku =
        line.skuCode === undefined
          ? undefined
          : await this.catalog.skuByCode(tx, orgId, line.skuCode);
      if (sku === undefined) {
        throw new IntakeError(
          'ORDER_LINES_INVALID',
          HttpStatus.BAD_REQUEST,
          `No SKU ${line.skuCode ?? ''} is on sale in this brand.`,
        );
      }
      lines.push({ skuId: sku.id, qty: line.qty });
    }
    return lines;
  }

  private asHttp(error: unknown): unknown {
    if (error instanceof IntakeError) return error;
    if (error instanceof HttpException) return error;
    const refusal = fromOrdersRefusal(error);
    if (refusal !== null) return refusal;
    this.logger.error(
      { err: error instanceof Error ? error.message : String(error) },
      'intake failed to create an order',
    );
    return error;
  }
}

/** §9's `source` block from the page's UTMs and the key's landing page. */
function sourceOf(input: PublicOrderInput, landingPageId: string | null) {
  const utm = input.utm ?? {};
  return {
    ...(landingPageId === null ? {} : { landingPageId }),
    ...(utm.source === undefined ? {} : { utmSource: utm.source }),
    ...(utm.medium === undefined ? {} : { utmMedium: utm.medium }),
    ...(utm.campaign === undefined ? {} : { utmCampaign: utm.campaign }),
    ...(utm.content === undefined ? {} : { utmContent: utm.content }),
    ...(utm.term === undefined ? {} : { utmTerm: utm.term }),
  };
}

/**
 * The per-phone bucket's name: a hash, not the number.
 *
 * Counter keys live in Valkey, where `KEYS intake:*` is one command away for anyone with
 * access to the cache — a list of every number that ordered in the last hour is not
 * something a rate limiter should be leaving lying about (invariant 10). The org is in the
 * hash so two brands' counters for one buyer stay two counters.
 */
function phoneBucket(orgId: string, phoneE164: string): string {
  return createHash('sha256').update(`${orgId}:${phoneE164}`).digest('hex').slice(0, 32);
}

export function toSiteKeyView(row: repo.SiteKeyRow) {
  return {
    id: row.id,
    label: row.label,
    channel: row.channel,
    landingPageId: row.landing_page_id,
    keyId: row.key_id,
    lastUsedAt: row.last_used_at === null ? null : new Date(row.last_used_at).toISOString(),
    revokedAt: row.revoked_at === null ? null : new Date(row.revoked_at).toISOString(),
    createdBy: row.created_by,
    createdAt: new Date(row.created_at).toISOString(),
  };
}
