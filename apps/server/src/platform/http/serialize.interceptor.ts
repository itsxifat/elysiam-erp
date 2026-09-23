import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { findCostFields, serializeFor, type Subject } from '@elysium/contracts';
import type { RequestContext } from '@elysium/db';
import type { FastifyRequest } from 'fastify';
import { map, type Observable } from 'rxjs';

import { ABILITY_KEY } from '../auth/abilities.js';

/**
 * Strip fields the caller may not read, on every response (invariant 5).
 *
 * An interceptor rather than a call in each handler, and the difference is the
 * whole point: a handler that forgets `serializeFor` returns cost to a reseller
 * and nothing anywhere says so. Responses are the one place where the failure
 * is silent in both directions — the wrong data looks exactly like the right
 * data, and nobody reports a bug about seeing *more* than they should.
 *
 * The subject comes from the route's own `@RequireAbility` declaration, so a
 * route cannot be serialized against the wrong subject without also being
 * guarded against the wrong one — which the matrix suite would catch.
 *
 * This does not reach every path out. A stream, a file download or an event
 * payload never becomes a controller return value, and each of those needs its
 * own handling when it arrives (M04 for events, M22 for documents). What it
 * does cover is every JSON response, which is all of them today.
 */
@Injectable()
export class SerializeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const declaration = this.reflector.getAllAndOverride<
      { action: string; subject?: Subject } | undefined
    >(ABILITY_KEY, [context.getHandler(), context.getClass()]);

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const requestContext = (request as FastifyRequest & { context?: RequestContext }).context;

    return next.handle().pipe(
      map((body: unknown) => {
        // No context means no roles to serialize against — an unauthenticated
        // or org-less response. Those routes are `@Public` or
        // `@AuthenticatedOnly` and return no tenant data by construction, but
        // the assertion below still holds them to it.
        if (requestContext === undefined) return this.assertNoLeak(body);

        const subject = declaration?.subject;
        if (subject === undefined) return this.assertNoLeak(body);

        return serializeFor(
          { roles: requestContext.roles, isSuperAdmin: requestContext.isSuperAdmin },
          subject,
          body,
        );
      }),
    );
  }

  /**
   * A last check on the paths the serializer cannot reason about.
   *
   * If a route with no declared subject returns something with a cost field in
   * it, that is a bug — either a missing declaration or a leak — and the
   * response is the wrong place to discover it quietly. Throwing would turn a
   * data-shape mistake into an outage, so this strips and leaves the evidence
   * in the payload's absence; the matrix suite is what makes it loud.
   */
  private assertNoLeak(body: unknown): unknown {
    if (findCostFields(body).length === 0) return body;
    return serializeFor({ roles: [], isSuperAdmin: false }, 'Cost', body);
  }
}
