import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';

import { AUTHENTICATED_ONLY, declarationOf, type AbilityRequirement } from './abilities.js';

/**
 * Every route the application registers, with what it declared.
 *
 * Read from Nest's own container rather than by scanning source, because the
 * question the gate asks is "what did this application actually register" —
 * and a source scan answers a different one. A route added by a dynamic module,
 * a mixin or a library is exactly the kind that gets missed by review and would
 * be missed by a grep too.
 */

export interface RouteDeclaration {
  readonly controller: string;
  readonly handler: string;
  readonly method: string;
  readonly path: string;
  /**
   * `read:Order`, `authenticated`, `public:<reason>`, or null when undeclared
   * or contradictory.
   */
  readonly declared: string | null;
  /** The (action, subject) the guard checks, when the route declares one. */
  readonly ability: AbilityRequirement | null;
  /** Why the declarations contradict each other, when they do. */
  readonly problem: string | null;
}

const METHOD_NAMES: Readonly<Record<number, string>> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.ALL]: 'ALL',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
};

function joinPath(prefix: unknown, suffix: unknown): string {
  const head = typeof prefix === 'string' ? prefix : '';
  const tail = typeof suffix === 'string' ? suffix : '';
  const joined = `/${head}/${tail}`.replace(/\/+/g, '/');
  return joined.length > 1 && joined.endsWith('/') ? joined.slice(0, -1) : joined;
}

export function describeRoutes(app: INestApplication): RouteDeclaration[] {
  const modules = app.get(ModulesContainer);
  const scanner = new MetadataScanner();
  const routes: RouteDeclaration[] = [];

  for (const module of modules.values()) {
    for (const wrapper of module.controllers.values()) {
      const instance = wrapper.instance as object | undefined;
      if (instance === undefined || instance === null) continue;

      const controllerType = wrapper.metatype;
      if (controllerType === undefined || controllerType === null) continue;

      const prefix = Reflect.getMetadata(PATH_METADATA, controllerType) as unknown;
      const prototype = Object.getPrototypeOf(instance) as object;

      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = (prototype as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;

        const methodCode = Reflect.getMetadata(METHOD_METADATA, handler) as number | undefined;
        if (methodCode === undefined) continue;

        const suffix = Reflect.getMetadata(PATH_METADATA, handler) as unknown;

        // Resolved by the very function the guard calls, so the gate cannot
        // bless a route the guard then refuses, or the other way round.
        const resolved = declarationOf(
          (key, target) => Reflect.getMetadata(key, target) as unknown,
          handler,
          controllerType,
        );

        let declared: string | null = null;
        let ability: AbilityRequirement | null = null;
        let problem: string | null = null;

        if (resolved.kind === 'contradictory') problem = resolved.why;
        else if (resolved.kind === 'public') declared = `public:${resolved.reason}`;
        else if (resolved.kind === 'declared') {
          const declaration = resolved.declaration;
          if (declaration.action === AUTHENTICATED_ONLY) declared = AUTHENTICATED_ONLY;
          else {
            ability = declaration;
            declared = `${ability.action}:${ability.subject}`;
          }
        }

        routes.push({
          controller: controllerType.name,
          handler: name,
          method: METHOD_NAMES[methodCode] ?? String(methodCode),
          path: joinPath(prefix, suffix),
          declared,
          ability,
          problem,
        });
      }
    }
  }

  return routes.sort((a, b) => `${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`));
}
