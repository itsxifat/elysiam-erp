import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { checkWhiteLabel, findHits } from './check-white-label.mjs';

/** The white-label check (M31 check 3, D-472), against fixture trees. */

let root;

function tree(files) {
  root = mkdtempSync(path.join(tmpdir(), 'white-label-'));
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(root, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return root;
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('findHits', () => {
  it('finds the product name anywhere, in any case, and in Bangla', () => {
    expect(findHits('var a=`ELYSIUM-theme`', 'x').map((hit) => hit.name)).toEqual(['elysium']);
    expect(findHits('"x-elysium-csrf"', 'x')).toHaveLength(1);
    expect(findHits('Elysiam Lifestyle', 'x').map((hit) => hit.name)).toEqual(['elysiam']);
    expect(findHits("'এলিসিয়াম কনসোল'", 'x').map((hit) => hit.name)).toEqual(['elysium (bn)']);
  });

  it('finds the other brands as words only', () => {
    expect(findHits('Oura Lifestyle', 'x').map((hit) => hit.name)).toEqual(['oura']);
    expect(findHits('Wear X Clothing and wearx', 'x')).toHaveLength(2);
    expect(findHits('Beownz, Orvo', 'x')).toHaveLength(2);
    // "encourage" and "courage" carry the letters, not the name.
    expect(findHits('We encourage courage in the orvoid', 'x')).toEqual([]);
  });
});

describe('checkWhiteLabel', () => {
  it('passes a clean build', () => {
    tree({
      'dist/index.html': '<title>Console</title>',
      'dist/assets/app.js': 'const k=`erp-theme`;',
      'locales/en.ts': "'workspace.title': 'Console',",
    });
    const result = checkWhiteLabel({ root, dists: ['dist'], sources: ['locales/en.ts'] });
    expect(result).toMatchObject({ hits: [], problems: [] });
    expect(result.scanned).toBe(3);
  });

  it('fails on a name in a script, a stylesheet, a manifest, a file name or a locale', () => {
    tree({
      'dist/assets/app.js': 'x=`elysium_csrf`',
      'dist/assets/app.css': '@keyframes elysium-in{}',
      'dist/manifest.webmanifest': '{"name":"Oura POS"}',
      'dist/assets/elysium-logo.png': 'binary',
      'locales/bn.ts': "'pos.app.name': 'এলিজিয়াম পিওএস',",
    });
    const { hits } = checkWhiteLabel({ root, dists: ['dist'], sources: ['locales/bn.ts'] });
    expect(hits.map((hit) => hit.file).sort()).toEqual([
      'dist/assets/app.css',
      'dist/assets/app.js',
      'dist/assets/elysium-logo.png (file name)',
      'dist/manifest.webmanifest',
      'locales/bn.ts',
    ]);
  });

  it('fails on a published source map and on a dist that was never built', () => {
    tree({ 'dist/assets/app.js': '', 'dist/assets/app.js.map': '{}' });
    const { problems } = checkWhiteLabel({ root, dists: ['dist', 'missing'], sources: [] });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('source map');
    expect(problems[1]).toContain('missing');
  });
});
