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
 *
 * The marker is permanent, so a preview that later holds real work is still marked. The audit
 * log is what says so: any change in any brand made by someone outside the preview stops the
 * seed, and no flag skips that (ledger re-audit W1). Unmark a database before real use
 * (docs/runbooks/preview-kit.md).
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

/**
 * The decision, apart from the reads, so it can be tested without a database. Returns the
 * reason to refuse, or null.
 */
export function refusal(
  app: DatabaseIdentity,
  owner: DatabaseIdentity,
  people: { readonly outsiders: number; readonly outsiderChanges: number },
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
      '`pnpm preview:local` makes and marks a preview database; for a preview server, see ' +
      'docs/runbooks/preview-kit.md.'
    );
  }
  if (people.outsiderChanges > 0) {
    return (
      `${String(people.outsiderChanges)} change(s) in "${app.database}" were made by people ` +
      'outside the preview, so it holds work that is not demo data. Nothing overrides this: ' +
      'start a fresh preview instead (docs/runbooks/preview-kit.md).'
    );
  }
  if (people.outsiders > 0 && !allowExistingUsers) {
    return (
      `${String(people.outsiders)} person(s) outside the preview can sign in to ` +
      `"${app.database}". Pass --allow-existing-users if they are testers you invited on ` +
      'purpose and have changed nothing.'
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
  const outside = `%@${options.emailDomain}`;
  const counted = await withGlobal((tx) =>
    tx.execute<{ n: number }>(sql`
      select count(*)::int as n from iam.users where email not like ${outside}
    `),
  );
  // Read brand by brand: the audit log is FORCE RLS, so each read runs in that org.
  const orgs = await withSystem((tx) =>
    tx.execute<{ id: string }>(sql`select id::text as id from org.organizations`),
  );
  let outsiderChanges = 0;
  for (const org of orgs) {
    const rows = await withSystem(
      (tx) =>
        tx.execute<{ n: number }>(sql`
          select count(*)::int as n
          from audit.audit_log a join iam.users u on u.id = a.actor_user_id
          where u.email not like ${outside}
        `),
      { orgId: org.id },
    );
    outsiderChanges += rows[0]?.n ?? 0;
  }
  const reason = refusal(
    app,
    owner,
    { outsiders: counted[0]?.n ?? 0, outsiderChanges },
    options.allowExistingUsers,
  );
  if (reason !== null) throw new Error(`preview:seed refuses this database. ${reason}`);
  return app.database;
}
