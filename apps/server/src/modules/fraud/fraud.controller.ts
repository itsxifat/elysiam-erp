import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { withOrg } from '@elysium/db';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { RequireAbility } from '../../platform/auth/abilities.js';
import { requireContext } from '../../platform/http/context.js';
import { scopeHasNoRowDimension } from '../../platform/auth/scope.js';
import { mapFraudErrors } from './fraud.errors.js';
import {
  clearFlagSchema,
  fraudCheckQuerySchema,
  raiseFlagSchema,
  setRulesSchema,
} from './fraud.schemas.js';
import { FraudService } from './fraud.service.js';

function parse<T extends z.ZodType>(schema: T, value: unknown): z.infer<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message);
  return parsed.data;
}

const auditable = (request: FastifyRequest): AuditableRequest =>
  request as unknown as AuditableRequest;

/**
 * The fraud badge over HTTP (architecture §6, §10, §23).
 *
 * §6's matrix has exactly two fraud cells and they map to the two abilities used here:
 *
 * * **`read FraudSignal`** — the badge and its reasons. org_admin and sales at `org`,
 *   accounts at `org`, branch_manager at `branch`, reseller at `own`. Everything this
 *   controller returns is counts plus a score, which is what the matrix means by "the
 *   fraud trust badge and reasons".
 * * **`update FraudOverride`** — org_admin only. It covers the block override (check 5,
 *   exercised through the orders module's confirm) and, here, raising and clearing a
 *   manual flag and editing the org's bands.
 *
 * Flags and bands under the *override* ability is a decision, not a transcription. §6 has
 * no cell for either, and the two candidates were wrong in different ways: `read
 * FraudSignal` would let every sales agent raise a flag that blocks the brand's sales,
 * and inventing a `FraudRule` subject would mean editing the permission matrix and its
 * spec fixture — a change to §6 that ought to be a decision row rather than a side effect
 * of this milestone. Both actions are an org_admin making a standing decision about a
 * buyer that changes whether the brand will sell to them, which is exactly what the
 * override cell describes.
 *
 * ## What is deliberately absent
 *
 * There is **no route that takes a phone hash**, and no response contains one. A hash is a
 * stable identifier for one person across all five brands, so an endpoint accepting one
 * would let a caller probe the cross-org table for a number they cannot spell — and a
 * response carrying one would hand every client a correlation key. Callers pass the
 * number; the hash exists only between `PhoneHashService` and the tables.
 *
 * There is also no route that confirms an order. The confirm guard is
 * `FRAUD_API.assertConfirmAllowed`, called by the orders module inside its own
 * transaction, because the override record and the order's new status have to commit
 * together (check 5).
 */
@Controller('v1/fraud')
export class FraudController {
  constructor(private readonly fraud: FraudService) {}

  /**
   * The badge for a phone number.
   *
   * A GET with the number in the query string, which is a considered choice rather than
   * the default one. It means the number reaches the access log, so §26's logger is
   * configured to redact query strings on this path — and the alternative, a POST, would
   * be a mutation-shaped request for a read, would not cache, and would still put the
   * number in a body that error handlers echo. The number is not a secret; it is personal
   * data, and the control for it is masking at the log (invariant 10), which is one place
   * rather than every caller.
   */
  @RequireAbility('read', 'FraudSignal')
  @Get('check')
  async check(@Req() request: FastifyRequest, @Query() query: unknown) {
    const context = requireContext(request);
    scopeHasNoRowDimension(
      request,
      'a fraud badge is a per-phone aggregate across every brand (§10): no created_by, no branch_id',
    );
    const { phone } = parse(fraudCheckQuerySchema, query ?? {});

    return mapFraudErrors(async () =>
      withOrg(
        { orgId: context.orgId, userId: context.userId, requestId: context.requestId },
        async (tx) => {
          const badge = await this.fraud.assess(tx, { orgId: context.orgId, phone });
          // This brand's own flags, with their reasons. They are not in the badge because
          // the badge is the cross-org part; these never leave the org that wrote them.
          const flags = await this.fraud.flagsFor(tx, { orgId: context.orgId, phone });
          return {
            ...badge,
            flags: flags.map((flag) => ({
              id: flag.id,
              severity: flag.severity,
              reason: flag.reason,
              createdBy: flag.createdBy,
              createdAt: flag.createdAt.toISOString(),
              clearedAt: flag.clearedAt?.toISOString() ?? null,
            })),
          };
        },
      ),
    );
  }

  /** This org's bands, or D-011's defaults when it has never set any. */
  @RequireAbility('read', 'FraudSignal')
  @Get('rules')
  async rules(@Req() request: FastifyRequest) {
    const context = requireContext(request);
    scopeHasNoRowDimension(
      request,
      'one rules row per org; §6 scopes it by org and nothing narrower',
    );
    return mapFraudErrors(async () =>
      withOrg(
        { orgId: context.orgId, userId: context.userId, requestId: context.requestId },
        async (tx) => {
          const { bands, rules } = await this.fraud.bandsFor(tx, context.orgId);
          return {
            ...bands,
            providerEnabled: rules.providerEnabled,
            providerTtlMinutes: rules.providerTtlMinutes,
          };
        },
      ),
    );
  }

  @RequireAbility('update', 'FraudOverride')
  @Put('rules')
  async setRules(@Req() request: FastifyRequest, @Body() body: unknown) {
    const context = requireContext(request);
    const input = parse(setRulesSchema, body);

    return mapFraudErrors(async () =>
      withOrg(
        { orgId: context.orgId, userId: context.userId, requestId: context.requestId },
        async (tx) =>
          this.fraud.setRules(tx, {
            orgId: context.orgId,
            rules: input,
            actorUserId: context.userId,
            request: auditable(request),
          }),
      ),
    );
  }

  @RequireAbility('update', 'FraudOverride')
  @Post('flags')
  async raiseFlag(@Req() request: FastifyRequest, @Body() body: unknown) {
    const context = requireContext(request);
    const input = parse(raiseFlagSchema, body);

    return mapFraudErrors(async () =>
      withOrg(
        { orgId: context.orgId, userId: context.userId, requestId: context.requestId },
        async (tx) =>
          this.fraud.raiseFlag(tx, {
            orgId: context.orgId,
            phone: input.phone,
            severity: input.severity,
            reason: input.reason,
            actorUserId: context.userId,
            request: auditable(request),
          }),
      ),
    );
  }

  @RequireAbility('update', 'FraudOverride')
  @Post('flags/:id/clear')
  async clearFlag(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) {
    const context = requireContext(request);
    const input = parse(clearFlagSchema, body);

    return mapFraudErrors(async () =>
      withOrg(
        { orgId: context.orgId, userId: context.userId, requestId: context.requestId },
        async (tx) => {
          await this.fraud.clearFlag(tx, {
            orgId: context.orgId,
            flagId: id,
            reason: input.reason,
            actorUserId: context.userId,
            request: auditable(request),
          });
          return { cleared: true };
        },
      ),
    );
  }

  /**
   * The overrides recorded against one order (check 5's read side).
   *
   * `read FraudSignal`, not the override ability: an agent looking at an order should be
   * able to see that it was confirmed past a block and by whom, without being able to do
   * it themselves. That is the same split §6 draws between the badge row and the override
   * row.
   */
  @RequireAbility('read', 'FraudSignal')
  @Get('orders/:orderId/overrides')
  async overrides(@Req() request: FastifyRequest, @Param('orderId') orderId: string) {
    const context = requireContext(request);
    scopeHasNoRowDimension(
      request,
      'overrides are listed for one named order, which the caller already had to reach',
    );
    return mapFraudErrors(async () =>
      withOrg(
        { orgId: context.orgId, userId: context.userId, requestId: context.requestId },
        async (tx) => {
          const rows = await this.fraud.overridesFor(tx, context.orgId, orderId);
          return rows.map((row) => ({
            id: row.id,
            trustScore: row.trustScore,
            reason: row.reason,
            decidedBy: row.decidedBy,
            createdAt: row.createdAt.toISOString(),
          }));
        },
      ),
    );
  }
}
