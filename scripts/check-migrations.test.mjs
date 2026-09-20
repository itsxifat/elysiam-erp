import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Migration immutability is CLAUDE.md invariant 9, and `pnpm verify` will not
 * exercise it until M01 adds the first migration — by which point a regression
 * here would go unnoticed. So the script is tested against a real throwaway
 * git repository instead of being trusted from one manual demonstration.
 */

const SCRIPT = fileURLToPath(new URL('./check-migrations.mjs', import.meta.url));
const MIGRATIONS = 'packages/db/migrations';

let repo;

function git(args, cwd = repo) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Run the script inside the throwaway repo and return its exit code and output. */
function run(...args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: repo,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output: stdout };
  } catch (error) {
    return { code: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function writeMigration(name, body) {
  const file = path.join(repo, MIGRATIONS, name);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body, 'utf8');
  return file;
}

beforeAll(() => {
  repo = mkdtempSync(path.join(tmpdir(), 'elysium-migrations-'));

  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);

  // The script resolves the repository from the working directory, so the
  // migrations path has to exist inside this throwaway repo.
  writeMigration('0000_initial.sql', 'create table demo (id uuid primary key);\n');
  git(['add', '-A']);
  git(['commit', '-m', 'baseline migration']);
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe('check-migrations', () => {
  it('passes when the committed migrations are untouched', () => {
    const { code, output } = run('--base', 'main');
    expect(output).toContain('PASS');
    expect(code).toBe(0);
  });

  it('passes when a NEW migration is added', () => {
    writeMigration('0001_add_index.sql', 'create index demo_id_idx on demo (id);\n');
    const { code } = run('--base', 'main');
    expect(code).toBe(0);

    rmSync(path.join(repo, MIGRATIONS, '0001_add_index.sql'));
  });

  it('fails on an uncommitted edit to a committed migration', () => {
    appendFileSync(
      path.join(repo, MIGRATIONS, '0000_initial.sql'),
      'alter table demo add col text;\n',
    );

    const { code, output } = run('--base', 'main');
    expect(output).toContain('modified: packages/db/migrations/0000_initial.sql');
    expect(code).toBe(1);

    git(['checkout', '--', '.']);
  });

  it('fails on a committed edit to a committed migration', () => {
    git(['checkout', '-b', 'edit-branch']);
    appendFileSync(
      path.join(repo, MIGRATIONS, '0000_initial.sql'),
      'alter table demo add col text;\n',
    );
    git(['add', '-A']);
    git(['commit', '-m', 'edit the migration']);

    const { code, output } = run('--base', 'main');
    expect(output).toContain('modified:');
    expect(code).toBe(1);

    git(['checkout', 'main']);
    git(['branch', '-D', 'edit-branch']);
  });

  it('fails when a committed migration is deleted', () => {
    git(['checkout', '-b', 'delete-branch']);
    git(['rm', '-q', `${MIGRATIONS}/0000_initial.sql`]);
    git(['commit', '-m', 'delete the migration']);

    const { code, output } = run('--base', 'main');
    expect(output).toContain('deleted:');
    expect(code).toBe(1);

    git(['checkout', 'main']);
    git(['branch', '-D', 'delete-branch']);
  });

  it('skips cleanly when the base ref does not exist', () => {
    const { code, output } = run('--base', 'no-such-ref');
    expect(output).toContain('SKIP');
    expect(code).toBe(0);
  });
});
