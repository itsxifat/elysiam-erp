import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The font files a rendered document carries with it (architecture §22, §24; D-753).
 *
 * Inter, and only Inter: every document is English (D-750), so the vendored Inter variable
 * files — Latin and Latin Extended, weights 400 to 700 in one file each — carry every word and
 * every numeral, with the tabular figures a column of money needs. Hind Siliguri is no longer
 * uploaded with a document. Text a person typed in Bangla (a buyer's name or address) is
 * printed as typed: the renderer's own system font for it is Noto Sans Bengali, which the
 * Gotenberg image ships, named in each template's font stack after Inter.
 *
 * The files are uploaded to Gotenberg alongside the HTML rather than linked or inlined as
 * data URIs:
 *
 * - Linking to Google Fonts would not work at all. The dev container runs with
 *   `--chromium-allow-list=file:///tmp/.*` (infra/docker-compose.dev.yml), so Chromium may
 *   load nothing but the files in its own working directory. That is a deliberate egress
 *   restriction and the right one: a document renderer that fetches from the internet is a
 *   document renderer somebody can point at an internal address.
 * - Inlining as base64 data URIs works, and costs about a third more bytes on every render.
 *   Gotenberg copies uploaded files next to `index.html`, so a plain relative `url()`
 *   resolves under `file:///tmp/…` and satisfies the allow-list.
 */

export interface FontFile {
  /** The name the HTML references. Also the multipart filename. */
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly family: 'Inter';
  /** A variable face: the whole weight range in one file. */
  readonly weight: '400 700';
  /** `latin` or `latin-ext`: one `@font-face` per subset, with its unicode-range. */
  readonly subset: 'latin' | 'latin-ext';
}

/**
 * The two faces a document needs: Inter's Latin and Latin Extended subsets.
 *
 * Variable files, so a heading's 700 and the body's 400 are the same file and nothing is
 * synthesised. Two subsets because the vendored files are split that way (`pnpm fonts:fetch`)
 * and a name such as "Şebnem" needs the extended one.
 */
const FACES: readonly { file: string; subset: 'latin' | 'latin-ext' }[] = [
  { file: 'inter-latin-400-700.woff2', subset: 'latin' },
  { file: 'inter-latin-ext-400-700.woff2', subset: 'latin-ext' },
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
 * Load the faces once per process.
 *
 * Cached because every rendered document needs them and they never change between renders;
 * re-reading 130 KB off disk per invoice would be work done for no reason. Cleared by nothing:
 * a font file changing under a running process is a deploy, and a deploy restarts it.
 */
export async function loadFonts(overrideDir?: string): Promise<readonly FontFile[]> {
  if (cached !== undefined && overrideDir === undefined) return cached;

  const directory = overrideDir ?? defaultFontDir();
  if (directory === null) {
    throw new Error(
      'Cannot find the document fonts. Set PDF_FONT_DIR to a directory containing ' +
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
        family: 'Inter' as const,
        weight: '400 700' as const,
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
 * `font-display: block` rather than the browser default: Gotenberg screenshots and prints as
 * soon as the page settles, and `swap` would let it capture a frame still showing the fallback
 * face. Blocking is the right trade when nobody is waiting on a screen.
 *
 * The `unicode-range` on each face is what makes the split subsets work. Copied from
 * `packages/ui/src/styles/fonts.css`, which `pnpm fonts:fetch` generates from the subsets
 * actually in the vendored files; copied rather than imported because that file is CSS for a
 * browser bundler.
 */
export function fontFaceCss(fonts: readonly FontFile[]): string {
  const LATIN_RANGE =
    'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, ' +
    'U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD';
  const LATIN_EXT_RANGE =
    'U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, ' +
    'U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, ' +
    'U+2C60-2C7F, U+A720-A7FF';

  return fonts
    .map(
      (font) => `@font-face {
  font-family: '${font.family}';
  font-style: normal;
  font-weight: ${font.weight};
  font-display: block;
  src: url('${font.filename}') format('woff2');
  unicode-range: ${font.subset === 'latin' ? LATIN_RANGE : LATIN_EXT_RANGE};
}`,
    )
    .join('\n');
}

/**
 * The font stack every document sets on its body (D-753): Inter, then the renderer's system
 * Noto Sans Bengali for text a person typed in Bangla, then any sans-serif.
 */
export const DOCUMENT_FONT_STACK = `'Inter', 'Noto Sans Bengali', 'Noto Sans', sans-serif`;
