import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defineAbilityFor, type Action, type Subject } from '@elysium/contracts';
import type { RequestContext } from '@elysium/db';
import type { FastifyRequest } from 'fastify';

/**
 * Route-level permissions (architecture §6).
 *
 * Every route declares what it needs, and the guard denies anything that has
 * not declared. That direction is the whole design: a guard that allows
 * undeclared routes turns "somebody forgot a decorator" into a silent hole,
 * and the only evidence is the absence of something — which no review reliably
 * catches. `check-route-matrix.mjs` then fails the build for the same omission,
 * so it is caught before it ships rather than by a request that should have
 * been refused.
 */

export const ABILITY_KEY = 'elysium:ability';
export const PUBLIC_KEY = 'elysium:public';

export interface AbilityRequirement {
  readonly action: Action;
  readonly subject: Subject;
}

/** Declare what a route needs. The guard reads this; so does the gate. */
export const RequireAbility = (action: Action, subject: Subject) =>
  SetMetadata(ABILITY_KEY, { action, subject } satisfies AbilityRequirement);

/**
 * Declare a route deliberately open.
 *
 * Takes a reason, and the reason is not decoration: the gate prints it, so
 * "why is this endpoint public" is answered in the diff that made it public
 * rather than reconstructed a year later. Login branding and health are the
 * only two today.
 */
export const Public = (reason: string) => SetMetadata(PUBLIC_KEY, reason);

/**
 * Routes that need a session but no particular ability.
 *
 * `GET /v1/me` is the honest example: it answers "who am I", and there is no
 * subject it could be about other than the caller. Still explicit, because the
 * gate must be able to tell it apart from a route nobody declared.
 */
export const AUTHENTICATED_ONLY = 'authenticated';
export const AuthenticatedOnly = (reason: string) =>
  SetMetadata(ABILITY_KEY, { action: AUTHENTICATED_ONLY, reason });

type Declaration = AbilityRequirement | { action: typeof AUTHENTICATED_ONLY; reason: string };

function isAbilityRequirement(value: Declaration): value is AbilityRequirement {
  return value.action !== AUTHENTICATED_ONLY;
}

@Injectable()
export class AbilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const controller = context.getClass();

    // The handler's own declaration first, always.
    const declaration = this.reflector.getAllAndOverride<Declaration | undefined>(ABILITY_KEY, [
      handler,
      controller,
    ]);

    const publicReason = this.reflector.getAllAndOverride<string | undefined>(PUBLIC_KEY, [
      handler,
      controller,
    ]);

    /*
     * A handler that declares an ability is never public (§6).
     *
     * `@Public` used to be resolved first, across handler *and* controller, and
     * returned true before anything else ran. So moving `@Public('runs before
     * anyone has signed in')` from one handler to the top of its controller — an
     * entirely ordinary refactor — silently discarded every sibling handler's
     * `@RequireAbility`, including `POST /v1/users`. Reproduced: an anonymous
     * caller was allowed through.
     *
     * Worse, `check-route-matrix` resolved it the same way and printed
     * `public:<reason>`, so the gate reported PASS. Two controls agreeing on the
     * wrong answer is exactly what having two controls is meant to rule out.
     *
     * Contradictory declarations are refused rather than silently resolved,
     * because there is no reading of "public and also requires create:User"
     * that anybody meant.
     */
    if (declaration !== undefined && publicReason !== undefined) {
      const handlerIsPublic = this.reflector.get<string | undefined>(PUBLIC_KEY, handler);
      const handlerHasAbility = this.reflector.get<Declaration | undefined>(ABILITY_KEY, handler);

      if (handlerHasAbility !== undefined && handlerIsPublic === undefined) {
        throw new ForbiddenException(
          'This route declares an ability and inherits @Public from its controller. Remove one.',
        );
      }
    }

    if (publicReason !== undefined && declaration === undefined) return true;
    if (publicReason !== undefined && this.reflector.get(PUBLIC_KEY, handler) !== undefined) {
      return true;
    }

    // Undeclared means denied. See the note at the top of this file: the
    // alternative makes a forgotten decorator invisible.
    if (declaration === undefined) {
      throw new ForbiddenException(
        'This route declares no ability. Add @RequireAbility, @AuthenticatedOnly or @Public.',
      );
    }

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const typed = request as FastifyRequest & {
      context?: RequestContext;
      authUser?: { id: string };
    };

    if (typed.authUser === undefined) throw new UnauthorizedException('Not signed in.');
    if (!isAbilityRequirement(declaration)) return true;

    const requestContext = typed.context;
    if (requestContext === undefined) {
      throw new UnauthorizedException('No active organization. Choose one first.');
    }

    const ability = defineAbilityFor({
      roles: requestContext.roles,
      isSuperAdmin: requestContext.isSuperAdmin,
      userId: requestContext.userId,
      branchIds: requestContext.branchIds,
    });

    if (!ability.can(declaration.action, declaration.subject)) {
      // Deliberately says what was needed rather than what the caller holds.
      // Listing their roles back at them turns a denial into a probe for
      // working out the matrix from outside.
      throw new ForbiddenException(
        `You cannot ${declaration.action} ${declaration.subject} in this organization.`,
      );
    }

    return true;
  }
}
