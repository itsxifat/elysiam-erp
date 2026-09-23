import { UnauthorizedException } from '@nestjs/common';
import type { RequestContext } from '@elysium/db';
import type { FastifyRequest } from 'fastify';

/**
 * A request context that has actually chosen an org.
 *
 * `RequestContext.orgId` is nullable, because a session legitimately exists
 * before an org is picked. Every tenant query needs a real one, so rather than
 * each call site asserting non-null — and one of them eventually not — the
 * narrowing happens once, here, and the type carries it from then on.
 */
export interface ActiveContext extends RequestContext {
  readonly orgId: string;
}

export function requireContext(request: FastifyRequest): ActiveContext {
  const context = (request as FastifyRequest & { context?: RequestContext }).context;
  if (context?.orgId == null) {
    throw new UnauthorizedException('No active organization. Choose one first.');
  }
  return context as ActiveContext;
}
