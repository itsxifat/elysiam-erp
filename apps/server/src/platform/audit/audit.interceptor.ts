import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { redact } from '@elysium/domain';
import { withOrg, type RequestContext } from '@elysium/db';
import type { FastifyRequest } from 'fastify';
import { tap, type Observable } from 'rxjs';

import { ABILITY_KEY } from '../auth/abilities.js';
import { AuditService } from './audit.service.js';

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

/** Set by a service that has already written its own, better, entry. */
export const ALREADY_AUDITED = Symbol('elysium:already-audited');

export function markAudited(request: FastifyRequest): void {
  (request as FastifyRequest & { [ALREADY_AUDITED]?: boolean })[ALREADY_AUDITED] = true;
}

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
  ): Promise<void> {
    if (request[ALREADY_AUDITED] === true) return;

    const requestContext = request.context;
    const orgId = requestContext?.orgId;
    if (requestContext === undefined || orgId == null) return;

    const declaration = this.reflector.getAllAndOverride<{ subject?: string } | undefined>(
      ABILITY_KEY,
      [context.getHandler(), context.getClass()],
    );

    const entityType = declaration?.subject ?? 'Unknown';
    const path = request.url.split('?')[0] ?? request.url;

    try {
      await withOrg({ orgId, userId: requestContext.userId }, async (tx) => {
        await this.audit.record(tx, {
          orgId,
          actorUserId: requestContext.userId,
          operation: 'update',
          action: `http:${request.method} ${path}`,
          entityType,
          entityId: entityIdFrom(body) ?? path,
          // The request body, redacted. It is the only record of intent when
          // the handler wrote nothing itself.
          after: { request: redact(request.body), response: redact(body) },
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

/** Best effort: most creates return `{ id }`. */
function entityIdFrom(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const id = (body as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
}
