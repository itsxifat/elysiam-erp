#!/usr/bin/env node
/**
 * The console's initial-route bundle budget (M05 acceptance check 5).
 *
 * What a user downloads before the first screen can render: the entry script, every
 * chunk the build tells the browser to preload, and the stylesheets `index.html`
 * links. Gzipped, because that is what crosses the wire, and summed, because the
 * browser needs all of them. Route chunks loaded later by `lazyRouteComponent` are
 * not counted: they are the point of splitting.
 *
 * Fonts are reported and not counted. They are already compressed (woff2), they
 * load in parallel with the script, and a budget that a font swap can blow teaches
 * people to ship worse typography.
 *
 * Usage:
 *   node scripts/check-bundle.mjs                 # apps/console/dist, 250 KB
 *   node scripts/check-bundle.mjs --dist <dir> --budget-kb <n>
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every asset `index.html` makes the browser fetch up front, in document order. */
export function initialAssets(html) {
  const found = [];
  const tag = /<(script|link)\b([^>]*)>/gi;
  for (const match of html.matchAll(tag)) {
    const attributes = match[2] ?? '';
    const attr = (name) => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attributes)?.[1];
    if (match[1]?.toLowerCase() === 'script') {
      const src = attr('src');
      if (src !== undefined && attr('type') === 'module') found.push(src);
      continue;
    }
    const rel = attr('rel')?.toLowerCase();
    const href = attr('href');
    if (href !== undefined && (rel === 'modulepreload' || rel === 'stylesheet')) found.push(href);
  }
  return [...new Set(found)].filter((href) => !/^https?:\/\//.test(href));
}

export function measure(dist) {
  const html = readFileSync(path.join(dist, 'index.html'), 'utf8');
  const assets = initialAssets(html).map((href) => {
    const file = path.join(dist, href.replace(/^\//, ''));
    const bytes = readFileSync(file);
    return { href, raw: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length };
  });
  const fontDir = path.join(dist, 'assets');
  const fonts = existsSync(fontDir)
    ? readdirSync(fontDir).filter((name) => name.endsWith('.woff2')).length
    : 0;
  return {
    assets,
    total: assets.reduce((sum, asset) => sum + asset.gzip, 0),
    fonts,
  };
}

function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
  };
  const dist = path.resolve(REPO_ROOT, option('--dist', 'apps/console/dist'));
  const budget = Number(option('--budget-kb', '250')) * 1000;

  if (!existsSync(path.join(dist, 'index.html'))) {
    console.error(`check-bundle: ${dist}/index.html is missing. Build the console first.`);
    process.exit(1);
  }
  const { assets, total, fonts } = measure(dist);
  const kb = (bytes) => `${(bytes / 1000).toFixed(1)} KB`;
  for (const asset of assets) {
    console.log(
      `  ${kb(asset.gzip).padStart(9)} gzip  ${kb(asset.raw).padStart(9)} raw  ${asset.href}`,
    );
  }
  console.log(
    `check-bundle: initial route ${kb(total)} gzipped across ${String(assets.length)} file(s); ` +
      `budget ${kb(budget)}. ${String(fonts)} woff2 font file(s) not counted.`,
  );
  if (total > budget) {
    console.error('check-bundle: FAIL. Lazy-load a route or a dependency before adding more.');
    process.exit(1);
  }
  console.log('check-bundle: PASS');
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
