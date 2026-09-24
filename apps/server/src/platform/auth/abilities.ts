import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { defineAbilityFor, scopeFilterFor, type Action, type Subject } from '@elysium/contracts';
import type { RequestContext } from '@elysium/db';
import type { FastifyRequest } from 'fastify';

import { attachScope } from './scope.js';

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

export type Declaration =
  AbilityRequirement | { action: typeof AUTHENTICATED_ONLY; reason: string };

function isAbilityRequirement(value: Declaration): value is AbilityRequirement {
  return value.action !== AUTHENTICATED_ONLY;
}

/** The raw metadata a route carries, on the handler and on its controller. */
export interface DeclarationSources {
  readonly handlerAbility: Declaration | undefined;
  readonly handlerPublic: string | undefined;
  readonly controllerAbility: Declaration | undefined;
  readonly controllerPublic: string | undefined;
}

export type ResolvedDeclaration =
  | { readonly kind: 'public'; readonly reason: string }
  | { readonly kind: 'declared'; readonly declaration: Declaration }
  | { readonly kind: 'undeclared' }
  | { readonly kind: 'contradictory'; readonly why: string };

/**
 * What a route actually declared — the one answer both the guard and the gate
 * read, so they cannot disagree.
 *
 * They used to resolve it separately, and agreed on the wrong answer twice:
 * a handler inheriting `@Public` from its controller had its own
 * `@RequireAbility` silently discarded, and a handler carrying **both**
 * `@Public` and `@RequireAbility` on itself was simply public — the guard
 * returned true and the gate printed `public:<reason>`, PASS.
 *
 * Contradictions are refused rather than resolved, because there is no reading
 * of "public and also requires create:User" that anybody meant. The only
 * precedence that survives is a handler's own `@Public` overriding a
 * controller-wide `@RequireAbility`: that is one handler opting out, stated on
 * that handler, which is the explicit case.
 */
export function resolveDeclaration(sources: DeclarationSources): ResolvedDeclaration {
  const { handlerAbility, handlerPublic, controllerAbility, controllerPublic } = sources;

  if (handlerAbility !== undefined && handlerPublic !== undefined) {
    return { kind: 'contradictory', why: 'the handler declares both @Public and an ability' };
  }
  if (handlerAbility !== undefined && controllerPublic !== undefined) {
    return {
      kind: 'contradictory',
      why: 'the handler declares an ability and inherits @Public from its controller',
    };
  }
  if (handlerPublic !== undefined) return { kind: 'public', reason: handlerPublic };
  if (handlerAbility !== undefined) return { kind: 'declared', declaration: handlerAbility };

  if (controllerAbility !== undefined && controllerPublic !== undefined) {
    return { kind: 'contradictory', why: 'the controller declares both @Public and an ability' };
  }
  if (controllerPublic !== undefined) return { kind: 'public', reason: controllerPublic };
  if (controllerAbility !== undefined) return { kind: 'declared', declaration: controllerAbility };

  return { kind: 'undeclared' };
}

/** Read a route's declaration off the metadata Nest keeps for it. */
export function declarationOf(
  read: (key: string, target: object) => unknown,
  handler: object,
  controller: object,
): ResolvedDeclaration {
  return resolveDeclaration({
    handlerAbility: read(ABILITY_KEY, handler) as Declaration | undefined,
    handlerPublic: read(PUBLIC_KEY, handler) as string | undefined,
    controllerAbility: read(ABILITY_KEY, controller) as Declaration | undefined,
    controllerPublic: read(PUBLIC_KEY, controller) as string | undefined,
  });
}

@Injectable()
export class AbilityGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const handler = context.getHandler();
    const controller = context.getClass();

    /*
     * A handler that declares an ability is never public (§6). See
     * `resolveDeclaration`: moving `@Public` to a controller once silently
     * discarded every sibling's `@RequireAbility` (an anonymous caller reached
     * `POST /v1/users`), and a handler carrying both decorators was public. The
     * gate reads the same function, so the two cannot disagree again.
     */
    const resolved = declarationOf(
      (key, target) => this.reflector.get(key, target as never),
      handler,
      controller,
    );

    if (resolved.kind === 'contradictory') {
      throw new ForbiddenException(
        `This route's permission declarations contradict each other: ${resolved.why}. Remove one.`,
      );
    }

    if (resolved.kind === 'public') return true;

    // Undeclared means denied. See the note at the top of this file: the
    // alternative makes a forgotten decorator invisible.
    if (resolved.kind === 'undeclared') {
      throw new ForbiddenException(
        'This route declares no ability. Add @RequireAbility, @AuthenticatedOnly or @Public.',
      );
    }

    const declaration = resolved.declaration;

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

    const abilityContext = {
      roles: requestContext.roles,
      isSuperAdmin: requestContext.isSuperAdmin,
      userId: requestContext.userId,
      branchIds: requestContext.branchIds,
      // Per role, never merged (D-075).
      ...(requestContext.branchIdsByRole === undefined
        ? {}
        : { branchIdsByRole: requestContext.branchIdsByRole }),
    };
    const ability = defineAbilityFor(abilityContext);

    // A bare subject asks "on *some* row", which is all a route can know before
    // it has read anything. For an `own` or `branch` rule that is not the end of
    // it: the scope is handed on below, and the handler must apply it.
    if (!ability.can(declaration.action, declaration.subject)) {
      // Deliberately says what was needed rather than what the caller holds.
      // Listing their roles back at them turns a denial into a probe for
      // working out the matrix from outside.
      throw new ForbiddenException(
        `You cannot ${declaration.action} ${declaration.subject} in this organization.`,
      );
    }

    attachScope(
      request,
      declaration.action,
      declaration.subject,
      scopeFilterFor(abilityContext, declaration.action, declaration.subject),
    );

    return true;
  }
}
