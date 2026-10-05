#!/usr/bin/env node
/**
 * The white-label check (M31 check 3, D-472).
 *
 * Every brand runs its own copy of this ERP, and nothing a brand's staff, shoppers or
 * website developer can see may name another brand, or this product's origin. A brand's
 * own name comes from its `org.organizations` row at runtime; the shipped files carry none.
 *
 * So this reads what actually ships to a browser — the built console, till and portal
 * (`apps/{console,pos,portal}/dist`: scripts, styles, pages, manifests) — and the shared
 * locale files, and fails on any of the brand names or the product's old name:
 *
 *   elysium (anywhere, any case, and its Bangla spellings), oura, orvo, wear x / wearx,
 *   beownz (as words)
 *
 * It also fails on a source map in a dist: a map carries the original source, package
 * names and comments included, to anyone who opens the browser's tools.
 *
 * Internal names that never reach a browser (the `@elysium/*` packages, Nest symbols, the
 * HMAC derivation labels) are out of its reach on purpose: the bundler resolves the
 * package names away, and the rest live only on the server.
 *
 * Usage:
 *   node scripts/check-white-label.mjs                 the three dists and the locales
 *   node scripts/check-white-label.mjs --root <dir> --dist <dir> [--dist <dir>] [--source <file>]
 *
 * Run after a build: a missing dist is a failure, not a pass, because a check that cannot
 * see the bundle proves nothing.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const DEFAULT_DISTS = ['apps/console/dist', 'apps/pos/dist', 'apps/portal/dist'];
export const DEFAULT_SOURCES = [
  'packages/i18n/src/locales/en.ts',
  'packages/i18n/src/locales/bn.ts',
];

/** What a browser downloads. Images and fonts carry no text worth scanning. */
const SCANNED = new Set([
  '.js',
  '.mjs',
  '.css',
  '.html',
  '.htm',
  '.json',
  '.webmanifest',
  '.txt',
  '.svg',
  '.xml',
]);

/**
 * The names, each with the reason it is a word match or not. `elysium` is matched
 * anywhere (no English word contains it); the others as whole words, because `oura` is
 * inside "encourage" and "courage".
 */
export const BANNED = [
  { name: 'elysium', pattern: /elysium/gi },
  // The Bangla catalogue once spelled it out; both spellings it used.
  { name: 'elysium (bn)', pattern: /এলি[সজ]িয়াম/g },
  { name: 'oura', pattern: /\boura\b/gi },
  { name: 'orvo', pattern: /\borvo\b/gi },
  { name: 'wear x', pattern: /\bwear ?x\b/gi },
  { name: 'beownz', pattern: /\bbeownz\b/gi },
];

/** Every hit in one text, with its line and a short excerpt around it. */
export function findHits(text, file) {
  const hits = [];
  for (const { name, pattern } of BANNED) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const before = text.lastIndexOf('\n', match.index);
      const line = text.slice(0, match.index).split('\n').length;
      const start = Math.max(match.index - 40, before + 1);
      const excerpt = text
        .slice(start, match.index + match[0].length + 40)
        .replace(/\s+/g, ' ')
        .trim();
      hits.push({ file, line, name, excerpt });
    }
  }
  return hits;
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/** The whole check, as data, so a test can drive it against a fixture tree. */
export function checkWhiteLabel({
  root = REPO_ROOT,
  dists = DEFAULT_DISTS,
  sources = DEFAULT_SOURCES,
} = {}) {
  const problems = [];
  const hits = [];
  let scanned = 0;

  for (const dist of dists) {
    const dir = path.resolve(root, dist);
    if (!existsSync(dir)) {
      problems.push(`${dist}: missing. Build first (pnpm build); the check reads the built files.`);
      continue;
    }
    for (const file of walk(dir)) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      if (file.endsWith('.map')) {
        problems.push(
          `${relative}: a source map ships with the build; production builds publish none.`,
        );
        continue;
      }
      // The name of a file is downloaded too.
      hits.push(...findHits(path.basename(file), `${relative} (file name)`));
      if (!SCANNED.has(path.extname(file).toLowerCase())) continue;
      scanned += 1;
      hits.push(...findHits(readFileSync(file, 'utf8'), relative));
    }
  }

  for (const source of sources) {
    const file = path.resolve(root, source);
    if (!existsSync(file)) {
      problems.push(`${source}: missing.`);
      continue;
    }
    scanned += 1;
    hits.push(...findHits(readFileSync(file, 'utf8'), source));
  }

  return { scanned, hits, problems };
}

function argumentsOf(argv) {
  const dists = [];
  const sources = [];
  let root;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--dist' && value !== undefined) dists.push(value);
    else if (flag === '--source' && value !== undefined) sources.push(value);
    else if (flag === '--root' && value !== undefined) root = value;
    else continue;
    index += 1;
  }
  return {
    ...(root === undefined ? {} : { root: path.resolve(root) }),
    ...(dists.length === 0 ? {} : { dists }),
    ...(dists.length === 0 && sources.length === 0 ? {} : { sources }),
  };
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && path.resolve(entrypoint) === fileURLToPath(import.meta.url)) {
  const { scanned, hits, problems } = checkWhiteLabel(argumentsOf(process.argv.slice(2)));
  for (const problem of problems) process.stderr.write(`check-white-label: ${problem}\n`);
  for (const hit of hits.slice(0, 200)) {
    process.stderr.write(
      `check-white-label: ${hit.file}:${String(hit.line)} names "${hit.name}": …${hit.excerpt}…\n`,
    );
  }
  if (hits.length > 200)
    process.stderr.write(`check-white-label: … and ${String(hits.length - 200)} more\n`);
  if (problems.length > 0 || hits.length > 0) {
    process.stderr.write(
      `check-white-label: ${String(hits.length)} hit(s), ${String(problems.length)} problem(s) in ${String(scanned)} file(s). FAIL\n`,
    );
    process.exit(1);
  }
  process.stdout.write(
    `check-white-label: ${String(scanned)} file(s), no brand or product name. PASS\n`,
  );
}
