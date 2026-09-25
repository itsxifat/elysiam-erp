#!/usr/bin/env node
/**
 * Generate `openapi.json` and `src/generated/*` (architecture §23).
 *
 * Two inputs, both of which must be the real thing:
 *
 * - the **routes**, read out of Nest's own container after booting the real
 *   `AppModule`. A source scan would answer a different question: a route added
 *   by a dynamic module or a mixin is exactly the kind review misses, and it
 *   would be missing from the client too.
 * - the **schemas**, the very Zod objects the server validates with, via
 *   `apps/server/dist/platform/openapi/*`.
 *
 * It boots without a database and without listening, the way
 * `scripts/check-route-matrix.mjs` does — a generator that needs Postgres
 * running is a generator nobody runs before pushing.
 *
 * Writes nothing but its own outputs, and writes them byte-deterministically, so
 * `pnpm check:api-client` can compare a fresh generation against the committed
 * copy.
 *
 * `--out <dir>` writes elsewhere, which is how the drift check generates into a
 * scratch directory without disturbing the working tree.
 */

import process from 'node:process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const SERVER_DIST = path.join(REPO_ROOT, 'apps/server/dist');

/**
 * The document version.
 *
 * Hand-held on purpose. Deriving it from the package version or from a hash
 * would change the generated files on commits that did not change the API, and
 * every one of those is a drift-check failure somebody has to investigate and
 * then ignore — which is how a gate stops being trusted.
 */
const API_VERSION = '1.0.0';

/**
 * Config the app needs to construct, deliberately fake and deliberately local.
 * Same values as the route-coverage gate, and for the same reason: generation
 * must not require a database, a secret manager or a network.
 */
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'fatal',
  API_HOST: '127.0.0.1',
  API_PORT: '3000',
  API_PUBLIC_URL: 'http://127.0.0.1:3000',
  APP_DOMAIN: 'localhost',
  AUTH_SECRET: 'api-client-generation-secret-at-least-32-chars',
  TRUSTED_ORIGINS: 'http://localhost:5173',
  DATABASE_URL: 'postgres://erp_app:x@127.0.0.1:5432/unused',
};

// pnpm keeps each package's dependencies under its own node_modules, so
// @nestjs/core is not resolvable from here. Anchor the resolver at apps/server
// and the generator loads the same copies the application does.
const fromServer = createRequire(path.join(REPO_ROOT, 'apps/server/package.json'));
const load = (specifier) => import(pathToFileURL(fromServer.resolve(specifier)).href);

/**
 * Run prettier over one emitted file.
 *
 * `filepath` is the path the file *would* have in the package, never the scratch
 * directory the drift check writes to — prettier resolves its config by walking
 * up from that path, and a temp directory has no config above it, so the two
 * runs would format differently and the check would fail every time.
 */
async function formatted(source, filepath) {
  const fromRoot = createRequire(path.join(REPO_ROOT, 'package.json'));
  const loaded = await import(pathToFileURL(fromRoot.resolve('prettier')).href);
  // prettier ships CommonJS, so a dynamic import wraps it in `default`.
  const prettier = loaded.resolveConfig === undefined ? loaded.default : loaded;
  const config = await prettier.resolveConfig(filepath);
  return prettier.format(source, { ...config, filepath });
}

function outDir() {
  const index = process.argv.indexOf('--out');
  if (index === -1) return PACKAGE_ROOT;
  const value = process.argv[index + 1];
  if (value === undefined) throw new Error('--out needs a directory.');
  return path.resolve(value);
}

async function describeApplication() {
  for (const [key, value] of Object.entries(ENV)) process.env[key] ??= value;

  await load('reflect-metadata');

  const [{ NestFactory }, { FastifyAdapter }] = await Promise.all([
    load('@nestjs/core'),
    load('@nestjs/platform-fastify'),
  ]);

  const [{ AppModule }, { describeRoutes }, { PasswordTokenStore }] = await Promise.all([
    import(pathToFileURL(path.join(SERVER_DIST, 'app.module.js')).href),
    import(pathToFileURL(path.join(SERVER_DIST, 'platform/auth/route-map.js')).href),
    import(pathToFileURL(path.join(SERVER_DIST, 'modules/iam/iam.service.js')).href),
  ]);

  // A stand-in for Better Auth: the generator reads metadata and never calls a
  // handler, so the modules need something shaped right, not something working.
  const auth = { api: {} };

  const app = await NestFactory.create(
    /*
     * `demo: true` so the fixture routes are in the document.
     *
     * They are in the route-coverage gate and the permission matrix for the same
     * reason, and leaving them out here would make the generated client differ
     * between a developer's machine and CI depending on NODE_ENV — which is a
     * drift-check failure with no cause anybody can find.
     */
    AppModule.register({ auth, tokens: new PasswordTokenStore(), demo: true }),
    new FastifyAdapter(),
    { logger: false, abortOnError: false },
  );
  await app.init();

  const routes = describeRoutes(app);
  await app.close();

  if (routes.length === 0) {
    throw new Error('no routes found at all — the generator is looking at nothing.');
  }

  return routes;
}

async function main() {
  const routes = await describeApplication();

  const [{ buildOpenApiDocument }, { emitClient, emitIndex }] = await Promise.all([
    import(pathToFileURL(path.join(SERVER_DIST, 'platform/openapi/document.js')).href),
    import(pathToFileURL(path.join(SERVER_DIST, 'platform/openapi/emit-client.js')).href),
  ]);

  const document = buildOpenApiDocument({ routes, version: API_VERSION });

  const target = outDir();
  const generated = path.join(target, 'src/generated');
  mkdirSync(generated, { recursive: true });

  /*
   * Formatted with the repo's own prettier before being written.
   *
   * Not cosmetic: `pnpm verify` runs `format:check` over the whole tree, so a
   * generated file that prettier would rewrite fails the build — and the fix
   * would be to run `format`, which then makes the file differ from a fresh
   * generation and fails the *drift* check instead. The two gates would
   * deadlock. Formatting here is what makes both agree.
   *
   * The output is still deterministic: prettier is pinned exactly in the
   * workspace catalog, and the drift check runs this same generator.
   */
  const emitted = [
    ['openapi.json', `${JSON.stringify(document, null, 2)}\n`],
    ['src/generated/client.ts', emitClient(document)],
    ['src/generated/index.ts', emitIndex()],
  ];

  for (const [relative, source] of emitted) {
    const file = path.join(target, relative);
    writeFileSync(file, await formatted(source, path.join(PACKAGE_ROOT, relative)));
  }

  const operations = Object.values(document.paths).reduce(
    (total, methods) => total + Object.keys(methods).length,
    0,
  );
  console.log(
    `api:client: ${String(operations)} operation(s) from ${String(routes.length)} route(s) ` +
      `→ ${path.relative(REPO_ROOT, target) || '.'}`,
  );
}

main().catch((error) => {
  console.error('api:client: generation failed.');
  console.error(error);
  console.error(
    '\nIf this is a module-not-found error, the server has not been built:\n' +
      '  pnpm --filter @elysium/server run build\n',
  );
  process.exit(1);
});
