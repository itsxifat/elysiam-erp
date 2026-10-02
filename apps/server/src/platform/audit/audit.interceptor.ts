import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { serializeFor } from '@elysium/contracts';
import { redact } from '@elysium/domain';
import { withOrg, type RequestContext } from '@elysium/db';
import type { FastifyRequest } from 'fastify';
import { tap, type Observable } from 'rxjs';

import { ABILITY_KEY } from '../auth/abilities.js';
import { ScopeNotAppliedError } from '../auth/scope.js';
import { safeUrl } from '../logging/logger.js';
import type { AuditService } from './audit.service.js';

/**
 * The catch-all audit write (architecture §25).
 *
 * `.claude/rules` says every mutation must write an audit entry and that the
 * interceptor does it, so never bypass it. Both halves of that are true, and
 * the second half is why this is a *net* rather than the mechanism:
 *
 * - A service that writes its own entry with `AuditService.record(tx, …)` gets
 *   it **inside the mutation's transaction**, which is the only way the log
 *   cannot disagree with reality. An entry written outside can commit while
 *   the mutation rolls back, inventing history that never happened.
 * - This interceptor runs after the response, in its own transaction. It
 *   cannot be atomic with anything. What it can do is notice that a mutation
 *   went through a route nobody instrumented, and leave a record saying so.
 *
 * So a module that writes its own entry is doing the right thing, and this
 * covers the ones that have not got round to it yet. `alreadyAudited` is how
 * the two avoid writing the same event twice.
 */

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Set when a service has written its own, better, entry.
 *
 * Set by `AuditService.record`, not by the controller. It used to be an
 * exported free function a handler called before doing the work, which meant
 * "marked" and "recorded" were two different claims — any handler could mark
 * itself and then write nothing, and the mutation would be unaudited while
 * `.claude/rules`' "never bypass the interceptor" read as satisfied. Now the
 * only thing that can set it is an entry actually being written.
 */
export const ALREADY_AUDITED = Symbol('elysium:already-audited');

/**
 * Any object the flag can be hung on. A Fastify request, in practice — typed
 * loosely so a service does not have to import Fastify to write an audit entry.
 */
export type AuditableRequest = Record<PropertyKey, unknown> & {
  [ALREADY_AUDITED]?: boolean;
};

export const AUDIT_EXEMPT_KEY = 'elysium:audit-exempt';

/**
 * A public mutation route with no audit entry of its own, and why that is right.
 *
 * Declared on the handler, never set at run time, so it says what the route is rather than
 * what one request did, and `audit-exempt.test.ts` lists every handler that carries it: a new
 * one fails that test until somebody has read the reason. It only ever silences the "no org"
 * error. A request that has an org is audited as usual, exempt or not, so an exemption can
 * never remove a row from an org's log.
 */
export const AuditExempt = (reason: string) => SetMetadata(AUDIT_EXEMPT_KEY, reason);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    if (SAFE_METHODS.has(request.method.toUpperCase())) return next.handle();

    const typed = request as FastifyRequest & {
      context?: RequestContext;
      requestId?: string;
      [ALREADY_AUDITED]?: boolean;
    };

    return next.handle().pipe(
      tap({
        next: (body: unknown) => {
          // Only successful mutations. A rejected request is interesting, but
          // it is a security event rather than a change to an entity, and
          // mixing the two makes "what happened to this row" unanswerable.
          void this.write(typed, context, body);
        },
        error: (error: unknown) => {
          // The one failure that is still a change: the scope backstop fires
          // after the handler has committed (D-061). The write happened, so it
          // is recorded — flagged, with no response body to record.
          // Written even when the service already audited the mutation: that
          // entry says what changed, this one says the change escaped its
          // scope check, and the second fact is the one an investigator needs.
          if (error instanceof ScopeNotAppliedError) {
            void this.write(typed, context, { scopeNotApplied: true }, true);
          }
        },
      }),
    );
  }

  private async write(
    request: FastifyRequest & {
      context?: RequestContext;
      requestId?: string;
      [ALREADY_AUDITED]?: boolean;
    },
    context: ExecutionContext,
    body: unknown,
    evenIfAudited = false,
  ): Promise<void> {
    if (request[ALREADY_AUDITED] === true && !evenIfAudited) return;

    const requestContext = request.context;
    const orgId = requestContext?.orgId;
    if (requestContext === undefined || orgId == null) {
      // A public route that declared why it has no org log entry (`@AuditExempt`). Handler
      // only: a class-level exemption would cover routes nobody reviewed.
      const exempt = this.reflector.get<string | undefined>(AUDIT_EXEMPT_KEY, context.getHandler());
      if (exempt !== undefined) return;
      // No org means no tenant log to write into: `audit.audit_log` is
      // tenant-scoped and `org_id` is NOT NULL. A mutation that reaches here
      // without having audited itself is a route that should have — the org
      // switch is the one that exists, and it writes its own row into the org
      // it switches *to*. So this is a bug report, not a normal path, and it
      // says so rather than returning quietly.
      request.log.error(
        { path: safeUrl(request.url), method: request.method },
        'audit interceptor: a mutation completed with no org and no audit entry of its own',
      );
      return;
    }

    const declaration = this.reflector.getAllAndOverride<{ subject?: string } | undefined>(
      ABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );

    const entityType = declaration?.subject ?? 'Unknown';
    // Query dropped and phone numbers in the path masked, like every log line:
    // this string lands in an append-only table.
    const path = safeUrl(request.url);

    // From the method, not hardcoded. Every caught mutation used to land as
    // `update`, so a create and a delete were indistinguishable in a table that
    // cannot be corrected afterwards.
    const operation =
      request.method.toUpperCase() === 'POST'
        ? 'create'
        : request.method.toUpperCase() === 'DELETE'
          ? 'delete'
          : 'update';

    /*
     * Redaction is attempted, and its failure is never allowed to become a
     * failure to record.
     *
     * `redact` and `withoutCost` both walk the payload, and an unbounded walk
     * over a hostile body used to throw — which landed in the catch below, and
     * the mutation committed with no audit row at all. The walkers are bounded
     * now, but the shape of that bug is worth designing against rather than
     * only fixing: whatever goes wrong while *describing* what happened, the
     * fact that it happened still gets written.
     */
    let after: Record<string, unknown>;
    try {
      // The request body, redacted. It is the only record of intent when the
      // handler wrote nothing itself. Cost is stripped first: the log is read
      // by roles that may not read cost, and invariant 5 keeps purchase cost
      // in supply, inventory and the ledger only.
      after = {
        request: redact(withoutCost(request.body)),
        response: redact(withoutCost(body)),
      };
    } catch (error) {
      request.log.error({ err: error }, 'audit interceptor could not redact a payload');
      // A row that says "this happened and we could not safely describe it" is
      // worth far more than no row. It must not carry the raw payload: the
      // reason it is here is that redaction did not finish.
      after = { redactionFailed: true };
    }

    try {
      await withOrg({ orgId, userId: requestContext.userId }, async (tx) => {
        await this.audit.record(tx, {
          orgId,
          actorUserId: requestContext.userId,
          operation,
          action: `http:${request.method} ${path}`,
          entityType,
          entityId: entityIdFrom(body) ?? path,
          after,
          ip: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
          requestId: request.requestId ?? null,
        });
      });
    } catch (error) {
      // A failed audit write must not fail the request the user already got a
      // 200 for — the response has been sent. It must be loud, though: a
      // silently missing audit trail is the worst of both worlds.
      request.log.error({ err: error }, 'audit interceptor failed to record a mutation');
    }
  }
}

/** A payload with every COST_FIELDS entry removed, at any depth. */
function withoutCost(value: unknown): unknown {
  return serializeFor({ roles: [], isSuperAdmin: false }, 'Cost', value);
}

/**
 * The id of whatever was just created or changed.
 *
 * `body.id` covers most creates, but not all of them: `POST /v1/users` returns
 * `{ userId, membershipId, created }` and no `id`, so the audit row for the
 * single most security-sensitive mutation in the system — an org_admin creating
 * a user and granting them a role — was keyed on the URL and unanswerable to
 * "what happened to this user". The candidates are ordered most- to
 * least-specific.
 */
function entityIdFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;

  for (const key of ['id', 'userId', 'membershipId', 'requestId']) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}
