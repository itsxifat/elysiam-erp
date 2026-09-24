import { Controller, Get, INestApplication } from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Module } from '@nestjs/common';
import { afterAll, describe, expect, it } from 'vitest';

import { AbilityGuard, AuthenticatedOnly, Public, RequireAbility } from './abilities.js';
import { describeRoutes } from './route-map.js';

/**
 * The guard's declaration rule, and the gate's agreement with it (§6).
 *
 * `check-route-matrix.mjs` reads metadata and never calls a handler, so it can
 * only be as right as the rule it reimplements — and that rule has been wrong
 * twice. First a controller-level `@Public` returned before the auth check, so
 * it silently discarded a handler's `@RequireAbility`; the gate agreed with it
 * and printed PASS. The repair left the narrower case, where both decorators
 * sit on the *same* handler.
 *
 * Neither had a test, because the gate is a script and the guard's unit is a
 * class nobody instantiated. This runs a throwaway application through both,
 * which is the only way to see them disagree.
 *
 * No database: nothing here gets past the declaration check, which is the
 * point — these are the routes that must never reach a handler at all.
 */

@Controller('probe')
class ProbeController {
  @Public('a login screen has to render before anyone has signed in')
  @Get('open')
  open() {
    return { ok: true };
  }

  @RequireAbility('read', 'Order')
  @Get('guarded')
  guarded() {
    return { ok: true };
  }

  @AuthenticatedOnly('answers "who am I", about no subject but the caller')
  @Get('session')
  session() {
    return { ok: true };
  }

  /**
   * The contradiction. Nobody writes this on purpose; it arrives when a
   * controller gains a `@Public` in a refactor, or when two people edit the
   * same handler. Either reading — "public wins" or "the ability wins" — is a
   * guess, and the first guess opened every route on a controller.
   */
  @Public('someone added this without removing the ability below')
  @RequireAbility('read', 'Order')
  @Get('contradiction')
  contradiction() {
    return { ok: true };
  }

  /** Declared nowhere. The whole reason the default is denial. */
  @Get('forgotten')
  forgotten() {
    return { ok: true };
  }
}

/**
 * A controller-level `@Public` over a handler that declares an ability.
 *
 * This is the shape of the first bug: an ordinary refactor moves `@Public` up
 * to the class, and every guarded route underneath it opens.
 */
@Public('the whole controller is a public surface')
@Controller('branded')
class BrandedController {
  @Get('logo')
  logo() {
    return { ok: true };
  }

  @RequireAbility('read', 'User')
  @Get('staff')
  staff() {
    return { ok: true };
  }
}

@Module({ controllers: [ProbeController, BrandedController] })
class ProbeModule {}

let app: NestFastifyApplication | undefined;

async function probeApp(): Promise<NestFastifyApplication> {
  if (app !== undefined) return app;

  app = await NestFactory.create<NestFastifyApplication>(ProbeModule, new FastifyAdapter(), {
    logger: false,
  });
  app.useGlobalGuards(new AbilityGuard(app.get(Reflector)));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

afterAll(async () => {
  await app?.close();
});

async function get(path: string): Promise<number> {
  const built = await probeApp();
  const response = await built.getHttpAdapter().getInstance().inject({ method: 'GET', url: path });
  return response.statusCode;
}

/** What the gate would print for this route. */
async function declaredBy(path: string): Promise<string | null> {
  const built = await probeApp();
  const route = describeRoutes(built as unknown as INestApplication).find(
    (entry) => entry.path === path,
  );
  if (route === undefined) throw new Error(`no route registered at ${path}`);
  return route.declared;
}

describe('a route that declares nothing is refused', () => {
  it('refuses it at runtime', async () => {
    // The alternative makes a forgotten decorator invisible: the only evidence
    // is the absence of something, which review is worst at catching.
    expect(await get('/probe/forgotten')).toBe(403);
  });

  it('and the gate reports it as undeclared, so the build fails too', async () => {
    expect(await declaredBy('/probe/forgotten')).toBeNull();
  });
});

describe('a route that declares both an ability and @Public is refused', () => {
  /*
   * Refused rather than resolved. Picking either reading silently is how the
   * first two bugs happened, and a contradiction nobody means is better as a
   * loud failure than as a quiet decision.
   */
  it('refuses it at runtime rather than picking a reading', async () => {
    expect(await get('/probe/contradiction')).toBe(403);
  });

  it('and the gate calls it undeclared, so the two cannot disagree', async () => {
    // This is the assertion that matters. If the gate resolved it to
    // `public:...` it would print PASS for a route the guard throws on, which
    // is the exact failure mode the gate exists to prevent.
    expect(await declaredBy('/probe/contradiction')).toBeNull();
  });
});

describe('a controller-level @Public does not open a handler that declares an ability', () => {
  it('still refuses the guarded handler underneath it', async () => {
    // The first bug, in its original shape: `@Public` on the class used to
    // return before the handler's declaration was ever read.
    expect(await get('/branded/staff')).toBe(403);
  });

  it('leaves the genuinely public handler open', async () => {
    // The positive control. Without it the 403 above could equally mean the
    // guard had stopped honouring `@Public` at all.
    expect(await get('/branded/logo')).toBe(200);
  });

  it('and the gate agrees about both', async () => {
    expect(await declaredBy('/branded/staff')).toBeNull();
    expect(await declaredBy('/branded/logo')).toBe(
      'public:the whole controller is a public surface',
    );
  });
});

describe('the ordinary declarations still behave', () => {
  it('lets an unauthenticated caller through a @Public route', async () => {
    expect(await get('/probe/open')).toBe(200);
  });

  it('refuses an unauthenticated caller on a route needing a session', async () => {
    // 401, not 403: there is nothing wrong with the request except that
    // nobody is signed in, and a client that cannot tell them apart retries
    // the wrong one.
    expect(await get('/probe/session')).toBe(401);
  });

  it('refuses an unauthenticated caller on a route needing an ability', async () => {
    expect(await get('/probe/guarded')).toBe(401);
  });

  it('reports each of them to the gate the way it was written', async () => {
    expect(await declaredBy('/probe/open')).toBe(
      'public:a login screen has to render before anyone has signed in',
    );
    expect(await declaredBy('/probe/guarded')).toBe('read:Order');
    expect(await declaredBy('/probe/session')).toBe('authenticated');
  });
});
