import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeEach, describe, expect, it } from 'vitest';

/**
 * The i18n checker, tested against throwaway catalogues (English only, D-750).
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

/** A Bangla word, built from code points so this file carries no Bangla of its own. */
const BANGLA_WORD = [0x098f, 0x0995].map((code) => String.fromCodePoint(code)).join('');

describe('check-i18n', () => {
  it('passes an English catalogue whose every reference exists', () => {
    const result = fixtureWith({
      en: catalogue([['a.one', 'One']]),
      source: "import { t } from '@elysium/i18n';\nexport const label = t('a.one');\n",
    });
    expect(result.output).toContain('PASS');
    expect(result.output).toContain('1 locale(s) (en)');
    expect(result.code).toBe(0);
  });

  /*
   * D-750: the brands never wanted Bangla. A `bn.ts` brought back — by a merge from a branch
   * that still had one — fails, and so does a Bangla sentence typed into the English file.
   */
  it('fails on any catalogue but English, and on Bangla text in the English one', () => {
    const second = fixtureWith({
      en: catalogue([['a.one', 'One']]),
      bn: catalogue([['a.one', BANGLA_WORD]]),
    });
    expect(second.code).toBe(1);
    expect(second.output).toContain('is a "bn" catalogue');
    expect(second.output).toContain('English only (D-750)');

    fixture = mkdtempSync(path.join(tmpdir(), 'elysium-i18n-'));
    const typed = fixtureWith({
      en: catalogue([
        ['a.one', 'One'],
        ['a.two', `Two ${BANGLA_WORD}`],
      ]),
    });
    expect(typed.code).toBe(1);
    expect(typed.output).toContain('Bangla text in en: a.two');
  });

  it('allows the taka sign on a staff screen, which is a symbol and not Bangla (D-751)', () => {
    const result = fixtureWith({
      en: catalogue([['a.price', `Price (${String.fromCodePoint(0x09f3)})`]]),
    });
    expect(result.code).toBe(0);
  });

  it('fails when code names a key the catalogue does not have, and says where', () => {
    const result = fixtureWith({
      en: catalogue([['a.one', 'One']]),
      source: "export const label = t('a.typo');\n",
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('no such key "a.typo"');
    expect(result.output).toContain('screen.ts:1');
  });

  /*
   * The one a reviewer misses: a duplicated key compiles, imports cleanly, and
   * quietly drops the first value. Only a text read of the file finds it.
   */
  it('fails when a catalogue names the same key twice', () => {
    const result = fixtureWith({
      en: `const c = {
  'a.one': 'One',
  'a.one': 'Uno',
};
export default c;
`,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('duplicate key "a.one" in en');
  });

  /*
   * Section catalogues (M38a, D-607): `sections/<area>.en.ts` join the catalogue, so a key
   * used from code may live there, and may not repeat a key the locale file already has. A
   * section in another language is refused like a locale file.
   */
  it('reads section catalogues as part of the catalogue', () => {
    mkdirSync(path.join(fixture, 'locales/sections'), { recursive: true });
    writeFileSync(
      path.join(fixture, 'locales/sections/area.en.ts'),
      catalogue([['s.one', 'Section one']]).replace('as LOCALE', 'as en'),
      'utf8',
    );
    const passing = fixtureWith({
      en: catalogue([['a.one', 'One']]),
      source: "export const label = t('s.one') + t('a.one');\n",
    });
    expect(passing.output).toContain('PASS');
    expect(passing.code).toBe(0);

    fixture = mkdtempSync(path.join(tmpdir(), 'elysium-i18n-'));
    mkdirSync(path.join(fixture, 'locales/sections'), { recursive: true });
    writeFileSync(
      path.join(fixture, 'locales/sections/area.en.ts'),
      catalogue([['a.one', 'One again']]).replace('as LOCALE', 'as en'),
      'utf8',
    );
    writeFileSync(
      path.join(fixture, 'locales/sections/area.bn.ts'),
      catalogue([['s.one', BANGLA_WORD]]).replace('as LOCALE', 'as bn'),
      'utf8',
    );
    const failing = fixtureWith({ en: catalogue([['a.one', 'One']]) });
    expect(failing.code).toBe(1);
    expect(failing.output).toContain('duplicate key "a.one" in en');
    expect(failing.output).toContain('area.bn.ts is a "bn" catalogue');
  });

  it('fails rather than passing vacuously when there is no English catalogue', () => {
    const result = fixtureWith({ bn: catalogue([['a.one', BANGLA_WORD]]) });
    expect(result.code).toBe(1);
    expect(result.output).toContain('this product ships English (D-750)');
  });

  it('ignores a dynamic key instead of guessing, and reports that it did', () => {
    const result = fixtureWith({
      en: catalogue([['a.one', 'One']]),
      source: 'export const label = (key: string) => t(key);\n',
    });
    expect(result.code).toBe(0);
    expect(result.output).toContain('1 dynamic reference');
  });

  /*
   * A key built out of a status — `t(`a.status.${row.status}`)` — used to be read
   * as a literal key named `a.status.${row.status}`, which no catalogue can have,
   * so a whole surface of them failed the gate for no reason. The useful check is
   * on the text around the hole, because the call sites cast to the key type and
   * a misspelt prefix is therefore invisible to the compiler too.
   */
  it('resolves an interpolated key against the family it names', () => {
    const result = fixtureWith({
      en: catalogue([['a.status.open', 'Open']]),
      source: 'export const label = (row) => t(`a.status.${row.status}`);\n',
    });
    expect(result.output).toContain('1 interpolated famil');
    expect(result.code).toBe(0);
  });

  it('fails when an interpolated key names a family the catalogue has none of', () => {
    const result = fixtureWith({
      en: catalogue([['a.status.open', 'Open']]),
      source: 'export const label = (row) => t(`a.statsu.${row.status}`);\n',
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain('no key matches "a.statsu.${row.status}"');
    expect(result.output).toContain('screen.ts:1');
  });

  it('passes on this repository, which is the gate pnpm verify runs', () => {
    const result = run('--quiet');
    expect(result.output).toBe('');
    expect(result.code).toBe(0);
  });
});
