import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Security headers for the SPAs on Cloudflare Pages (architecture §25, §28; M14b, D-347).
 *
 * Pages serves a `_headers` file from the build output's root
 * (developers.cloudflare.com/pages/configuration/headers/, read 2026-10-02): a URL
 * pattern, then indented `Name: value` lines. This writes one per app after `vite build`,
 * because two of its values only exist then: the hash of `index.html`'s inline theme
 * script, and the API origin the build was given.
 *
 * The policy, and why each part:
 *
 * - `script-src 'self' 'sha256-…'`: the bundles and the one inline script that paints the
 *   theme before first paint. No `unsafe-inline`, no `unsafe-eval`.
 * - `connect-src`: this origin, the API over https and wss (Socket.IO, §19), and whatever
 *   the build adds in `VITE_CSP_CONNECT_SRC`: the R2 endpoint presigned uploads go to
 *   (`https://<account-id>.r2.cloudflarestorage.com`, §22), and Sentry's ingest host once
 *   the SPAs report errors. A script injected by an XSS can talk to nothing else.
 * - `style-src 'self' 'unsafe-inline'`: component libraries set inline styles; a style is
 *   not a script.
 * - `img-src` allows https: product images come from R2's public host.
 * - `media-src` (M38b, D-616): this origin, the API's (a local driver's signed video URL) and
 *   the extra origins (R2's signed URLs), plus `blob:` for a recording played back in place.
 * - `Permissions-Policy`: the camera only for an app that asks for it (`allowCamera`, the
 *   console: the packing video and scanning stickers with a phone's camera, D-605, D-611), and
 *   then only for this origin. Microphone, location, payment and USB stay off everywhere.
 * - `frame-ancestors 'none'` and `X-Frame-Options: DENY`: no page is meant to be framed.
 */

export interface PagesHeadersOptions {
  /** The API origin the build was given (`VITE_API_URL`). */
  readonly apiUrl: string;
  /** Extra `connect-src` sources, space-separated (`VITE_CSP_CONNECT_SRC`). */
  readonly extraConnectSrc?: string | undefined;
  /** Let this origin use the camera (M38b): the console's packing station and camera scans. */
  readonly allowCamera?: boolean;
}

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

/** `'sha256-…'` for every inline script in the page, exactly as the browser hashes it. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];
  for (const match of html.matchAll(INLINE_SCRIPT)) {
    const body = match[1] ?? '';
    if (body.trim() === '') continue;
    hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
  }
  return hashes;
}

/** The API's origin, and its WebSocket twin for the realtime gateway. */
function apiSources(apiUrl: string): string[] {
  const url = new URL(apiUrl);
  const socket = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return [url.origin, `${socket}//${url.host}`];
}

export function contentSecurityPolicy(html: string, options: PagesHeadersOptions): string {
  const extra = (options.extraConnectSrc ?? '').split(/\s+/).filter(Boolean);
  for (const source of extra) {
    // Origins only: a stray quote or semicolon would rewrite the policy.
    if (!/^(https|wss):\/\/[a-z0-9.*-]+(:\d+)?$/i.test(source)) {
      throw new Error(`VITE_CSP_CONNECT_SRC: "${source}" is not an https or wss origin`);
    }
  }
  const apiOrigin = new URL(options.apiUrl).origin;
  const extraHttps = extra.filter((source) => source.toLowerCase().startsWith('https:'));
  const directives: [string, string[]][] = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", ...inlineScriptHashes(html)]],
    ['style-src', ["'self'", "'unsafe-inline'"]],
    ['img-src', ["'self'", 'data:', 'blob:', 'https:']],
    ['media-src', ["'self'", 'blob:', apiOrigin, ...extraHttps]],
    ['font-src', ["'self'"]],
    ['connect-src', ["'self'", ...apiSources(options.apiUrl), ...extra]],
    ['worker-src', ["'self'"]],
    ['manifest-src', ["'self'"]],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
  ];
  return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

/** The headers every response carries, as name and value. */
export function documentHeaders(html: string, options: PagesHeadersOptions): [string, string][] {
  return [
    ['Content-Security-Policy', contentSecurityPolicy(html, options)],
    ['X-Frame-Options', 'DENY'],
    ['X-Content-Type-Options', 'nosniff'],
    ['Referrer-Policy', 'strict-origin-when-cross-origin'],
    [
      'Permissions-Policy',
      `camera=${options.allowCamera === true ? '(self)' : '()'}, microphone=(), geolocation=(), payment=(), usb=()`,
    ],
    ['Cross-Origin-Opener-Policy', 'same-origin'],
  ];
}

/** The `_headers` file: every path, plus long caching for content-hashed assets. */
export function pagesHeadersFile(html: string, options: PagesHeadersOptions): string {
  const lines = [
    '/*',
    ...documentHeaders(html, options).map(([name, value]) => `  ${name}: ${value}`),
  ];
  lines.push('', '/assets/*', '  Cache-Control: public, max-age=31536000, immutable', '');
  return lines.join('\n');
}

/** The slice of Vite's plugin interface this uses, so this package need not depend on Vite. */
interface PreviewServer {
  middlewares: {
    use(
      handler: (
        request: unknown,
        response: { setHeader(name: string, value: string): void },
        next: () => void,
      ) => void,
    ): void;
  };
}

/**
 * A Vite plugin that writes `dist/_headers` after the build, and serves the same headers
 * from `vite preview`, so a browser test against the preview runs under the production
 * policy (the till's offline e2e does).
 */
export function pagesHeaders(options: PagesHeadersOptions) {
  let outDir = 'dist';
  let root = process.cwd();
  return {
    name: 'elysium-pages-headers',
    configResolved(config: { root: string; build: { outDir: string } }) {
      root = config.root;
      outDir = config.build.outDir;
    },
    writeBundle(output: { dir?: string }) {
      const dir = output.dir ?? path.resolve(root, outDir);
      const html = readFileSync(path.join(dir, 'index.html'), 'utf8');
      writeFileSync(path.join(dir, '_headers'), pagesHeadersFile(html, options));
    },
    configurePreviewServer(server: PreviewServer) {
      const html = readFileSync(path.resolve(root, outDir, 'index.html'), 'utf8');
      const headers = documentHeaders(html, options);
      server.middlewares.use((_request, response, next) => {
        for (const [name, value] of headers) response.setHeader(name, value);
        next();
      });
    },
  };
}
