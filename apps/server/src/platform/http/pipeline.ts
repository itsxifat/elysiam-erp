import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { AuditService } from '../audit/audit.service.js';
import { AbilityGuard } from '../auth/abilities.js';
import { ScopeInterceptor } from '../auth/scope.js';
import { SerializeInterceptor } from './serialize.interceptor.js';

/**
 * The guard and interceptors every request goes through (§6, §25, invariant 5).
 *
 * One function, called by `main.api.ts` and by every HTTP test suite, so the
 * tests exercise the pipeline production mounts rather than a copy of it that
 * can drift. The suites used to register their own list, in their own order.
 *
 * **The order is load-bearing.** Nest runs global interceptors outermost
 * first on the way in, so on the way *out* the last one listed sees the
 * handler's return value first:
 *
 * 1. `ScopeInterceptor` (innermost): refuses a scoped caller's response if the
 *    handler never applied the row scope.
 * 2. `SerializeInterceptor`: strips what the caller may not read.
 * 3. `AuditInterceptor` (outermost): records what actually left the process.
 *    It used to sit *inside* the serializer and so recorded the response before
 *    cost was stripped — cost from a sales user's request landing in the audit
 *    log, which is exactly where invariant 5 says it may not live. It strips
 *    cost itself as well, since a cost-reading caller's response is still not
 *    something the log should keep.
 */
export function applyGlobalPipeline(app: INestApplication): void {
  const reflector = app.get(Reflector);

  // Global rather than per-controller on purpose: a guard you have to remember
  // to add is a guard that is missing from the route somebody wrote in a hurry.
  app.useGlobalGuards(new AbilityGuard(reflector));

  app.useGlobalInterceptors(
    new AuditInterceptor(reflector, new AuditService()),
    new SerializeInterceptor(reflector),
    new ScopeInterceptor(),
  );
}
