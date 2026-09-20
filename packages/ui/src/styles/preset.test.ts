import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';

import { parseTokenFile } from '../tokens/parse.js';

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

/**
 * Run the real Tailwind compiler over the real preset.
 *
 * A static check that `@theme inline` mentions the right names would pass even
 * if the utility never reached the page. This compiles `tailwind.css` the way
 * an app does and asserts the emitted CSS, so "the tokens are wired" is a fact
 * about the output rather than about the source.
 */
async function buildCss(candidates: readonly string[]): Promise<string> {
  const entry = await readFile(path.join(stylesDir, 'tailwind.css'), 'utf8');

  const compiler = await compile(entry, {
    base: stylesDir,
    async loadStylesheet(id: string, base: string) {
      const file =
        id === 'tailwindcss' ? require.resolve('tailwindcss/index.css') : path.resolve(base, id);
      return { path: file, base: path.dirname(file), content: await readFile(file, 'utf8') };
    },
    loadModule() {
      return Promise.reject(
        new Error('The preset must not need a JS plugin; Tailwind 4 config is CSS-first.'),
      );
    },
  });

  return compiler.build([...candidates]);
}

const tailwindCss = await readFile(path.join(stylesDir, 'tailwind.css'), 'utf8');
const tokensCss = await readFile(path.join(stylesDir, 'tokens.css'), 'utf8');
const tokens = parseTokenFile(tokensCss);

/** Every `--color-<name>: var(--<token>)` line in the `@theme inline` block. */
const colourMappings = [...tailwindCss.matchAll(/--color-([\w-]+):\s*var\((--[\w-]+)\)/g)].map(
  ([, utility, token]) => ({ utility: utility ?? '', token: token ?? '' }),
);

describe('Tailwind preset (architecture §24)', () => {
  it('maps a colour utility for every semantic role the themes define', () => {
    const mapped = new Set(colourMappings.map((entry) => entry.token));
    const unmapped = [...tokens.light.keys()].filter(
      (name) => !name.startsWith('--brand-') && !mapped.has(name),
    );

    // A role with no utility is a role nobody can use, which is how hard-coded
    // colours creep back in.
    expect(unmapped).toEqual([]);
  });

  it('points every mapped utility at a token that actually exists', () => {
    const missing = colourMappings.filter(
      (entry) => !tokens.light.has(entry.token) && !tokens.static.has(entry.token),
    );

    expect(missing).toEqual([]);
  });

  it('compiles each semantic utility to a real token reference', async () => {
    const candidates = colourMappings.map((entry) => `bg-${entry.utility}`);
    // The compiler emits formatted CSS; collapse it so the assertion is about
    // the declaration rather than about indentation.
    const css = (await buildCss(candidates)).replace(/\s+/g, '');

    for (const { utility, token } of colourMappings) {
      expect(css, `bg-${utility} should resolve to ${token}`).toContain(
        `.bg-${utility}{background-color:var(${token})`,
      );
    }
  });

  it('emits both themes and the reduced-motion guard', async () => {
    const css = await buildCss(['bg-background']);

    expect(css).toContain('.dark');
    expect(css).toContain('oklch');
    expect(css).toContain('prefers-reduced-motion');
  });

  it('exposes the density and radius scale as utilities', async () => {
    const css = await buildCss(['h-row', 'rounded-lg', 'font-bangla', 'tabular-nums']);

    expect(css).toContain('var(--row-height)');
    expect(css).toContain('var(--radius)');
    expect(css).toContain('var(--font-bangla)');
    expect(css).toContain('tabular-nums');
  });
});
