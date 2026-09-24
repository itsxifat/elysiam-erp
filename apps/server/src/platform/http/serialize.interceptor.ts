import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { canReadCost, findCostFields, serializeFor, type Subject } from '@elysium/contracts';
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

        const serialized = serializeFor(
          { roles: requestContext.roles, isSuperAdmin: requestContext.isSuperAdmin },
          subject,
          body,
        );

        /*
         * Check the serializer's own output, on the path that has a subject.
         *
         * This used to run only where there was no subject to serialize
         * against — and `serializeFor` has a documented blind spot that the
         * detector next to it does not share. `pruneDenied` returns anything
         * that is not a plain object untouched, deliberately, because walking
         * a Buffer turns a PDF into `{"0":80,"1":68}`. A class instance is not
         * a plain object. So:
         *
         *   class ItemDto { id = '1'; wacPoisha = '120000' }
         *   serializeFor(salesContext, 'CostedItem', { items: [new ItemDto()] })
         *     -> { items: [ { id: '1', wacPoisha: '120000' } ] }
         *
         * Reproduced against the built package. The cost reached a `sales`
         * caller, and `findCostFields` on that same output found it. No route
         * returns a DTO instance today — every handler builds object literals
         * over `tx.execute` rows — but M06's catalog and M22's documents are
         * the two the serializer's own comments name, and invariant 5 is the
         * one this milestone exists to hold.
         */
        return this.assertNoLeak(serialized, requestContext, subject);
      }),
    );
  }

  /**
   * A last check, on every path out.
   *
   * Two cases reach this. A route with no declared subject returning something
   * with a cost field in it is a bug — a missing declaration, or a leak. And a
   * route *with* a subject whose serialized output still carries cost has hit
   * the pruner's blind spot: it skips anything that is not a plain object, on
   * purpose, so a class instance passes through whole.
   *
   * Throwing would turn a data-shape mistake into an outage, so this strips
   * instead. The strip goes through JSON first, because the reason the value
   * survived is that it was not a plain object — pruning it again the same way
   * would return it again unchanged. `JSON.parse(JSON.stringify(x))` is what
   * the response was about to become anyway, and it is exactly the step that
   * turns a DTO into something the pruner can walk.
   *
   * And it is logged, loudly. A response that silently lost a field is how a
   * leak becomes a mystery instead of a bug report.
   */
  private assertNoLeak(body: unknown, requestContext?: RequestContext, subject?: Subject): unknown {
    const found = findCostFields(body);
    if (found.length === 0) return body;

    const context =
      requestContext === undefined
        ? { roles: [] as const, isSuperAdmin: false }
        : { roles: requestContext.roles, isSuperAdmin: requestContext.isSuperAdmin };

    // A role that may read cost is not leaking by holding it.
    if (canReadCost(context.roles, context.isSuperAdmin)) return body;

    let plain: unknown = body;
    try {
      plain = JSON.parse(JSON.stringify(body));
    } catch {
      // Circular, or something JSON cannot represent. Fall through: pruning
      // the original is still better than returning it.
    }

    return serializeFor(context, subject ?? 'Cost', plain);
  }
}
