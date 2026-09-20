#!/usr/bin/env node
/**
 * Copy every `.env.example` to a sibling `.env` that does not exist yet.
 *
 * Config is validated with Zod and fails fast, which is right in production and
 * annoying on a first clone. This turns "why does the API exit immediately"
 * into one command. It never overwrites an existing `.env`.
 */

import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEARCH_DIRS = ['apps', 'packages'];

let copied = 0;
let kept = 0;

for (const group of SEARCH_DIRS) {
  const groupDir = path.join(REPO_ROOT, group);
  if (!existsSync(groupDir)) continue;

  for (const name of readdirSync(groupDir)) {
    const dir = path.join(groupDir, name);
    if (!statSync(dir).isDirectory()) continue;

    const example = path.join(dir, '.env.example');
    const target = path.join(dir, '.env');
    if (!existsSync(example)) continue;

    if (existsSync(target)) {
      kept += 1;
      console.log(`  kept    ${group}/${name}/.env`);
      continue;
    }

    copyFileSync(example, target);
    copied += 1;
    console.log(`  created ${group}/${name}/.env`);
  }
}

console.log(`\nsetup:env — ${copied} created, ${kept} left alone.`);
if (copied > 0) {
  console.log('Review the new files: they carry local defaults, never real secrets.');
}
