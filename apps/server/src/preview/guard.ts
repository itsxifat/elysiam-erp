import { withGlobal, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * What stops `preview:seed` from writing demo money into a brand's real books (D-381).
 *
 * A database is a preview only if it says so itself: its comment is `elysium-preview`.
 * `pnpm preview:local` and the smoke run set it when they create their database, and the
 * preview server sets it once (docs/runbooks/preview-kit.md). Production never has it, and
 * nothing in the environment can stand in for it, so a pasted command or a stale variable
 * cannot make a real database look like a preview.
 *
 * Both connections are checked, not one. The seed writes through the application role and
 * through the owner role (the base seed, the job queues, the super admin flag), so an owner
 * address pointing somewhere else would slip past a check of the first alone.
 */

export const PREVIEW_MARKER = 'elysium-preview';

export interface DatabaseIdentity extends Record<string, unknown> {
  readonly database: string;
  readonly oid: string;
  readonly started: string;
  readonly marker: string | null;
}

const IDENTITY = sql`
  select current_database() as database,
         d.oid::text as oid,
         pg_postmaster_start_time()::text as started,
         shobj_description(d.oid, 'pg_database') as marker
  from pg_database d
  where d.datname = current_database()
`;

/** The marker, as the SQL that sets it. Quoted for a name like `elysium_preview_e2e`. */
export function markerStatement(database: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(database)) {
    throw new Error(`"${database}" is not a plain database name.`);
  }
  return `comment on database "${database}" is '${PREVIEW_MARKER}'`;
}

/**
 * The decision, apart from the reads, so it can be tested without a database. Returns the
 * reason to refuse, or null.
 */
export function refusal(
  app: DatabaseIdentity,
  owner: DatabaseIdentity,
  outsiders: number,
  allowExistingUsers: boolean,
): string | null {
  // Name, oid and the server's start time: one database on one running cluster. Not the
  // address, which differs when one URL says localhost and the other 127.0.0.1.
  const same =
    app.database === owner.database && app.oid === owner.oid && app.started === owner.started;
  if (!same) {
    return (
      `DATABASE_URL reaches "${app.database}" but DATABASE_OWNER_URL reaches ` +
      `"${owner.database}" (or the same name on another server). The seed writes through both, ` +
      'so they must name one database.'
    );
  }
  if (app.marker !== PREVIEW_MARKER) {
    return (
      `"${app.database}" is not marked as a preview, so it may hold a brand's real data. ` +
      '`pnpm preview:local` makes and marks a preview database. To mark one by hand, as its ' +
      `owner or a superuser: ${markerStatement(app.database)};`
    );
  }
  if (outsiders > 0 && !allowExistingUsers) {
    return (
      `${String(outsiders)} person(s) outside the preview can sign in to "${app.database}". ` +
      'Pass --allow-existing-users if they are testers you invited on purpose.'
    );
  }
  return null;
}

export async function assertPreviewTarget(options: {
  readonly emailDomain: string;
  readonly allowExistingUsers: boolean;
}): Promise<string> {
  const app = (await withGlobal((tx) => tx.execute<DatabaseIdentity>(IDENTITY)))[0];
  const owner = (await withSystem((tx) => tx.execute<DatabaseIdentity>(IDENTITY)))[0];
  if (app === undefined || owner === undefined) {
    throw new Error('preview:seed could not read which database it is connected to.');
  }
  const counted = await withGlobal((tx) =>
    tx.execute<{ n: number }>(sql`
      select count(*)::int as n from iam.users
      where email not like ${`%@${options.emailDomain}`}
    `),
  );
  const reason = refusal(app, owner, counted[0]?.n ?? 0, options.allowExistingUsers);
  if (reason !== null) throw new Error(`preview:seed refuses this database. ${reason}`);
  return app.database;
}
