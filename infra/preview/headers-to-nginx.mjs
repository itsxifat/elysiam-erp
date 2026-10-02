#!/usr/bin/env node
/**
 * Turn an SPA build's Cloudflare Pages `_headers` file into nginx `add_header` lines (D-352).
 *
 *   node infra/preview/headers-to-nginx.mjs apps/console/dist/_headers > console.conf
 *
 * The preview serves the SPAs from the host's nginx rather than Pages, and must send the
 * same CSP and security headers: the CSP carries the hash of the build's inline script, so
 * it is read from the build's own `_headers` (D-347) rather than written twice. Only the
 * `/*` block is taken; nginx-elyerp.conf sets the asset caching itself. Documents are also
 * marked `no-cache`, so a new release's index.html is fetched at once.
 */

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (file === undefined) {
  process.stderr.write('usage: headers-to-nginx.mjs <path/to/_headers>\n');
  process.exit(2);
}

const headers = [];
let inSiteBlock = false;
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  if (!/^\s/.test(line)) {
    inSiteBlock = line.trim() === '/*';
    continue;
  }
  if (!inSiteBlock) continue;
  const at = line.indexOf(':');
  if (at === -1) throw new Error(`unreadable _headers line: ${line}`);
  headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
}
if (headers.length === 0) throw new Error(`${file} has no /* block`);

const quote = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const out = [`# Generated from ${file.split('/').slice(-2).join('/')} by headers-to-nginx.mjs.`];
for (const [name, value] of headers) out.push(`add_header ${name} ${quote(value)} always;`);
out.push('add_header Cache-Control "no-cache" always;');
process.stdout.write(`${out.join('\n')}\n`);
