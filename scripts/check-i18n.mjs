#!/usr/bin/env node
/**
 * The i18n missing-key check (M04 acceptance check 6, second half).
 *
 * Three failures, all of which have shipped in other systems and none of which
 * the TypeScript compiler can catch on its own:
 *
 * 1. **A key in one locale and not the other.** `packages/i18n` types Bangla as
 *    `Record<MessageKey, string>`, so today this is also a compile error — but
 *    that guarantee lasts exactly as long as nobody widens the type, and the
 *    consequence is a customer-facing invoice with an English word on it
 *    (D-036).
 * 2. **A key referenced from code that the catalogue does not have.** `t()` is
 *    typed, so a `.ts` call site is safe. Keys do not only come from typed call
 *    sites: a PDF template, an SMS body, a Puck block, a seed file and a JSON
 *    config all name keys as plain strings. Those fail at render time, in front
 *    of whoever the document was for.
 * 3. **The same key twice in one catalogue.** An object literal silently keeps
 *    the last value, so the first translation disappears with no error
 *    anywhere. This is the one a reviewer is least likely to spot, which is why
 *    the check reads the files as text as well as importing them.
 *
 * Keys the catalogue has but nothing references are *reported, not failed*: a
 * milestone that lands strings a screen later is normal, and failing on it
 * would teach people to delete strings instead of using them.
 *
 * The catalogues are imported rather than parsed — Node strips the types — so
 * the authority on what keys exist is the same module the application loads,
 * not a regex's opinion of it.
 *
 * Usage:
 *   node scripts/check-i18n.mjs
 *   node scripts/check-i18n.mjs --catalogue <dir> --scan <dir> [--scan <dir>]
 *   node scripts/check-i18n.mjs --quiet
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_CATALOGUE = 'packages/i18n/src/locales';
const DEFAULT_SCAN = ['apps', 'packages', 'scripts'];

/** Where a key can be named. `.html` and `.hbs` cover the §22 document templates. */
const SCANNED = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.html', '.hbs']);
const SKIPPED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.output',
  '.turbo',
  '.git',
]);

/**
 * A key reference in source.
 *
 * `t('auth.title')`, `t("auth.title")` and `` t(`auth.title`) `` — a leading
 * word boundary so `expect(`, `it(` and `format(` do not match, and a bare
 * `t(variable)` is skipped rather than guessed at. Dynamic keys are counted and
 * reported so that a surface built entirely out of computed keys is visible
 * rather than silently unchecked.
 */
const LITERAL_KEY = /\bt\(\s*(['"`])([^'"`\n]+)\1/g;
const DYNAMIC_KEY = /\bt\(\s*[A-Za-z_$][\w$.[\]]*\s*[,)]/g;

/**
 * A file that names keys on purpose which must not exist — this checker's own
 * fixtures, and nothing else so far.
 *
 * The marker is a comment a reviewer reads in the diff, rather than a path list
 * in this script that the excused file never mentions. Without it the checker
 * fails on its own test file, and the tempting fix — dropping `scripts/` from
 * the scan — would stop checking the seed and document scripts that
 * legitimately name keys. Assembled from two pieces so that this line is not
 * itself the marker.
 */
const IGNORE_MARKER = `check-i18n${':'}ignore-file`;

function parseArgs(argv) {
  const scan = [];
  let catalogue = null;
  let quiet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--catalogue') catalogue = argv[(index += 1)] ?? null;
    else if (arg === '--scan') scan.push(argv[(index += 1)] ?? '');
    else if (arg === '--quiet') quiet = true;
    else throw new Error(`check-i18n: unknown argument "${arg}"`);
  }

  return {
    catalogue: catalogue ?? path.join(REPO_ROOT, DEFAULT_CATALOGUE),
    scan: (scan.length > 0 ? scan : DEFAULT_SCAN.map((dir) => path.join(REPO_ROOT, dir))).filter(
      Boolean,
    ),
    quiet,
  };
}

function exists(target) {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false;
  }
}

/** Every catalogue file in the directory: `en.ts`, `bn.ts`, and any locale added later. */
function catalogueFiles(directory) {
  return readdirSync(directory)
    .filter((name) => /\.(ts|mts|js|mjs)$/.test(name) && !/\.test\./.test(name))
    .sort()
    .map((name) => ({ locale: name.replace(/\.[^.]+$/, ''), file: path.join(directory, name) }));
}

/**
 * The exported catalogue object.
 *
 * Named export first (`export { bn }`), then default. Anything else is a file
 * whose shape this check cannot vouch for, and saying so is better than
 * silently treating it as an empty catalogue — an empty catalogue passes every
 * comparison, which is the worst possible failure for a checker.
 */
function catalogueOf(module, locale, file) {
  const candidate = module[locale] ?? module.default;
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error(`check-i18n: ${file} exports no "${locale}" or default catalogue object.`);
  }
  const wrong = Object.entries(candidate).filter(([, value]) => typeof value !== 'string');
  if (wrong.length > 0) {
    throw new Error(
      `check-i18n: ${file} maps ${wrong.length} key(s) to something other than a string: ` +
        wrong
          .slice(0, 5)
          .map(([key]) => key)
          .join(', '),
    );
  }
  return candidate;
}

/**
 * Keys written twice in one file.
 *
 * Text, not AST: the imported object has already lost the duplicate. Key lines
 * are indented two spaces and end in `':`, which every catalogue in this repo
 * follows; a continuation line of a wrapped string value is indented four, so
 * it cannot be mistaken for a key.
 */
function duplicateKeysIn(file) {
  const source = readFileSync(file, 'utf8');
  const seen = new Map();
  const duplicates = [];

  source.split('\n').forEach((line, index) => {
    const match = /^ {2}'((?:[^'\\]|\\.)+)':/.exec(line);
    if (match === null) return;
    const key = match[1];
    const first = seen.get(key);
    if (first === undefined) seen.set(key, index + 1);
    else duplicates.push({ key, first, again: index + 1 });
  });

  return { duplicates, counted: seen.size };
}

function* walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      yield* walk(path.join(directory, entry.name));
    } else if (SCANNED.has(path.extname(entry.name))) {
      yield path.join(directory, entry.name);
    }
  }
}

/** Every literal key reference, and a count of the dynamic ones. */
function references({ scan, catalogueDir }) {
  const found = new Map();
  let dynamic = 0;

  for (const root of scan) {
    if (!exists(root)) continue;
    for (const file of walk(root)) {
      // The catalogues name every key by definition; counting them as
      // references would make every key look used and hide nothing but bugs.
      if (file.startsWith(catalogueDir)) continue;

      const source = readFileSync(file, 'utf8');
      if (source.includes(IGNORE_MARKER)) continue;
      dynamic += (source.match(DYNAMIC_KEY) ?? []).length;

      for (const match of source.matchAll(LITERAL_KEY)) {
        const key = match[2];
        const line = source.slice(0, match.index).split('\n').length;
        const where = `${path.relative(REPO_ROOT, file).replace(/\\/g, '/')}:${line}`;
        const sites = found.get(key);
        if (sites === undefined) found.set(key, [where]);
        else sites.push(where);
      }
    }
  }

  return { found, dynamic };
}

async function main() {
  const { catalogue: catalogueDir, scan, quiet } = parseArgs(process.argv.slice(2));

  if (!exists(catalogueDir)) {
    console.error(`check-i18n: FAIL — no catalogue directory at ${catalogueDir}`);
    return 1;
  }

  const files = catalogueFiles(catalogueDir);
  if (files.length < 2) {
    console.error(
      `check-i18n: FAIL — found ${files.length} catalogue file(s) in ${catalogueDir}; ` +
        'this product ships bn and en (D-036).',
    );
    return 1;
  }

  const failures = [];
  const catalogues = new Map();

  for (const { locale, file } of files) {
    const module = await import(`file://${file.replace(/\\/g, '/')}`);
    catalogues.set(locale, catalogueOf(module, locale, file));

    const { duplicates } = duplicateKeysIn(file);
    for (const { key, first, again } of duplicates) {
      failures.push(
        `duplicate key "${key}" in ${locale}: line ${first} and line ${again} — ` +
          'the later value silently wins, so the earlier translation is lost.',
      );
    }
  }

  const union = new Set();
  for (const catalogue of catalogues.values()) {
    for (const key of Object.keys(catalogue)) union.add(key);
  }

  for (const [locale, catalogue] of catalogues) {
    for (const key of union) {
      if (!(key in catalogue)) failures.push(`missing from ${locale}: ${key}`);
    }
  }

  const { found, dynamic } = references({ scan, catalogueDir });
  for (const [key, sites] of found) {
    if (union.has(key)) continue;
    failures.push(`no such key "${key}" — referenced at ${sites.slice(0, 3).join(', ')}`);
  }

  if (failures.length > 0) {
    console.error(`check-i18n: FAIL — ${failures.length} problem(s)\n`);
    for (const failure of failures) console.error(`  ${failure}`);
    console.error(
      '\nEvery string goes through packages/i18n in both bn and en (CLAUDE.md, D-036).\n' +
        'Add the key to every catalogue, or fix the reference.',
    );
    return 1;
  }

  if (!quiet) {
    const orphans = [...union].filter((key) => !found.has(key)).sort();
    const locales = [...catalogues.keys()].join(', ');
    console.log(
      `check-i18n: ${union.size} key(s) in ${catalogues.size} locale(s) (${locales}); ` +
        `${found.size} referenced, ${dynamic} dynamic reference(s). PASS`,
    );
    if (orphans.length > 0) {
      console.log(
        `check-i18n: ${orphans.length} key(s) nothing references yet — fine for a key that ` +
          'lands before its screen, worth deleting otherwise:',
      );
      console.log(`  ${orphans.join(', ')}`);
    }
  }

  return 0;
}

process.exit(await main());
