#!/usr/bin/env node
/**
 * Turn an SPA's Cloudflare Pages `_headers` file into a Caddyfile snippet (D-352).
 *
 *   node infra/preview/headers-to-caddy.mjs apps/console/dist/_headers > console.caddy
 *
 * The preview serves the SPAs from Caddy rather than Pages, and must send the same CSP and
 * security headers: the CSP carries the hash of the build's inline script, so it is read
 * from the build's own `_headers` (D-347) rather than written twice.
 *
 * `_headers` is a path line, then indented `Name: value` lines. `/*` becomes a site-wide
 * `header` block; any other path a path-matched one.
 */

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (file === undefined) {
  process.stderr.write('usage: headers-to-caddy.mjs <path/to/_headers>\n');
  process.exit(2);
}

const blocks = [];
for (const line of readFileSync(file, 'utf8').split('\n')) {
  if (line.trim() === '') continue;
  if (!/^\s/.test(line)) {
    blocks.push({ path: line.trim(), headers: [] });
    continue;
  }
  const at = line.indexOf(':');
  const block = blocks.at(-1);
  if (block === undefined || at === -1) throw new Error(`unreadable _headers line: ${line}`);
  block.headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
}

const quote = (value) => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const out = [];
for (const { path, headers } of blocks) {
  out.push(path === '/*' ? 'header {' : `header ${path} {`);
  for (const [name, value] of headers) out.push(`\t${name} ${quote(value)}`);
  out.push('}');
}
process.stdout.write(`${out.join('\n')}\n`);
