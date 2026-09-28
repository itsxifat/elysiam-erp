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
  /*
   * M13's phone HMAC key. The fraud module refuses to construct without one — a fallback
   * would silently turn every phone number into a new person (see `fraud.config.ts`) — so
   * the gate has to supply a fake one like every other secret here, or registering
   * `FraudModule` in `app.module.ts` would stop the gate booting the app at all.
   */
  FRAUD_PHONE_HASH_KEY: 'route-matrix-check-fraud-hash-key-32-chars',
};

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
  // Here rather than at module scope, so importing the rules for their test
  // does not repoint that process's database at a fake URL.
  for (const [key, value] of Object.entries(ENV)) process.env[key] ??= value;

  await load('reflect-metadata');

  const [{ NestFactory }, { FastifyAdapter }] = await Promise.all([
    load('@nestjs/core'),
    load('@nestjs/platform-fastify'),
  ]);

  const [{ AppModule }, { describeRoutes }, { PasswordTokenStore }, manifestModule] =
    await Promise.all([
      import(new URL('apps/server/dist/app.module.js', root).href),
      import(new URL('apps/server/dist/platform/auth/route-map.js', root).href),
      import(new URL('apps/server/dist/modules/iam/iam.service.js', root).href),
      import(new URL('apps/server/dist/platform/auth/route-matrix.manifest.js', root).href),
    ]);
  const { ROUTE_MATRIX_MANIFEST, routeKey } = manifestModule;

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

  const failures = checkRoutes(routes, ROUTE_MATRIX_MANIFEST, routeKey);

  for (const route of routes) {
    const mark =
      route.problem !== null
        ? 'CONTRADICTORY'
        : route.declared === null
          ? 'MISSING'
          : route.declared;
    const tested = ROUTE_MATRIX_MANIFEST.includes(routeKey(route)) ? 'matrix-tested' : '';
    console.log(
      `  ${route.method.padEnd(6)} ${route.path.padEnd(32)} ${mark.padEnd(28)} ${tested}`,
    );
  }

  if (failures.length > 0) {
    console.error(`\ncheck-route-matrix: ${String(failures.length)} problem(s).\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      '\nEvery route needs one of:\n' +
        "  @RequireAbility('read', 'Order')   the usual case\n" +
        "  @AuthenticatedOnly('reason')       needs a session, but no subject\n" +
        "  @Public('reason')                  deliberately open\n" +
        'and every route that is not @Public needs an entry in\n' +
        '  apps/server/src/platform/auth/route-matrix.manifest.ts\n' +
        'with a fixture in route-matrix.e2e.test.ts, which drives it as every role.\n',
    );
    process.exit(1);
  }

  const publicRoutes = routes.filter((route) => route.declared?.startsWith('public:'));
  console.log(
    `\ncheck-route-matrix: ${String(routes.length)} route(s), all declared, ` +
      `${String(routes.length - publicRoutes.length)} matrix-tested, ` +
      `${String(publicRoutes.length)} public. PASS`,
  );
}

/**
 * The gate's rules, as a pure function so they can be tested without booting
 * the application (check-route-matrix.test.mjs).
 *
 * 1. Every route declares something, and not two contradictory things.
 * 2. Every route that is not public has a matrix test — an entry in the
 *    manifest the generated suite is driven from.
 * 3. Every manifest entry is a live route, so the suite cannot keep testing a
 *    route that is gone while the real one goes untested.
 */
export function checkRoutes(routes, manifest, keyOf) {
  const failures = [];
  const live = new Set(routes.map(keyOf));

  for (const route of routes) {
    const where = `${route.method} ${route.path}  (${route.controller}.${route.handler})`;
    if (route.problem !== null) {
      failures.push(`${where}: contradictory declarations — ${route.problem}`);
      continue;
    }
    if (route.declared === null) {
      failures.push(`${where}: declares no ability`);
      continue;
    }
    if (route.declared.startsWith('public:')) continue;
    if (!manifest.includes(keyOf(route))) {
      failures.push(`${where}: has no matrix test (not in route-matrix.manifest.ts)`);
    }
  }

  for (const entry of manifest) {
    if (!live.has(entry)) failures.push(`${entry}: in the manifest, but no such route exists`);
  }

  return failures;
}

// Run only when invoked as a script, so the rules above can be imported by
// their test without booting the application.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error('check-route-matrix: failed to inspect the application.');
    console.error(error);
    process.exit(1);
  });
}
