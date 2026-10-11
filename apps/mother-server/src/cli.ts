import { z } from 'zod';

import {
  BRAND_SLUG,
  brandConnectionSchema,
  brandCreateSchema,
  type ConnectionTestWire,
} from '@elysium/mother-shared';

import { recordAudit, type Actor } from './audit/audit.js';
import { testConnection } from './brands/live.js';
import type { BrandPools } from './brands/pools.js';
import {
  createBrand,
  findBrandBySlug,
  listBrands,
  rotateOwnerLinkKey,
  setBrandConnection,
  type BrandRow,
} from './brands/registry.js';
import type { SecretsKey } from './crypto/secrets.js';
import { inMother, motherSql } from './db/client.js';
import { clearSecondFactor, invitePerson } from './people/people.js';

/**
 * The operator's commands on the mother's server (D-487, D-488, D-690, D-700): the first
 * owner, the break-glass reset of an owner's second factor when no third owner can approve
 * one, and the brand registry's changes that only the server may make: adding a brand,
 * changing its read connection and making or replacing its owner-link key.
 * Pure of process concerns, so the tests drive them; `main.cli.ts` wires them to argv.
 * Nothing here ever returns or prints a read connection: it comes in from the environment
 * and goes out only as its fingerprint.
 */

export class CliRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliRefused';
  }
}

const OPERATOR = 'system:operator';

const bootstrapInput = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(200),
  publicUrl: z.string().url(),
});

/**
 * The first owner on a new mother database. Refused once anyone exists: every later owner
 * is invited by an owner. Prints a one-time link to set a password (72 hours, fragment
 * only); the second factor is enrolled at first sign-in, behind the wall.
 */
export async function bootstrapOwner(raw: z.input<typeof bootstrapInput>) {
  const parsed = bootstrapInput.safeParse(raw);
  if (!parsed.success) {
    throw new CliRefused(
      parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    );
  }
  const [existing] = await motherSql()<{ count: number }[]>`
    select count(*)::int as count from auth.users
  `;
  if ((existing?.count ?? 0) > 0) {
    throw new CliRefused('An owner already exists. Invite others from People in the console.');
  }
  return invitePerson(
    parsed.data.publicUrl,
    { email: parsed.data.email, name: parsed.data.name },
    null,
    'person.bootstrapped',
  );
}

/**
 * Clear an owner's second factor from the server (D-488's break-glass): for when there is no
 * third owner to approve a reset. Audited as the operator's.
 */
export async function breakGlassTwoFactorReset(email: string): Promise<void> {
  const address = email.trim().toLowerCase();
  await inMother(async (tx) => {
    const [person] = await tx<{ id: string }[]>`
      select id from auth.users where lower(email) = ${address} and is_active
    `;
    if (person === undefined) throw new CliRefused('No active owner with that email.');
    await clearSecondFactor(tx, person.id);
    await recordAudit(
      {
        actorUserId: null,
        action: 'person.two_factor_reset.break_glass',
        entityType: 'person',
        entityId: person.id,
        detail: { by: OPERATOR },
      },
      tx,
    );
  });
}

/** The operator, as the actor of a registry change made on the server (audited). */
const OPERATOR_ACTOR: Actor = {
  userId: OPERATOR,
  email: OPERATOR,
  name: 'Operator',
  ipAddress: null,
  requestId: null,
};

/**
 * Register a brand from the server (D-690): the same checks as Brands → Add, and the brand's
 * owner-link key made at once. The read connection comes in from the caller's environment,
 * never the command line, so a brand's database password is never typed into a chat or a
 * console, nor seen in a process list. Returns the line to paste into the brand's
 * `.env.brand` (a public key only).
 */
export async function registerBrandFromServer(
  secrets: SecretsKey,
  raw: { slug: string; displayName: string; adminUrl: string; readConnection: string },
): Promise<{ id: string; envLine: string }> {
  const parsed = brandCreateSchema.safeParse(raw);
  // Never echo the connection back: it carries the password.
  if (!parsed.success) throw brandInputRefusal(parsed.error.issues);
  const brand = await createBrand(secrets, parsed.data, OPERATOR_ACTOR);
  const key = await rotateOwnerLinkKey(secrets, brand.id, OPERATOR_ACTOR);
  return { id: brand.id, envLine: key.envLine };
}

/** Explain a refused brand input without echoing the connection, which carries a password. */
function brandInputRefusal(
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
): CliRefused {
  return new CliRefused(
    issues
      .map((issue) =>
        issue.path[0] === 'readConnection'
          ? `readConnection: ${issue.message}`
          : `${issue.path.join('.')}: ${issue.message}`,
      )
      .join('; '),
  );
}

async function brandBySlug(slug: string): Promise<BrandRow> {
  const wanted = slug.trim();
  if (!BRAND_SLUG.test(wanted))
    throw new CliRefused('--slug: lower-case letters, digits and dashes.');
  const brand = await findBrandBySlug(wanted);
  if (brand === undefined) {
    throw new CliRefused(`No brand with the slug ${wanted}. "brands list" shows them.`);
  }
  return brand;
}

/**
 * The registry, one line per brand, for the operator (D-700): what the Brands screen
 * shows, with the connection as its fingerprint only.
 */
export async function listBrandsFromServer(): Promise<string[]> {
  const rows = await listBrands();
  if (rows.length === 0) return ['No brands yet. Add one with "brands add".'];
  return rows.map((row) =>
    [
      row.slug,
      `"${row.display_name}"`,
      row.is_active ? 'read' : 'switched off',
      row.admin_url,
      `connection ${row.read_connection_fingerprint}`,
      `key ${row.owner_link_key_fingerprint ?? 'none'}`,
      `last read ${row.figures_at?.toISOString() ?? 'never'}`,
      row.last_error_code === null ? null : `error ${row.last_error_code}`,
    ]
      .filter((part): part is string => part !== null)
      .join('  '),
  );
}

/**
 * Change a brand's read connection from the server (D-700): the same checks as when it was
 * added (the read-only role and nothing else), read from the caller's environment, never
 * the command line. Returns the new fingerprint.
 */
export async function setBrandConnectionFromServer(
  secrets: SecretsKey,
  raw: { slug: string; readConnection: string },
): Promise<{ id: string; fingerprint: string }> {
  const parsed = brandConnectionSchema.safeParse({ readConnection: raw.readConnection });
  if (!parsed.success) throw brandInputRefusal(parsed.error.issues);
  const brand = await brandBySlug(raw.slug);
  const row = await setBrandConnection(
    secrets,
    brand.id,
    parsed.data.readConnection,
    OPERATOR_ACTOR,
  );
  return { id: row.id, fingerprint: row.read_connection_fingerprint };
}

/**
 * Make or replace a brand's owner-link key from the server (D-490, D-700). Returns the line
 * for the brand's `.env.brand` (a public key only); links signed with the old key stop
 * working at the brand once it restarts with the new one.
 */
export async function rotateBrandKeyFromServer(
  secrets: SecretsKey,
  slug: string,
): Promise<{ id: string; envLine: string; fingerprint: string; replaced: boolean }> {
  const brand = await brandBySlug(slug);
  const key = await rotateOwnerLinkKey(secrets, brand.id, OPERATOR_ACTOR);
  return {
    id: brand.id,
    envLine: key.envLine,
    fingerprint: key.fingerprint,
    replaced: brand.owner_link_key_fingerprint !== null,
  };
}

/** The Brands screen's "Test connection", from the server, audited as the operator's. */
export async function testBrandFromServer(
  pools: BrandPools,
  slug: string,
): Promise<ConnectionTestWire> {
  const brand = await brandBySlug(slug);
  return testConnection(pools, brand.id, OPERATOR_ACTOR);
}

/** One line for a connection test's result: a code and the versions, nothing from the brand. */
export function describeConnectionTest(result: ConnectionTestWire): string {
  const version = `version ${result.brandMigrations === null ? '?' : String(result.brandMigrations)} of ${String(result.expectedMigrations)}`;
  return result.ok
    ? `Connection test: ok (${version}).`
    : `Connection test: ${result.code} (${version}).`;
}
