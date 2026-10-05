import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The font files a rendered document carries with it (architecture §22, §24).
 *
 * §22 says to embed Noto Sans Bengali or Hind Siliguri, and the reason is not
 * aesthetic. Bangla is a Brahmic script: `ক্ষ` is one glyph made of three
 * codepoints, and shaping it needs the font's GSUB table. A headless Chromium
 * that falls back to a system font without Bangla coverage does not fail — it
 * renders boxes, or worse, renders the component letters side by side, which
 * looks like text and is not the word. An invoice that says the wrong thing in
 * a way only a Bangla reader notices is the failure this exists to prevent.
 *
 * The files are uploaded to Gotenberg alongside the HTML rather than linked or
 * inlined as data URIs:
 *
 * - Linking to Google Fonts would not work at all. The dev container runs with
 *   `--chromium-allow-list=file:///tmp/.*` (infra/docker-compose.dev.yml), so
 *   Chromium may load nothing but the files in its own working directory. That
 *   is a deliberate egress restriction and the right one: a document renderer
 *   that fetches from the internet is a document renderer somebody can point at
 *   an internal address.
 * - Inlining as base64 data URIs works, and costs about a third more bytes on
 *   every render for four fonts. Gotenberg copies uploaded files next to
 *   `index.html`, so a plain relative `url()` resolves under `file:///tmp/…`
 *   and satisfies the allow-list.
 *
 * Verified against the running Gotenberg 8.37 from the dev compose file: the
 * conjuncts in `ক্ষুদ্র ব্যবসায়ী প্রতিষ্ঠান` shape correctly in the output.
 */

export interface FontFile {
  /** The name the HTML references. Also the multipart filename. */
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly family: 'Hind Siliguri';
  readonly weight: 400 | 600;
  /** `bengali` or `latin`: one `@font-face` per subset, with its unicode-range. */
  readonly subset: 'bengali' | 'latin';
}

/**
 * The four faces a document needs: two weights × two subsets.
 *
 * Two weights because a document has headings and body, and faking bold by
 * synthesising it distorts Bangla conjuncts badly. Two subsets because the
 * vendored files are already split that way and loading the Bangla subset to
 * render "Invoice" would be 60 KB for nothing.
 */
const FACES: readonly { file: string; weight: 400 | 600; subset: 'bengali' | 'latin' }[] = [
  { file: 'hind-siliguri-bengali-400.woff2', weight: 400, subset: 'bengali' },
  { file: 'hind-siliguri-bengali-600.woff2', weight: 600, subset: 'bengali' },
  { file: 'hind-siliguri-latin-400.woff2', weight: 400, subset: 'latin' },
  { file: 'hind-siliguri-latin-600.woff2', weight: 600, subset: 'latin' },
];

/**
 * Find `packages/ui/src/assets/fonts` by walking up for the workspace marker.
 *
 * Walking up rather than a relative path from this file, because this module is
 * imported from `src` under vitest and from `dist` at runtime and the number of
 * `..` differs. The marker is `pnpm-workspace.yaml`, which exists exactly once.
 *
 * A container image that ships only `apps/server/dist` has no `packages/ui`, so
 * it sets `PDF_FONT_DIR`. The failure below names that variable rather than
 * printing a path nobody can act on.
 */
export function defaultFontDir(env: NodeJS.ProcessEnv = process.env): string | null {
  // The container image ships the fonts at PDF_FONT_DIR (infra/docker/server.Dockerfile) and
  // keeps a pnpm-workspace.yaml at /app, so the walk below would stop there and look for a
  // packages/ui that the image does not have. The variable wins whenever it is set; until
  // 2026-10-06 nothing read it, and every PDF on a deployed server failed (stickers, labels,
  // invoices, payslips).
  const configured = env.PDF_FONT_DIR?.trim();
  if (configured !== undefined && configured !== '') return configured;

  let directory = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 12; depth += 1) {
    if (existsSync(path.join(directory, 'pnpm-workspace.yaml'))) {
      const candidate = path.join(directory, 'packages', 'ui', 'src', 'assets', 'fonts');
      return existsSync(candidate) ? candidate : null;
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

let cached: readonly FontFile[] | undefined;

/**
 * Load the four faces once per process.
 *
 * Cached because every rendered document needs all four and they never change
 * between renders; re-reading 200 KB off disk per invoice would be work done
 * for no reason. Cleared by nothing: a font file changing under a running
 * process is a deploy, and a deploy restarts it.
 */
export async function loadFonts(overrideDir?: string): Promise<readonly FontFile[]> {
  if (cached !== undefined && overrideDir === undefined) return cached;

  const directory = overrideDir ?? defaultFontDir();
  if (directory === null) {
    throw new Error(
      'Cannot find the Bangla fonts. Set PDF_FONT_DIR to a directory containing ' +
        `${FACES.map((face) => face.file).join(', ')}, or run \`pnpm fonts:fetch\`.`,
    );
  }

  const files = await Promise.all(
    FACES.map(async (face) => {
      const full = path.join(directory, face.file);
      if (!existsSync(full)) {
        throw new Error(
          `Missing font ${face.file} in ${directory}. Run \`pnpm fonts:fetch\`, or set PDF_FONT_DIR.`,
        );
      }
      return {
        filename: face.file,
        bytes: new Uint8Array(await readFile(full)),
        family: 'Hind Siliguri' as const,
        weight: face.weight,
        subset: face.subset,
      };
    }),
  );

  if (overrideDir === undefined) cached = files;
  return files;
}

/**
 * The `@font-face` block for a set of faces.
 *
 * `font-display: block` rather than the browser default: Gotenberg screenshots
 * and prints as soon as the page settles, and `swap` would let it capture a
 * frame still showing the fallback — which for Bangla means capturing boxes.
 * Blocking is the right trade when nobody is waiting on a screen.
 *
 * The `unicode-range` on each face is what makes the split subsets work: the
 * browser fetches the Bangla file only for Bangla text. Both are uploaded
 * either way, so this is about which one is used for which glyph rather than
 * about bytes on the wire.
 */
export function fontFaceCss(fonts: readonly FontFile[]): string {
  // Copied from packages/ui/src/styles/fonts.css, which `pnpm fonts:fetch`
  // generates from the subsets actually present in the vendored files. Copied
  // rather than imported because that file is CSS meant for a browser bundler,
  // and a mismatch here would show up as the wrong face being used for a glyph
  // — which for the Bangla taka sign ৳ (U+09F3) means the wrong currency mark
  // on an invoice.
  const BENGALI_RANGE =
    'U+0951-0952, U+0964-0965, U+0980-09FE, U+1CD0, U+1CD2, U+1CD5-1CD6, U+1CD8, U+1CE1, ' +
    'U+1CEA, U+1CED, U+1CF2, U+1CF5-1CF7, U+200C-200D, U+20B9, U+25CC, U+A8F1';
  const LATIN_RANGE =
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, ' +
    'U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';

  return fonts
    .map(
      (font) => `@font-face {
  font-family: '${font.family}';
  font-style: normal;
  font-weight: ${String(font.weight)};
  font-display: block;
  src: url('${font.filename}') format('woff2');
  unicode-range: ${font.subset === 'bengali' ? BENGALI_RANGE : LATIN_RANGE};
}`,
    )
    .join('\n');
}
