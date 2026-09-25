#!/usr/bin/env node
/**
 * The api-client drift check (M04 acceptance check 6).
 *
 * The check is "the api-client regenerates with no diff", and the only way to
 * *prove* that is to regenerate it and compare. So that is what this does: it
 * runs the real generator into a scratch directory and compares every output
 * byte-for-byte against the committed copy.
 *
 * The alternative — comparing a hash recorded at generation time — proves only
 * that the recorded hash matches itself. It would pass after a contract change,
 * because the hash is written by the same run that writes the file.
 *
 * What drift actually means when this fails:
 *
 * - somebody added a route, so the client is missing a method;
 * - somebody changed a Zod schema, so the published request shape is stale and
 *   a frontend is type-checking against a body the server now refuses;
 * - somebody edited `src/generated/*` by hand, which the next generation undoes.
 *
 * All three are fixed by `pnpm api:client`, which is what the failure says.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = path.join(REPO_ROOT, 'packages/api-client');
const GENERATOR = path.join(PACKAGE, 'scripts/generate.mjs');

/** Everything the generator writes, relative to the package root. */
const OUTPUTS = ['openapi.json', 'src/generated/client.ts', 'src/generated/index.ts'];

function read(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * The first line that differs, with its line number.
 *
 * A whole-file diff of a 2000-line generated document is unreadable in CI
 * output, and the first differing line is almost always enough to name the
 * cause — a new operationId, a changed `required` list.
 */
function firstDifference(committed, fresh) {
  const left = committed.split('\n');
  const right = fresh.split('\n');

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      return {
        line: index + 1,
        committed: left[index] ?? '(end of file)',
        fresh: right[index] ?? '(end of file)',
      };
    }
  }
  return null;
}

function main() {
  if (!existsSync(path.join(REPO_ROOT, 'apps/server/dist/app.module.js'))) {
    console.error(
      'check-api-client: apps/server is not built, so the generator cannot boot the app.\n' +
        '  pnpm --filter @elysium/server run build\n' +
        'In `pnpm verify` this runs after `build`, so a failure here means the build failed.',
    );
    return 1;
  }

  const scratch = mkdtempSync(path.join(tmpdir(), 'elysium-api-client-'));
  try {
    try {
      execFileSync(process.execPath, [GENERATOR, '--out', scratch], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      console.error('check-api-client: the generator itself failed.\n');
      console.error(String(error.stdout ?? '') + String(error.stderr ?? ''));
      return 1;
    }

    const problems = [];

    for (const output of OUTPUTS) {
      const committed = read(path.join(PACKAGE, output));
      const fresh = read(path.join(scratch, output));

      if (fresh === null) {
        problems.push(`${output}: the generator did not produce it`);
        continue;
      }
      if (committed === null) {
        problems.push(`${output}: missing from the repository — run \`pnpm api:client\``);
        continue;
      }
      if (committed === fresh) continue;

      const difference = firstDifference(committed, fresh);
      problems.push(
        `${output}: differs at line ${String(difference.line)}\n` +
          `      committed: ${difference.committed.trim()}\n` +
          `      generated: ${difference.fresh.trim()}`,
      );
    }

    /*
     * A file in src/generated that the generator no longer writes.
     *
     * Without this check a renamed operation file would linger, still be
     * exported, and still compile — so a frontend would keep importing a client
     * for an endpoint that no longer exists.
     */
    const generatedDir = path.join(PACKAGE, 'src/generated');
    if (existsSync(generatedDir)) {
      const expected = new Set(
        OUTPUTS.filter((output) => output.startsWith('src/generated/')).map((output) =>
          path.basename(output),
        ),
      );
      for (const entry of readdirSync(generatedDir)) {
        if (statSync(path.join(generatedDir, entry)).isFile() && !expected.has(entry)) {
          problems.push(`src/generated/${entry}: left over; the generator does not write it`);
        }
      }
    }

    if (problems.length > 0) {
      console.error(`check-api-client: FAIL — ${String(problems.length)} problem(s).\n`);
      for (const problem of problems) console.error(`  ${problem}`);
      console.error(
        '\nThe committed client does not match a fresh generation. Run:\n' +
          '  pnpm api:client\n' +
          'and commit the result. Never edit src/generated/* by hand.\n',
      );
      return 1;
    }

    console.log(
      `check-api-client: ${String(OUTPUTS.length)} generated file(s) match a fresh generation. PASS`,
    );
    return 0;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

process.exit(main());
