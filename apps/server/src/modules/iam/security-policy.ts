import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  Put,
  Req,
} from '@nestjs/common';
import { twoFactorPolicySchema, type MembershipRole } from '@elysium/contracts';
import { loadTwoFactorPolicy, withOrg, type Tx } from '@elysium/db';
import {
  DEFAULT_TWO_FACTOR_REQUIRED_ROLES,
  policyChange,
  readTwoFactorPolicy,
  requiresTwoFactorUnder,
  storedTwoFactorPolicy,
  TWO_FACTOR_POLICY_KEY,
  TWO_FACTOR_POLICY_ROLES,
  type TwoFactorPolicy,
  type TwoFactorPolicyRole,
} from '@elysium/domain/iam';
import { sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext, type ActiveContext } from '../../platform/http/context.js';

/**
 * Settings → Security (M40, D-691, D-692): which roles must use two-step sign-in in this brand.
 *
 * `SecurityPolicy` is held by no membership role, so only a super admin reaches these routes
 * (`manage all`); the service asks again. The choice is one `org.settings` row
 * (`security.two_factor`), read by `twoFactorStanding` for the wall, the scanner, the Staff list
 * and My account. Switching a role on walls its people who have no second factor at their next
 * request; switching it off removes nobody's factor.
 */

export interface PolicyRoleView {
  readonly role: TwoFactorPolicyRole;
  readonly required: boolean;
  /** Required when the brand has chosen nothing. */
  readonly byDefault: boolean;
  /** Active people here holding the role. */
  readonly members: number;
  /** Of those, the ones with no second factor (super admins aside). */
  readonly withoutTwoFactor: number;
}

export interface PolicyView {
  readonly roles: readonly PolicyRoleView[];
  /** Super admins always need it (D-691): shown, never switched. */
  readonly superAdminsAlways: true;
  /** No choice stored: the default applies. */
  readonly isDefault: boolean;
}

interface MemberRow extends Record<string, unknown> {
  readonly user_id: string;
  readonly role: string;
  readonly two_factor_enabled: boolean;
  readonly is_super_admin: boolean;
}

async function members(tx: Tx, orgId: string): Promise<MemberRow[]> {
  const rows = await tx.execute<MemberRow>(sql`
    select m.user_id, m.role::text as role, u.two_factor_enabled, u.is_super_admin
    from iam.memberships m join iam.users u on u.id = m.user_id
    where m.org_id = ${orgId} and m.is_active and u.is_active
  `);
  return [...rows];
}

function view(policy: TwoFactorPolicy, rows: readonly MemberRow[]): PolicyView {
  return {
    superAdminsAlways: true,
    isDefault: policy.isDefault,
    roles: TWO_FACTOR_POLICY_ROLES.map((role) => {
      const holding = rows.filter((row) => row.role === role);
      return {
        role,
        required: policy.requiredRoles.includes(role),
        byDefault: DEFAULT_TWO_FACTOR_REQUIRED_ROLES.includes(role),
        members: new Set(holding.map((row) => row.user_id)).size,
        withoutTwoFactor: new Set(
          holding
            .filter((row) => !row.two_factor_enabled && !row.is_super_admin)
            .map((row) => row.user_id),
        ).size,
      };
    }),
  };
}

/** People here the change walls: required after, not before, and with no second factor. */
function newlyWalled(
  before: TwoFactorPolicy,
  after: TwoFactorPolicy,
  rows: readonly MemberRow[],
): number {
  const byUser = new Map<string, { roles: string[]; enabled: boolean; superAdmin: boolean }>();
  for (const row of rows) {
    const entry = byUser.get(row.user_id) ?? {
      roles: [],
      enabled: row.two_factor_enabled,
      superAdmin: row.is_super_admin,
    };
    entry.roles.push(row.role);
    byUser.set(row.user_id, entry);
  }
  let count = 0;
  for (const person of byUser.values()) {
    if (person.enabled || person.superAdmin) continue;
    const was = requiresTwoFactorUnder(before, person.roles, false);
    const now = requiresTwoFactorUnder(after, person.roles, false);
    if (now && !was) count += 1;
  }
  return count;
}

@Injectable()
export class SecurityPolicyService {
  constructor(private readonly audit: AuditService) {}

  private requireSuperAdmin(context: ActiveContext): void {
    if (!context.isSuperAdmin) {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message: 'Only a super admin changes who must use two-step sign-in.',
      });
    }
  }

  async read(context: ActiveContext): Promise<PolicyView> {
    this.requireSuperAdmin(context);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) =>
      view(await loadTwoFactorPolicy(tx, context.orgId), await members(tx, context.orgId)),
    );
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    requiredRoles: readonly MembershipRole[],
  ): Promise<PolicyView & { newlyWalled: number }> {
    this.requireSuperAdmin(context);
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      // One change at a time per brand, so "before" in the audit row is the value replaced.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`${TWO_FACTOR_POLICY_KEY}:${context.orgId}`}))`,
      );
      const before = await loadTwoFactorPolicy(tx, context.orgId);
      const stored = storedTwoFactorPolicy(requiredRoles);
      await tx.execute(sql`
        insert into org.settings (org_id, key, value)
        values (${context.orgId}, ${TWO_FACTOR_POLICY_KEY}, ${JSON.stringify(stored)}::jsonb)
        on conflict (org_id, key)
        do update set value = excluded.value, updated_at = now()
      `);
      const after = readTwoFactorPolicy(stored);
      const rows = await members(tx, context.orgId);
      const change = policyChange(before, after);
      const walled = newlyWalled(before, after, rows);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'security.two_factor_policy_changed',
        entityType: 'SecurityPolicy',
        entityId: context.orgId,
        before: { requiredRoles: before.requiredRoles, isDefault: before.isDefault },
        after: {
          requiredRoles: after.requiredRoles,
          added: change.added,
          removed: change.removed,
          newlyWalled: walled,
        },
        requestId: context.requestId,
        request,
      });
      return { ...view(after, rows), newlyWalled: walled };
    });
  }
}

/**
 * `GET` and `PUT /v1/security/two-factor-policy` (D-692). `read` and `update SecurityPolicy`:
 * no membership role holds either, so the guard admits super admins only.
 */
@Controller('v1/security')
export class SecurityPolicyController {
  constructor(private readonly policy: SecurityPolicyService) {}

  @RequireAbility('read', 'SecurityPolicy')
  @Get('two-factor-policy')
  async read(@Req() request: FastifyRequest) {
    return this.policy.read(requireContext(request));
  }

  @RequireAbility('update', 'SecurityPolicy')
  @Put('two-factor-policy')
  async update(@Req() request: FastifyRequest, @Body() body: unknown) {
    const parsed = twoFactorPolicySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'requiredRoles must be a list of roles.',
      });
    }
    return this.policy.update(
      requireContext(request),
      request as unknown as AuditableRequest,
      parsed.data.requiredRoles,
    );
  }
}
