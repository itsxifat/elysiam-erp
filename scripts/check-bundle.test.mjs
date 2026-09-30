import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { initialAssets, measure } from './check-bundle.mjs';

describe('the initial-route bundle check (M05 check 5)', () => {
  it('counts the entry, its preloads and stylesheets, and nothing lazy or remote', () => {
    const html = `<!doctype html><html><head>
      <script type="module" crossorigin src="/assets/index-a.js"></script>
      <link rel="modulepreload" crossorigin href="/assets/vendor-b.js">
      <link rel="stylesheet" crossorigin href="/assets/index-c.css">
      <link rel="icon" href="/favicon.svg">
      <link rel="stylesheet" href="https://fonts.example/remote.css">
      <script src="/legacy.js"></script>
    </head></html>`;
    expect(initialAssets(html)).toEqual([
      '/assets/index-a.js',
      '/assets/vendor-b.js',
      '/assets/index-c.css',
    ]);
  });

  it('sums gzipped sizes, so a budget is judged on what crosses the wire', () => {
    const dist = mkdtempSync(path.join(tmpdir(), 'bundle-'));
    mkdirSync(path.join(dist, 'assets'));
    writeFileSync(
      path.join(dist, 'index.html'),
      '<script type="module" src="/assets/a.js"></script><link rel="stylesheet" href="/assets/b.css">',
    );
    writeFileSync(path.join(dist, 'assets', 'a.js'), 'x'.repeat(10_000));
    writeFileSync(path.join(dist, 'assets', 'b.css'), 'y'.repeat(5_000));
    writeFileSync(path.join(dist, 'assets', 'lazy.js'), 'z'.repeat(50_000));

    const result = measure(dist);
    expect(result.assets.map((asset) => asset.href)).toEqual(['/assets/a.js', '/assets/b.css']);
    expect(result.assets[0]?.raw).toBe(10_000);
    // Highly repetitive input compresses to a small fraction of itself.
    expect(result.total).toBeLessThan(1_000);
    expect(result.total).toBe(result.assets.reduce((sum, asset) => sum + asset.gzip, 0));
  });
});
