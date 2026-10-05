import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { withOrg } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { assertInScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import * as refs from './references.repository.js';

/** The code ranges a brand's own heads take: the chart's template uses neither (D-634). */
const RANGES = {
  income: { from: 4500, to: 4599 },
  expense: { from: 5900, to: 5999 },
} as const;

/**
 * The brand's expense and income heads (M39a, D-634): the categories a cash entry is booked
 * against ("Electricity", "Staff tea", "Scrap sale").
 *
 * - **Add**: a new `operating_expense` or `other_income` account, its code the next free one
 *   in its range, never chosen by the caller (the class and normal balance follow from the
 *   subtype, as for every account, 0015).
 * - **Rename, archive, restore**: only a head the brand added. The seeded heads are the
 *   chart's own (`is_system`): the seed restores their names, and postings look some of them
 *   up by subtype, so they stay as they are.
 * - **Never delete** (§7, D-121): `ledger.accounts` has no DELETE grant, and a head with a
 *   posted line is part of the books for good. An archived head leaves the cash-entry picker
 *   (a cash entry against an inactive one is already refused) and keeps its history.
 *
 * Org-wide only: a branch manager books against heads but does not set the chart up.
 */
@Injectable()
export class HeadsService {
  constructor(private readonly audit: AuditService) {}

  async list(context: ActiveContext, request: object) {
    assertInScope(request, { branchId: null });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
      items: (await refs.heads(tx, context.orgId)).map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        kind: row.subtype === 'other_income' ? 'income' : 'expense',
        isActive: row.is_active,
        isSystem: row.is_system,
      })),
    }));
  }

  async create(
    context: ActiveContext,
    request: AuditableRequest,
    input: { readonly name: string; readonly kind: 'income' | 'expense' },
  ) {
    assertInScope(request, { branchId: null });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const range = RANGES[input.kind];
      const code = await refs.nextHeadCode(tx, context.orgId, range.from, range.to);
      if (code === undefined) {
        throw new ConflictException({
          code: 'LEDGER_ACCOUNT_INVALID',
          message: `This brand has used every ${input.kind} head number; archive one it no longer uses.`,
        });
      }
      const id = await refs.insertHead(tx, context.orgId, {
        code,
        name: input.name,
        kind: input.kind,
      });
      if (id === undefined) {
        throw new ConflictException({
          code: 'LEDGER_ACCOUNT_INVALID',
          message: 'Another head was added at the same moment; try again.',
        });
      }
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'create',
        action: 'wallets.head.created',
        entityType: 'LedgerAccount',
        entityId: id,
        before: null,
        after: { code, name: input.name, kind: input.kind },
        requestId: context.requestId,
        request,
      });
      return { id, code, name: input.name, kind: input.kind, isActive: true, isSystem: false };
    });
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    patch: { readonly name?: string | undefined; readonly isActive?: boolean | undefined },
  ) {
    assertInScope(request, { branchId: null });
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const head = await refs.lockHead(tx, context.orgId, id);
      if (head === undefined) {
        throw new NotFoundException({ code: 'LEDGER_ACCOUNT_NOT_FOUND', message: 'No such head.' });
      }
      if (head.is_system) {
        throw new ConflictException({
          code: 'LEDGER_ACCOUNT_INVALID',
          message: `${head.name} is one of the chart's own heads; it keeps its name and stays in use. Add a head of your own instead.`,
        });
      }
      await refs.updateHead(tx, context.orgId, id, patch);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action:
          patch.isActive === false
            ? 'wallets.head.archived'
            : patch.isActive === true
              ? 'wallets.head.restored'
              : 'wallets.head.renamed',
        entityType: 'LedgerAccount',
        entityId: id,
        before: { name: head.name, isActive: head.is_active },
        after: { ...patch, postedLines: await refs.headLines(tx, context.orgId, id) },
        requestId: context.requestId,
        request,
      });
      return {
        id,
        code: head.code,
        name: patch.name ?? head.name,
        kind: head.subtype === 'other_income' ? 'income' : 'expense',
        isActive: patch.isActive ?? head.is_active,
        isSystem: false,
      };
    });
  }
}
