import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { contentSecurityPolicy, inlineScriptHashes, pagesHeadersFile } from './pages-headers.js';

/** The SPAs' `_headers` for Cloudflare Pages (M14b, D-347). */

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const API = { apiUrl: 'https://api.elysium.example' };

const sha = (text: string) => `'sha256-${createHash('sha256').update(text).digest('base64')}'`;

describe('inlineScriptHashes', () => {
  it('hashes the inline script exactly as written and skips scripts loaded by src', () => {
    const body = "\n      document.documentElement.classList.add('dark');\n    ";
    const html = `<head><script>${body}</script><script type="module" src="/assets/index.js"></script></head>`;
    expect(inlineScriptHashes(html)).toEqual([sha(body)]);
  });

  it("covers each SPA's real theme script, so the built page is not blocked", () => {
    for (const app of ['console', 'portal', 'pos']) {
      const html = readFileSync(path.join(REPO, 'apps', app, 'index.html'), 'utf8');
      expect(inlineScriptHashes(html), app).toHaveLength(1);
    }
  });
});

describe('contentSecurityPolicy', () => {
  it('allows scripts from the page and its hashes only, and talks to the API alone', () => {
    const policy = contentSecurityPolicy('<script>paint()</script>', API);
    expect(policy).toContain(`script-src 'self' ${sha('paint()')}`);
    expect(policy).not.toMatch(/unsafe-eval|script-src[^;]*unsafe-inline/);
    expect(policy).toContain(
      "connect-src 'self' https://api.elysium.example wss://api.elysium.example",
    );
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
  });

  it('adds the R2 upload endpoint, and refuses anything that is not an origin', () => {
    const policy = contentSecurityPolicy('', {
      ...API,
      extraConnectSrc: 'https://0123abcd.r2.cloudflarestorage.com',
    });
    expect(policy).toMatch(/connect-src [^;]*https:\/\/0123abcd\.r2\.cloudflarestorage\.com/);

    for (const bad of [
      "https://x.example; script-src 'unsafe-inline'",
      "'unsafe-inline'",
      'http://plain.example',
    ]) {
      expect(() => contentSecurityPolicy('', { ...API, extraConnectSrc: bad }), bad).toThrow(
        /VITE_CSP_CONNECT_SRC/,
      );
    }
  });
});

describe('pagesHeadersFile', () => {
  it("is Pages' _headers format: a pattern, then indented headers", () => {
    const file = pagesHeadersFile('<script>paint()</script>', API);
    const lines = file.split('\n');

    expect(lines[0]).toBe('/*');
    expect(lines).toContain('  X-Frame-Options: DENY');
    expect(lines).toContain('  X-Content-Type-Options: nosniff');
    expect(lines).toContain('/assets/*');
    expect(lines).toContain('  Cache-Control: public, max-age=31536000, immutable');
    // Pages' documented limit is 2,000 characters a line.
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(2_000);
  });
});
