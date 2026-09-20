#!/usr/bin/env node
/**
 * Vendor the two fonts and compute the size-adjust that puts them on one baseline.
 *
 * This product renders Bangla and Latin in the same sentence constantly: a
 * Bangla product name beside a Latin SKU, a Bangla status beside a taka figure.
 * Inter and Hind Siliguri have different x-height-to-em ratios, so at the same
 * `font-size` the Bangla runs visibly larger and the line looks ragged. Setting
 * `size-adjust` on the Bangla face to match Inter's x-height ratio fixes it.
 *
 * The value is computed here from each font's real metrics (`head.unitsPerEm`
 * and `OS/2.sxHeight`) rather than eyeballed, and the derivation is written into
 * the generated CSS. Re-run this if either font is updated.
 *
 * Fonts are vendored into the repo so a build never depends on a CDN, and so
 * the app does not leak a viewer's IP to a third party on first paint.
 *
 * Usage: pnpm fonts:fetch [--force]
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FONT_DIR = path.join(REPO_ROOT, 'packages/ui/src/assets/fonts');
const CSS_FILE = path.join(REPO_ROOT, 'packages/ui/src/styles/fonts.css');

const MODERN_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const LEGACY_UA = 'Mozilla/4.0';

const FAMILIES = [
  {
    id: 'inter',
    family: 'Inter',
    query: 'Inter:wght@400..700',
    subsets: ['latin', 'latin-ext'],
    // The reference face. Everything else is matched to its x-height.
    reference: true,
  },
  {
    id: 'hind-siliguri',
    family: 'Hind Siliguri',
    query: 'Hind+Siliguri:wght@400;500;600;700',
    subsets: ['bengali', 'latin'],
    reference: false,
  },
];

const force = process.argv.includes('--force');

async function googleFontsCss(query, userAgent) {
  const url = `https://fonts.googleapis.com/css2?family=${query}&display=swap`;
  const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
  if (!response.ok) throw new Error(`Google Fonts returned ${response.status} for ${query}`);
  return response.text();
}

/** Pair each `@font-face` with the subset comment above it. */
function parseFaces(css) {
  const faces = [];
  let subset = 'unknown';

  for (const chunk of css.split('@font-face')) {
    const comment = /\/\*\s*([\w-]+)\s*\*\//.exec(chunk);
    const url = /url\((https:[^)]+)\)/.exec(chunk);
    const weight = /font-weight:\s*([\d\s]+);/.exec(chunk);
    const range = /unicode-range:\s*([^;]+);/.exec(chunk);

    if (url && range) {
      faces.push({
        subset,
        url: url[1] ?? '',
        weight: (weight?.[1] ?? '400').trim(),
        unicodeRange: (range[1] ?? '').trim(),
      });
    }

    if (comment) subset = comment[1] ?? 'unknown';
  }

  return faces;
}

function readTable(buffer, tag) {
  const numTables = buffer.readUInt16BE(4);
  for (let i = 0; i < numTables; i += 1) {
    const entry = 12 + i * 16;
    if (buffer.toString('ascii', entry, entry + 4) === tag) {
      const offset = buffer.readUInt32BE(entry + 8);
      const length = buffer.readUInt32BE(entry + 12);
      return buffer.subarray(offset, offset + length);
    }
  }
  return null;
}

/**
 * x-height as a fraction of the em square, read from the font itself.
 *
 * Measured from the TrueType build because woff2 brotli-compresses its table
 * data; the two builds share the same metrics.
 */
function xHeightRatio(ttf) {
  const head = readTable(ttf, 'head');
  const os2 = readTable(ttf, 'OS/2');
  if (head === null || os2 === null) throw new Error('font is missing head or OS/2');

  const unitsPerEm = head.readUInt16BE(18);
  const version = os2.readUInt16BE(0);
  if (version < 2) throw new Error(`OS/2 version ${version} has no sxHeight`);

  const sxHeight = os2.readInt16BE(86);
  return { unitsPerEm, sxHeight, ratio: sxHeight / unitsPerEm };
}

async function download(url) {
  const response = await fetch(url, { headers: { 'User-Agent': MODERN_UA } });
  if (!response.ok) throw new Error(`download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function main() {
  mkdirSync(FONT_DIR, { recursive: true });

  const results = [];

  for (const family of FAMILIES) {
    const woff2Css = await googleFontsCss(family.query, MODERN_UA);
    const faces = parseFaces(woff2Css).filter((face) => family.subsets.includes(face.subset));

    if (faces.length === 0) throw new Error(`no matching subsets for ${family.family}`);

    const files = [];
    for (const face of faces) {
      const name = `${family.id}-${face.subset}-${face.weight.replace(/\s+/g, '-')}.woff2`;
      const target = path.join(FONT_DIR, name);

      if (force || !existsSync(target)) {
        writeFileSync(target, await download(face.url));
        console.log(`  downloaded ${name}`);
      } else {
        console.log(`  kept       ${name}`);
      }

      files.push({ ...face, file: name });
    }

    // The TrueType build, for metrics only. It is never written to disk. The
    // legacy stylesheet omits unicode-range, so parseFaces does not apply here.
    const ttfCss = await googleFontsCss(family.query, LEGACY_UA);
    const ttfUrl = /url\((https:[^)]+)\)/.exec(ttfCss)?.[1];
    if (ttfUrl === undefined) throw new Error(`no TrueType build for ${family.family}`);

    const metrics = xHeightRatio(await download(ttfUrl));
    console.log(
      `  ${family.family}: unitsPerEm ${metrics.unitsPerEm}, sxHeight ${metrics.sxHeight}, ` +
        `ratio ${metrics.ratio.toFixed(5)}`,
    );

    results.push({ family, files, metrics });
  }

  const reference = results.find((entry) => entry.family.reference);
  if (reference === undefined) throw new Error('no reference family is marked');

  // Format with the repo's own Prettier config before writing. The
  // `unicode-range` lines are long enough that raw output fails
  // `prettier --check`, so regenerating the fonts would otherwise break
  // `pnpm verify` until somebody noticed.
  const require = createRequire(import.meta.url);
  const prettier = require(require.resolve('prettier', { paths: [REPO_ROOT] }));
  const config = await prettier.resolveConfig(CSS_FILE);
  const formatted = await prettier.format(renderCss(results, reference), {
    ...config,
    filepath: CSS_FILE,
  });

  writeFileSync(CSS_FILE, formatted, 'utf8');
  console.log(`
Wrote ${path.relative(REPO_ROOT, CSS_FILE)} (Prettier-formatted)`);
}

function renderCss(results, reference) {
  const lines = [
    '/*',
    ' * Typography (architecture §24). GENERATED by `pnpm fonts:fetch` — do not',
    ' * hand-edit; re-run the script instead.',
    ' *',
    ' * Inter carries Latin text and every numeral. Hind Siliguri carries Bangla.',
    ' * Both are vendored under ../assets/fonts so a build never depends on a CDN',
    " * and no viewer's IP reaches a third party on first paint.",
    ' *',
    " * `size-adjust` on the Bangla face matches its x-height to Inter's, so a",
    ' * mixed bn/en string — which this product is full of — sits on one optical',
    ' * baseline instead of looking ragged.',
    ' */',
    '',
  ];

  for (const { family, files, metrics } of results) {
    const adjust = family.reference
      ? null
      : Math.round((reference.metrics.ratio / metrics.ratio) * 10000) / 100;

    lines.push(
      `/* ${family.family}: unitsPerEm ${metrics.unitsPerEm}, OS/2 sxHeight ${metrics.sxHeight},` +
        ` x-height ratio ${metrics.ratio.toFixed(5)}`,
    );
    if (adjust !== null) {
      lines.push(
        `   size-adjust = ${reference.family.family} ratio ${reference.metrics.ratio.toFixed(5)}` +
          ` / ${metrics.ratio.toFixed(5)} = ${adjust}%
` +
          `   (OS/2 sxHeight is measured on each font's Latin glyphs; the Bengali
` +
          `    forms are drawn in proportion to them, so matching it brings the
` +
          `    whole face into scale with Inter.) */`,
      );
    } else {
      lines.push('   Reference face: every other family is matched to this one. */');
    }

    for (const face of files) {
      lines.push(
        '@font-face {',
        `  font-family: '${family.family}';`,
        `  font-style: normal;`,
        `  font-weight: ${face.weight.includes(' ') ? face.weight : face.weight};`,
        `  font-display: swap;`,
        `  src: url('../assets/fonts/${face.file}') format('woff2');`,
        ...(adjust !== null ? [`  size-adjust: ${adjust}%;`] : []),
        `  unicode-range: ${face.unicodeRange};`,
        '}',
        '',
      );
    }
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

await main();
