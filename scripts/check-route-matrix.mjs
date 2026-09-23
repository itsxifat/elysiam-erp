#!/usr/bin/env node
/**
 * Route coverage (M02b check 6).
 *
 * Fails the build when a route ships without declaring what it needs.
 *
 * This exists because "every route declares its ability" is not enforceable by
 * review. The failure is an *absence* — a missing decorator on a new handler —
 * and absences are what code review is worst at. The guard already denies an
 * undeclared route at runtime, which is the safe direction, but discovering it
 * that way means discovering it from a support ticket. M30 was going to audit
 * this once at the end; doing it on every commit instead means the answer is
 * never more than one commit stale.
 *
 * It boots the real application — without listening — and reads the routes out
 * of Nest's own container, so a route registered by a dynamic module or a
 * library counts exactly like one written by hand.
 */

import process from 'node:process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const root = new URL('..', import.meta.url);

/**
 * Config the app needs to construct. Deliberately fake and deliberately local:
 * the gate must not require a database, a secret manager or a network, or it
 * stops being something that runs on every commit.
 */
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  API_PUBLIC_URL: 'http://127.0.0.1:3000',
  APP_DOMAIN: 'localhost',
  AUTH_SECRET: 'route-matrix-check-secret-at-least-32-chars',
  TRUSTED_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: 'postgres://erp_app:x@127.0.0.1:5432/unused',
};

for (const [key, value] of Object.entries(ENV)) process.env[key] ??= value;

/**
 * Resolve as the server does.
 *
 * pnpm keeps each package's dependencies under its own node_modules, so
 * `@nestjs/core` is not resolvable from the repo root where this script lives.
 * Anchoring the resolver at apps/server means the gate loads the same copies
 * the application does rather than whatever happens to be hoisted.
 */
const fromServer = createRequire(new URL('apps/server/package.json', root));
const load = (specifier) => import(pathToFileURL(fromServer.resolve(specifier)).href);

async function main() {
  await load('reflect-metadata');

  const [{ NestFactory }, { FastifyAdapter }] = await Promise.all([
    load('@nestjs/core'),
    load('@nestjs/platform-fastify'),
  ]);

  const [{ AppModule }, { describeRoutes }, { PasswordTokenStore }] = await Promise.all([
    import(new URL('apps/server/dist/app.module.js', root).href),
    import(new URL('apps/server/dist/platform/auth/route-map.js', root).href),
    import(new URL('apps/server/dist/modules/iam/iam.service.js', root).href),
  ]);

  // A stand-in for Better Auth. The gate reads metadata, never calls a handler,
  // so the modules need something shaped right rather than something working —
  // and building the real one would open a database connection.
  const auth = { api: {} };

  const app = await NestFactory.create(
    AppModule.register({ auth, tokens: new PasswordTokenStore() }),
    // The same adapter production uses. Nest defaults to Express, which is not
    // installed — and a gate that inspects a differently-built application is
    // inspecting the wrong one.
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();

  const routes = describeRoutes(app);
  await app.close();

  if (routes.length === 0) {
    console.error(
      'check-route-matrix: no routes found at all. The gate is not looking at anything.',
    );
    process.exit(1);
  }

  const undeclared = routes.filter((route) => route.declared === null);

  for (const route of routes) {
    const mark = route.declared === null ? 'MISSING' : route.declared;
    console.log(`  ${route.method.padEnd(6)} ${route.path.padEnd(32)} ${mark}`);
  }

  if (undeclared.length > 0) {
    console.error(
      `\ncheck-route-matrix: ${String(undeclared.length)} route(s) declare no ability.\n` +
        undeclared
          .map((route) => `  ${route.method} ${route.path}  (${route.controller}.${route.handler})`)
          .join('\n') +
        '\n\nEvery route needs one of:\n' +
        "  @RequireAbility('read', 'Order')   the usual case\n" +
        "  @AuthenticatedOnly('reason')       needs a session, but no subject\n" +
        "  @Public('reason')                  deliberately open\n",
    );
    process.exit(1);
  }

  const publicRoutes = routes.filter((route) => route.declared?.startsWith('public:'));
  console.log(
    `\ncheck-route-matrix: ${String(routes.length)} route(s), all declared. ` +
      `${String(publicRoutes.length)} public. PASS`,
  );
}

main().catch((error) => {
  console.error('check-route-matrix: failed to inspect the application.');
  console.error(error);
  process.exit(1);
});
