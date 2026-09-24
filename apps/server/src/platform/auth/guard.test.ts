import 'reflect-metadata';

import { Controller, Get, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { MembershipRole } from '@elysium/contracts';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditInterceptor } from '../audit/audit.interceptor.js';
import { applyGlobalPipeline } from '../http/pipeline.js';
import { AuthenticatedOnly, Public, RequireAbility } from './abilities.js';
import { describeRoutes } from './route-map.js';
import { assertInScope, scopeWhere } from './scope.js';

/**
 * The guard, the gate's view of the same declarations, and the scope backstop —
 * against a throwaway application with deliberately broken controllers.
 *
 * No database: the controllers here never touch one. What is under test is the
 * pipeline's decision about a route, which is made before any handler runs,
 * and it is mounted through `applyGlobalPipeline` — the function production
 * calls — so this is the real guard in the real order.
 */

@Controller('t/undeclared')
class UndeclaredController {
  @Get()
  get() {
    return { ok: true };
  }
}

@Controller('t/both')
class BothOnHandlerController {
  @Public('looks open')
  @RequireAbility('create', 'User')
  @Post()
  post() {
    return { ok: true };
  }
}

@Public('the whole controller is open')
@Controller('t/inherits')
class InheritsPublicController {
  @RequireAbility('create', 'User')
  @Post()
  post() {
    return { ok: true };
  }

  @Get()
  open() {
    return { ok: true };
  }
}

@RequireAbility('read', 'Order')
@Controller('t/opt-out')
class HandlerOptsOutController {
  @Public('one handler opts out of its controller, on that handler')
  @Get()
  open() {
    return { ok: true };
  }
}

/** A list that forgets its scope, and one that applies it. */
@Controller('t/orders')
class OrdersController {
  @RequireAbility('read', 'Order')
  @Get('forgets')
  forgets() {
    return { items: [] };
  }

  @RequireAbility('read', 'Order')
  @Get('applies')
  applies(@Req() request: FastifyRequest) {
    const where = scopeWhere(request, {
      createdBy: sql`created_by`,
      assignedTo: sql`assigned_to`,
      branchId: sql`branch_id`,
    });
    return { where: new PgDialect().sqlToQuery(where) };
  }

  @AuthenticatedOnly('test')
  @Get('me')
  me() {
    return { ok: true };
  }

  /** A create that never checks which branch it is writing into (W6). */
  @RequireAbility('create', 'Order')
  @Post('create-anywhere')
  createAnywhere() {
    return { id: 'order-1' };
  }

  /** The same create, asserting the row it is about to insert. */
  @RequireAbility('create', 'Order')
  @Post('create-in-branch')
  createInBranch(@Req() request: FastifyRequest) {
    const branchId = request.headers['x-branch'];
    assertInScope(request, {
      branchId: typeof branchId === 'string' ? branchId : null,
      createdBy: 'usr_1',
    });
    return { id: 'order-2' };
  }
}

/** Audit writes recorded instead of sent to a database this suite does not have. */
const auditWrites: unknown[] = [];

let app: NestFastifyApplication;

beforeAll(async () => {
  vi.spyOn(
    AuditInterceptor.prototype as unknown as { write: (...args: unknown[]) => Promise<void> },
    'write',
  ).mockImplementation((_request: unknown, _context: unknown, body: unknown) => {
    auditWrites.push(body);
    return Promise.resolve();
  });

  app = await NestFactory.create<NestFastifyApplication>(
    {
      module: class TestModule {},
      controllers: [
        UndeclaredController,
        BothOnHandlerController,
        InheritsPublicController,
        HandlerOptsOutController,
        OrdersController,
      ],
    } as never,
    new FastifyAdapter(),
    { logger: false },
  );
  applyGlobalPipeline(app);

  // Stand-in for the auth plugin: a signed-in user whose roles come from a
  // header. The guard reads nothing else.
  const server = app.getHttpAdapter().getInstance();
  server.addHook('onRequest', (request, _reply, done) => {
    const roles = request.headers['x-roles'];
    if (typeof roles === 'string') {
      const typed = request as unknown as Record<string, unknown>;
      typed.authUser = { id: 'usr_1' };
      typed.context = {
        userId: 'usr_1',
        orgId: '00000000-0000-0000-0000-000000000001',
        roles: roles === '' ? [] : (roles.split(',') as MembershipRole[]),
        branchIds: ['00000000-0000-0000-0000-00000000000a'],
        isSuperAdmin: false,
        requestId: 'req_1',
      };
    }
    done();
  });

  await app.init();
  await server.ready();
});

afterAll(async () => {
  await app?.close();
});

async function call(method: 'GET' | 'POST', url: string, roles?: string) {
  const response = await app.inject({
    method,
    url,
    ...(roles === undefined ? {} : { headers: { 'x-roles': roles } }),
  });
  return { status: response.statusCode, body: response.body };
}

describe('the guard refuses what nobody declared', () => {
  it('refuses a route with no declaration at all, even for an org admin', async () => {
    const response = await call('GET', '/t/undeclared', 'org_admin');
    expect(response.status).toBe(403);
    expect(response.body).toMatch(/declares no ability/);
  });

  it('refuses a handler carrying both @Public and @RequireAbility (L4)', async () => {
    // It used to be silently public: an anonymous caller reached it.
    const anonymous = await call('POST', '/t/both');
    expect(anonymous.status).toBe(403);
    expect(anonymous.body).toMatch(/contradict/);

    const admin = await call('POST', '/t/both', 'org_admin');
    expect(admin.status, 'contradictory is refused for everyone').toBe(403);
  });

  it('refuses a handler that declares an ability under a @Public controller', async () => {
    const response = await call('POST', '/t/inherits');
    expect(response.status).toBe(403);
    expect(response.body).toMatch(/contradict/);
  });

  it('still honours a plain @Public, and a handler opting out of its controller', async () => {
    // The positive controls: the refusals above are not "everything is 403".
    expect((await call('GET', '/t/inherits')).status).toBe(200);
    expect((await call('GET', '/t/opt-out')).status).toBe(200);
  });

  it('checks the matrix once a route is declared', async () => {
    expect((await call('GET', '/t/orders/me', 'sales')).status).toBe(200);
    expect((await call('GET', '/t/orders/applies', 'hr')).status).toBe(403);
    expect((await call('GET', '/t/orders/applies')).status).toBe(401);
  });
});

describe('the gate sees the same declarations the guard does', () => {
  it('reports undeclared and contradictory routes, and resolves the rest', () => {
    const routes = new Map(
      describeRoutes(app).map((route) => [`${route.method} ${route.path}`, route]),
    );

    expect(routes.get('GET /t/undeclared')).toMatchObject({ declared: null, problem: null });
    expect(routes.get('POST /t/both')?.problem).toMatch(/both @Public and an ability/);
    expect(routes.get('POST /t/inherits')?.problem).toMatch(/inherits @Public/);
    expect(routes.get('GET /t/inherits')?.declared).toBe('public:the whole controller is open');
    expect(routes.get('GET /t/opt-out')?.declared).toMatch(/^public:/);
    expect(routes.get('GET /t/orders/forgets')).toMatchObject({
      declared: 'read:Order',
      ability: { action: 'read', subject: 'Order' },
    });
  });
});

describe('row scope is mandatory for a scoped caller (M2)', () => {
  it('refuses to send a scoped response whose handler never applied the scope', async () => {
    // sales reads Order at `own` scope. A list that forgot its filter would
    // return every agent's orders; the backstop turns that into a 500.
    const response = await call('GET', '/t/orders/forgets', 'sales');
    expect(response.status).toBe(500);
  });

  it('lets an org-wide caller through the same handler, with nothing to apply', async () => {
    expect((await call('GET', '/t/orders/forgets', 'org_admin')).status).toBe(200);
  });

  it('renders own as created-by-or-assigned-to, and branch as a bound list', async () => {
    const own = JSON.parse((await call('GET', '/t/orders/applies', 'sales')).body) as {
      where: { sql: string; params: unknown[] };
    };
    expect(own.where.sql).toBe('(created_by = $1 or assigned_to = $2)');
    expect(own.where.params).toEqual(['usr_1', 'usr_1']);

    const branch = JSON.parse((await call('GET', '/t/orders/applies', 'branch_manager')).body) as {
      where: { sql: string; params: unknown[] };
    };
    expect(branch.where.sql).toBe('(branch_id in ($1::uuid))');
    expect(branch.where.params).toEqual(['00000000-0000-0000-0000-00000000000a']);

    const all = JSON.parse((await call('GET', '/t/orders/applies', 'org_admin')).body) as {
      where: { sql: string };
    };
    expect(all.where.sql).toBe('true');
  });
});

describe('a create is scoped too (W6)', () => {
  async function create(url: string, roles: string, branch?: string) {
    const response = await app.inject({
      method: 'POST',
      url,
      headers: { 'x-roles': roles, ...(branch === undefined ? {} : { 'x-branch': branch }) },
    });
    return response.statusCode;
  }

  const OWN_BRANCH = '00000000-0000-0000-0000-00000000000a';
  const OTHER_BRANCH = '00000000-0000-0000-0000-00000000000b';

  it('refuses a branch-scoped create whose handler never checked the branch', async () => {
    // `create` used to be exempt, so a branch manager could create in any
    // branch through a handler that forgot to look.
    expect(await create('/t/orders/create-anywhere', 'branch_manager')).toBe(500);
  });

  it('lets a create through once the handler asserts the row, and only in scope', async () => {
    expect(await create('/t/orders/create-in-branch', 'branch_manager', OWN_BRANCH)).toBe(201);
    expect(await create('/t/orders/create-in-branch', 'branch_manager', OTHER_BRANCH)).toBe(404);
  });

  it('still leaves an org-wide create alone', async () => {
    expect(await create('/t/orders/create-anywhere', 'org_admin')).toBe(201);
  });

  it('still audits a mutation the backstop rejected after it ran', async () => {
    // The handler has already written by the time the backstop fires, so the
    // audit net records it rather than losing it with the 500.
    auditWrites.length = 0;
    expect(await create('/t/orders/create-anywhere', 'branch_manager')).toBe(500);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(auditWrites).toContainEqual({ scopeNotApplied: true });
  });
});
