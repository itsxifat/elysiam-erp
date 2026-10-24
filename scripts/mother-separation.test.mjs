import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The brands never carry the owner console (D-469, D-480).
 *
 * A brand's image is built from `apps/server` and its workspace dependencies, and its
 * browser bundles from `apps/console`, `apps/pos` and `apps/portal` and theirs. If any of
 * them, or any shared package they pull in, depended on a mother package or reached into
 * a mother app, the mother's code (and its words) would ship inside every brand. This
 * fails on either: a `@elysium/mother-*` dependency in a manifest, or an import of one, or
 * a path into `apps/mother-*`, in any source file outside the mother's own folders.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOTHER_DIRS = ['apps/mother-server', 'apps/mother-console', 'packages/mother-shared'];
const SKIP = new Set(['node_modules', 'dist', 'build', '.next', '.output', '.turbo', '.wxt']);
const SOURCE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|json)$/;

function workspaces() {
  const found = [];
  for (const group of ['apps', 'packages']) {
    for (const name of readdirSync(path.join(ROOT, group))) {
      const dir = `${group}/${name}`;
      if (existsSync(path.join(ROOT, dir, 'package.json'))) found.push(dir);
    }
  }
  return found;
}

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      yield* files(path.join(dir, entry.name));
    } else if (SOURCE.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

const brandSide = workspaces().filter((dir) => !MOTHER_DIRS.includes(dir));

describe('nothing on the brand side depends on the owner console (D-480)', () => {
  it('finds the brand-side workspaces', () => {
    expect(brandSide).toEqual(
      expect.arrayContaining(['apps/server', 'apps/console', 'packages/ui', 'packages/db']),
    );
    expect(brandSide).not.toContain('apps/mother-server');
  });

  it.each(brandSide)('%s declares no mother package', (dir) => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, dir, 'package.json'), 'utf8'));
    const names = Object.keys({
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
    });
    expect(names.filter((name) => name.startsWith('@elysium/mother-'))).toEqual([]);
  });

  it.each(brandSide)('%s imports nothing from a mother package or app', (dir) => {
    const offenders = [];
    for (const file of files(path.join(ROOT, dir))) {
      if (!statSync(file).isFile()) continue;
      const text = readFileSync(file, 'utf8');
      if (/@elysium\/mother-/.test(text) || /apps\/mother-(server|console)/.test(text)) {
        offenders.push(path.relative(ROOT, file).replace(/\\/g, '/'));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps the mother packages to the mother apps', () => {
    for (const dir of MOTHER_DIRS) {
      expect(existsSync(path.join(ROOT, dir, 'package.json')), dir).toBe(true);
    }
  });
});

/**
 * Check 5 (M32): no request from a brand's server, worker or browser goes to the owner
 * console. The brand's outbound hosts are fixed here: every absolute URL in the brand-side
 * source (tests aside) is a known third party, an example or a local address. A new one
 * fails this list until somebody adds it on purpose, and no entry is the mother's.
 */
const BRAND_SOURCES = [
  'apps/server/src',
  'packages/integrations/src',
  'apps/console/src',
  'apps/pos/src',
  'apps/portal/src',
];

const KNOWN_HOSTS = new Set([
  // Third parties the brand calls (couriers, SMS, Meta, Turnstile) — D-012, D-200, D-257.
  'https://api-hermes.pathao.com',
  'https://courier-api-sandbox.pathao.com',
  'https://openapi.redx.com.bd',
  'https://portal.packzy.com',
  'https://bulksmsbd.net',
  'https://graph.facebook.com',
  'https://challenges.cloudflare.com',
  // The website's payment gateway (SSLCommerz, D-523), Google Analytics' Measurement Protocol
  // (M35b, D-545) and ncom.bd's connector (D-553).
  'https://sandbox.sslcommerz.com',
  'https://securepay.sslcommerz.com',
  'https://www.google-analytics.com',
  'https://ncom.bd',
  // The owner's own phone service (M47, D-830): a brand's Envo connection, named in Settings →
  // Calls' own words (an example base URL, and "must start with https://.").
  'https://envo.enfinito.cloud',
  'https://.',
  // XML namespaces in the XLSX writer and the label sheet's SVG, never fetched.
  'http://schemas.openxmlformats.org',
  'http://www.w3.org',
  // Local, example and template prefixes.
  'http://0.0.0.0',
  'http://localhost',
  'https://localhost',
  'https://sandbox.gateway.example',
  'https://shop.example.com.',
  'http://oura-lifestyle.localhost',
  'http://preview-seed.localhost',
  'http://request.invalid',
  'http://camera.invalid',
  'https://erp.example.com',
  'https://console.',
  'https://orvo.',
  'https://oura-lifestyle.',
]);

describe('check 5: a brand calls no host but its own and its known third parties', () => {
  it('fixes the brand-side outbound host list', () => {
    const hosts = new Map();
    for (const dir of BRAND_SOURCES) {
      const absolute = path.join(ROOT, dir);
      if (!existsSync(absolute)) continue;
      for (const file of files(absolute)) {
        const relative = path.relative(ROOT, file).split(path.sep).join('/');
        if (/\.test\.|\.route-fixtures\.|\/testing\/|\/e2e\//.test(relative)) continue;
        if (!/\.(ts|tsx)$/.test(relative)) continue;
        for (const match of readFileSync(file, 'utf8').matchAll(/https?:\/\/[a-zA-Z0-9.-]+/g)) {
          if (!hosts.has(match[0])) hosts.set(match[0], relative);
        }
      }
    }
    const unknown = [...hosts].filter(([host]) => !KNOWN_HOSTS.has(host));
    expect(unknown, 'add a new outbound host here only on purpose').toEqual([]);
    expect([...hosts.keys()].some((host) => /mother/i.test(host))).toBe(false);
  });

  it('gives the brand server no setting that names the owner console', () => {
    const env = readFileSync(path.join(ROOT, 'apps/server/.env.example'), 'utf8');
    expect(env).not.toMatch(/MOTHER/i);
    const schema = readFileSync(path.join(ROOT, 'apps/server/src/platform/config/env.ts'), 'utf8');
    expect(schema).not.toMatch(/MOTHER/i);
  });
});
