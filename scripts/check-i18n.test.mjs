import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The missing-key checker, tested against throwaway catalogues.
 *
 * A checker that has only ever been run against a repository that passes is a
 * checker nobody has seen fail. Each case below is a failure the real thing has
 * to catch — and the last case runs it against this repository, so the gate in
 * `pnpm verify` is proven to be satisfiable as well as strict.
 *
 * check-i18n:ignore-file — the key names below are fixtures that must NOT
 * exist, so the checker has to skip this file or it fails on its own tests.
 */

const SCRIPT = fileURLToPath(new URL('./check-i18n.mjs', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

let fixture;

function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

/** Write a catalogue and a source file, then check that pair and nothing else. */
function fixtureWith({ en, bn, source = '' }) {
  mkdirSync(path.join(fixture, 'locales'), { recursive: true });
  mkdirSync(path.join(fixture, 'src'), { recursive: true });
  if (en !== undefined) writeFileSync(path.join(fixture, 'locales/en.ts'), en, 'utf8');
  if (bn !== undefined) writeFileSync(path.join(fixture, 'locales/bn.ts'), bn, 'utf8');
  writeFileSync(path.join(fixture, 'src/screen.ts'), source, 'utf8');
  return run('--catalogue', path.join(fixture, 'locales'), '--scan', path.join(fixture, 'src'));
}

const catalogue = (entries) =>
  `const c = {\n${entries.map(([key, value]) => `  '${key}': '${value}',\n`).join('')}} as const;\nexport { c as LOCALE };\nexport default c;\n`;

beforeEach(() => {
  // A fresh directory per case: the script imports the catalogue files, and
  // Node's module cache would otherwise serve the previous case's version.
  fixture = mkdtempSync(path.join(tmpdir(), 'elysium-i18n-'));
});

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('check-i18n', () => {
  it('passes when both locales have the same keys and every reference exists', () => {
    const result = fixtureWith({
      en: catalogue([['a.one', 'One']]),
      bn: catalogue([['a.one', 'এক']]),
      source: "import { t } from '@elysium/i18n';\nexport const label = t('a.one');\n",
    });
    expect(result.output).toContain('PASS');
    expect(result.code).toBe(0);
  });

  it('fails when a key exists in one locale and not the other, in either direction', () => {
    const missingFromBn = fixtureWith({
      en: catalogue([
        ['a.one', 'One'],
        ['a.two', 'Two'],
      ]),
      bn: catalogue([['a.one', 'এক']]),
    });
    expect(missingFromBn.code).toBe(1);
    expect(missingFromBn.output).toContain('missing from bn: a.two');

    fixture = mkdtempSync(path.join(tmpdir(), 'elysium-i18n-'));
    const missingFromEn = fixtureWith({
      en: catalogue([['a.one', 'One']]),
      bn: catalogue([
        ['a.one', 'এক'],
        ['a.two', 'দুই'],
      ]),
    });
    expect(missingFromEn.code).toBe(1);
    expect(missingFromEn.output).toContain('missing from en: a.two');
  });

  it('fails when code names a key the catalogue does not have, and says where', () => {
    const result = fixtureWith({
      en: catalogue([['a.one', 'One']]),
      bn: catalogue([['a.one', 'এক']]),
      source: "export const label = t('a.typo');\n",
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('no such key "a.typo"');
    expect(result.output).toContain('screen.ts:1');
  });

  /*
   * The one a reviewer misses: a duplicated key compiles, imports cleanly, and
   * quietly drops the first translation. Only a text read of the file finds it.
   */
  it('fails when a catalogue names the same key twice', () => {
    const result = fixtureWith({
      en: catalogue([['a.one', 'One']]),
      bn: `const c = {\n  'a.one': 'এক',\n  'a.one': 'একক',\n};\nexport default c;\n`,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('duplicate key "a.one" in bn');
  });

  it('fails rather than passing vacuously when a locale is missing entirely', () => {
    const result = fixtureWith({ en: catalogue([['a.one', 'One']]) });
    expect(result.code).toBe(1);
    expect(result.output).toContain('this product ships bn and en');
  });

  it('ignores a dynamic key instead of guessing, and reports that it did', () => {
    const result = fixtureWith({
      en: catalogue([['a.one', 'One']]),
      bn: catalogue([['a.one', 'এক']]),
      source: 'export const label = (key: string) => t(key);\n',
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain('1 dynamic reference');
  });

  it('passes on this repository, which is the gate pnpm verify runs', () => {
    const result = run('--quiet');
    expect(result.output).toBe('');
    expect(result.code).toBe(0);
  });
});
