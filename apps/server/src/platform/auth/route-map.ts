import { MetadataScanner, ModulesContainer } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';

import { ABILITY_KEY, AUTHENTICATED_ONLY, PUBLIC_KEY } from './abilities.js';

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
  /** `read:Order`, `authenticated`, `public:<reason>`, or null when undeclared. */
  readonly declared: string | null;
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

        /*
         * The same rule the guard applies, resolved the same way.
         *
         * Both levels are read, and a route that declares an ability while also
         * being public is reported as undeclared — because that is what the
         * guard does with it (it throws). If these two ever disagreed, the gate
         * would bless a route the guard refuses, or print PASS for one it lets
         * through by accident. Both have happened.
         */
        const handlerAbility = Reflect.getMetadata(ABILITY_KEY, handler) as
          { action: string; subject?: string } | undefined;
        const handlerPublic = Reflect.getMetadata(PUBLIC_KEY, handler) as string | undefined;
        const classAbility = Reflect.getMetadata(ABILITY_KEY, controllerType) as
          { action: string; subject?: string } | undefined;
        const classPublic = Reflect.getMetadata(PUBLIC_KEY, controllerType) as string | undefined;

        const ability = handlerAbility ?? classAbility;
        const publicReason = handlerPublic ?? classPublic;

        let declared: string | null = null;
        if (ability !== undefined && publicReason !== undefined) {
          declared = null;
        } else if (publicReason !== undefined) {
          declared = `public:${publicReason}`;
        } else if (ability !== undefined) {
          declared =
            ability.action === AUTHENTICATED_ONLY
              ? AUTHENTICATED_ONLY
              : `${ability.action}:${ability.subject ?? '?'}`;
        }

        routes.push({
          controller: controllerType.name,
          handler: name,
          method: METHOD_NAMES[methodCode] ?? String(methodCode),
          path: joinPath(prefix, suffix),
          declared,
        });
      }
    }
  }

  return routes.sort((a, b) => `${a.path}${a.method}`.localeCompare(`${b.path}${b.method}`));
}
