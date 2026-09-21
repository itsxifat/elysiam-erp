import { randomUUID } from 'node:crypto';

import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { withOrg, withSystem, type MembershipRole } from '@elysium/db';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

const ROLES: readonly MembershipRole[] = [
  'org_admin',
  'sales',
  'accounts',
  'marketing',
  'hr',
  'branch_manager',
  'warehouse',
  'reseller',
  'investor',
];

/** What the auth plugin hangs off the request once a session is resolved. */
export interface AuthenticatedRequest extends FastifyRequest {
  authUser?: { id: string; email: string };
  authSessionId?: string;
  requestId?: string;
}

@Injectable()
export class IamService {
  requireUserId(request: FastifyRequest): string {
    const userId = (request as AuthenticatedRequest).authUser?.id;
    if (userId === undefined || userId === '') {
      throw new BadRequestException('Not signed in.');
    }
    return userId;
  }

  requestId(request: FastifyRequest): string {
    return (request as AuthenticatedRequest).requestId ?? randomUUID();
  }

  /**
   * Record the chosen org on the session row.
   *
   * On the session rather than in a cookie, so the client cannot change which
   * org it is acting in without a round trip that re-checks membership. A
   * client-controlled org id would make every RLS policy in the system
   * advisory.
   */
  async setActiveOrg(request: FastifyRequest, orgId: string): Promise<void> {
    const sessionId = (request as AuthenticatedRequest).authSessionId;
    if (sessionId === undefined) throw new BadRequestException('No session.');

    await withSystem(async (tx) => {
      await tx.execute(
        sql`update iam.sessions set active_org_id = ${orgId}, updated_at = now() where id = ${sessionId}`,
      );
    });
  }

  /**
   * Create a user and give them one role in this org.
   *
   * The user row is global and the membership is tenant-scoped, so this writes
   * in two contexts on purpose: an existing person joining a second brand must
   * reuse their identity rather than get a duplicate account.
   */
  async createUserWithMembership(input: {
    orgId: string;
    email: string;
    name: string;
    role: string;
    branchIds: readonly string[];
  }): Promise<{ userId: string; membershipId: string; created: boolean }> {
    const email = input.email.trim().toLowerCase();
    if (email === '' || !email.includes('@')) {
      throw new BadRequestException('A valid email is required.');
    }
    if (!ROLES.includes(input.role as MembershipRole)) {
      throw new BadRequestException(`Unknown role "${input.role}".`);
    }

    const existing = await withSystem(async (tx) =>
      tx.execute<{ id: string }>(sql`select id from iam.users where email = ${email}`),
    );

    let userId = existing[0]?.id;
    const created = userId === undefined;

    if (userId === undefined) {
      userId = `usr_${randomUUID()}`;
      const id = userId;
      await withSystem(async (tx) => {
        await tx.execute(sql`
          insert into iam.users (id, email, name, email_verified)
          values (${id}, ${email}, ${input.name || email}, false)
        `);
      });
    }

    const resolvedUserId = userId;

    return withOrg({ orgId: input.orgId, userId: resolvedUserId }, async (tx) => {
      const inserted = await tx.execute<{ id: string }>(sql`
        insert into iam.memberships (org_id, user_id, role)
        values (${input.orgId}, ${resolvedUserId}, ${input.role}::iam.membership_role)
        on conflict (org_id, user_id, role) do update set is_active = true
        returning id
      `);

      const membershipId = inserted[0]?.id;
      if (membershipId === undefined) {
        throw new ConflictException('Could not create the membership.');
      }

      for (const branchId of input.branchIds) {
        await tx.execute(sql`
          insert into iam.membership_branches (org_id, membership_id, branch_id)
          values (${input.orgId}, ${membershipId}, ${branchId})
          on conflict (membership_id, branch_id) do nothing
        `);
      }

      return { userId: resolvedUserId, membershipId, created };
    });
  }
}
