import { CallHandler, Controller, ExecutionContext, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { findCostFields, serializeFor } from '@elysium/contracts';
import type { RequestContext } from '@elysium/db';
import { lastValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';

import { RequireAbility } from '../auth/abilities.js';
import { SerializeInterceptor } from './serialize.interceptor.js';

/**
 * The serializer's blind spot, and the net under it (invariant 5).
 *
 * `serializeFor` deliberately skips anything that is not a plain object:
 * walking a Buffer with `Object.entries` turns a PDF into `{"0":80,"1":68}`,
 * and M22 returns Gotenberg PDFs on this path. A class instance is not a plain
 * object either, so a DTO carrying cost passes straight through it:
 *
 *   class ItemDto { id = '1'; wacPoisha = '120000' }
 *   serializeFor(salesContext, 'CostedItem', { items: [new ItemDto()] })
 *     -> { items: [ { id: '1', wacPoisha: '120000' } ] }
 *
 * `findCostFields` is looser on purpose and sees it. The interceptor used to
 * run that check only where there was *no* subject to serialize against, which
 * is the one path where it was least needed — so the two controls were blind
 * in the same place on every guarded route.
 *
 * No handler returns a DTO instance today; every one builds object literals
 * over `tx.execute` rows. M06's catalog and M22's documents are the two the
 * serializer's own comments name.
 */

class ItemDto {
  id = 'item-1';
  sku = 'SKU-1';
  wacPoisha = '120000';
  sellPricePoisha = '250000';
}

@Controller()
class CostedController {
  @RequireAbility('read', 'CostedItem')
  @Get()
  list() {
    return {};
  }
}

function contextFor(roles: readonly string[], isSuperAdmin = false): ExecutionContext {
  const requestContext: Partial<RequestContext> = {
    roles: roles as RequestContext['roles'],
    isSuperAdmin,
    userId: 'usr_1',
    orgId: 'org_1',
    branchIds: [],
  };

  return {
    // The unbound method on purpose: `Reflector` reads the decorator metadata
    // off the function object itself, and a bound copy carries none — which
    // silently sends every request down the no-subject path. It is never
    // called, so the rule's concern does not apply.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    getHandler: () => CostedController.prototype.list,
    getClass: () => CostedController,
    switchToHttp: () => ({ getRequest: () => ({ context: requestContext }) }),
  } as unknown as ExecutionContext;
}

async function through(body: unknown, roles: readonly string[], isSuperAdmin = false) {
  const interceptor = new SerializeInterceptor(new Reflector());
  const next: CallHandler = { handle: () => of(body) };
  return lastValueFrom(interceptor.intercept(contextFor(roles, isSuperAdmin), next));
}

describe('the serializer has a blind spot, and the interceptor covers it', () => {
  it('reproduces the blind spot, so the fix below is about something real', () => {
    // Asserted against `serializeFor` directly. If this ever starts passing —
    // because the pruner learned to walk class instances — the interceptor's
    // second check becomes redundant rather than wrong, and this says so.
    const out = serializeFor({ roles: ['sales'], isSuperAdmin: false }, 'CostedItem', {
      items: [new ItemDto()],
    });

    expect(findCostFields(out)).toEqual(['$.items[0].wacPoisha']);
  });

  it('strips cost from a class instance on the way out', async () => {
    const body = await through({ items: [new ItemDto()] }, ['sales']);

    expect(findCostFields(body)).toEqual([]);
    // The positive control: everything a sales agent may see survived.
    expect(JSON.stringify(body)).toContain('SKU-1');
    expect(JSON.stringify(body)).toContain('250000');
  });

  it('still strips it from a plain object, which was never the problem', async () => {
    const body = await through({ items: [{ sku: 'A', wacPoisha: '1' }] }, ['sales']);
    expect(findCostFields(body)).toEqual([]);
  });

  it('leaves cost alone for a role that may read it', async () => {
    // The check must not become a second, stricter serializer that overrides
    // the matrix — `accounts` holds read:cost and the response is theirs.
    const body = await through({ items: [new ItemDto()] }, ['accounts']);
    expect(findCostFields(body)).toEqual(['$.items[0].wacPoisha']);
  });

  it('leaves it alone for a super admin with no roles at all', async () => {
    const body = await through({ items: [new ItemDto()] }, [], true);
    expect(findCostFields(body)).toEqual(['$.items[0].wacPoisha']);
  });

  it('does not corrupt a Buffer, which is why the pruner skips one', async () => {
    // The reason the blind spot exists. A PDF must come out the other side as
    // a PDF, not as `{"0":80,"1":68,"2":70}`.
    const pdf = Buffer.from('PDF');
    expect(await through(pdf, ['sales'])).toBe(pdf);
  });

  it('survives a circular structure rather than throwing on the way out', async () => {
    // The JSON round-trip the strip uses cannot represent one. Falling back to
    // pruning the original is worse than nothing only if it throws.
    const node: Record<string, unknown> = { sku: 'A', wacPoisha: '1' };
    node.self = node;

    const body = await through(node, ['sales']);
    expect(body).toBeDefined();
  });
});
