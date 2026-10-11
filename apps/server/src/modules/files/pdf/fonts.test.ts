import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Where the PDF fonts come from on a deployed server (2026-10-06 incident).
 *
 * The server image keeps a `pnpm-workspace.yaml` at /app and the fonts at /app/fonts, with
 * `PDF_FONT_DIR=/app/fonts`. Nothing read that variable: the workspace walk stopped at /app,
 * looked for /app/packages/ui/src/assets/fonts, found nothing, and every PDF (stickers, courier
 * labels, invoices, payslips) failed on the live brand ERP while every local test passed,
 * because a checkout has the folder the walk finds.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_FONTS = path.resolve(HERE, '../../../../../../packages/ui/src/assets/fonts');
/** Inter only (D-753): every document is English (D-750). */
const FACES = ['inter-latin-400-700.woff2', 'inter-latin-ext-400-700.woff2'];

let scratch: string | undefined;

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.resetModules();
  if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  scratch = undefined;
});

/** A directory laid out like the image: a workspace marker, fonts in their own folder. */
async function imageLike(): Promise<string> {
  scratch = await mkdtemp(path.join(tmpdir(), 'erp-fonts-'));
  await writeFile(path.join(scratch, 'pnpm-workspace.yaml'), 'packages: []\n');
  const fonts = path.join(scratch, 'fonts');
  await import('node:fs/promises').then((fs) => fs.mkdir(fonts));
  for (const face of FACES) await copyFile(path.join(REPO_FONTS, face), path.join(fonts, face));
  return fonts;
}

describe('the PDF font directory', () => {
  it('uses PDF_FONT_DIR when it is set, before any workspace walk', async () => {
    const fonts = await imageLike();
    const { defaultFontDir } = await import('./fonts.js');
    expect(defaultFontDir({ PDF_FONT_DIR: fonts })).toBe(fonts);
  });

  it('loads the Inter faces from PDF_FONT_DIR with no argument, as every PDF service calls it', async () => {
    const fonts = await imageLike();
    vi.stubEnv('PDF_FONT_DIR', fonts);
    vi.resetModules();
    const { loadFonts } = await import('./fonts.js');
    const loaded = await loadFonts();
    expect(loaded.map((face) => face.filename).sort()).toEqual([...FACES].sort());
    expect(loaded.every((face) => face.bytes.byteLength > 1000)).toBe(true);
  });

  it('ignores a blank PDF_FONT_DIR and falls back to the checkout', async () => {
    const { defaultFontDir } = await import('./fonts.js');
    expect(defaultFontDir({ PDF_FONT_DIR: '  ' })).toBe(REPO_FONTS);
  });

  it('names the variable when the configured folder lacks a face', async () => {
    scratch = await mkdtemp(path.join(tmpdir(), 'erp-fonts-empty-'));
    vi.stubEnv('PDF_FONT_DIR', scratch);
    vi.resetModules();
    const { loadFonts } = await import('./fonts.js');
    await expect(loadFonts()).rejects.toThrow(/PDF_FONT_DIR/);
  });
});

describe('the document faces (D-753)', () => {
  it('are Inter alone: no Hind Siliguri is uploaded with any document', async () => {
    const { loadFonts, fontFaceCss } = await import('./fonts.js');
    const fonts = await loadFonts(REPO_FONTS);
    expect(fonts.map((face) => face.filename).sort()).toEqual([...FACES].sort());
    expect(fonts.every((face) => face.family === 'Inter')).toBe(true);
    const css = fontFaceCss(fonts);
    expect(css).not.toMatch(/Hind Siliguri|hind-siliguri/);
    expect(css).toContain("font-family: 'Inter'");
  });
});
