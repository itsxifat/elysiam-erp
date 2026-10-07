import { z } from 'zod';

import { recordAudit } from './audit/audit.js';
import { inMother, motherSql } from './db/client.js';
import { clearSecondFactor, invitePerson } from './people/people.js';

/**
 * The operator's commands on the mother's server (D-487, D-488): the first owner, and the
 * break-glass reset of an owner's second factor when no third owner can approve one.
 * Pure of process concerns, so the tests drive them; `main.cli.ts` wires them to argv.
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
