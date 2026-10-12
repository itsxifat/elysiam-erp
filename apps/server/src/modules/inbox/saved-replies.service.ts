import { Injectable } from '@nestjs/common';
import type { SavedReplyInput } from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { InboxError, mapInboxErrors } from './inbox.errors.js';
import * as repo from './saved-replies.repository.js';

const iso = (value: string | Date | null): string | null =>
  value === null ? null : new Date(value).toISOString();

export interface SavedReplyView {
  readonly id: string;
  readonly title: string;
  readonly shortcut: string;
  readonly body: string;
  readonly category: string | null;
  readonly usageCount: number;
  readonly lastUsedAt: string | null;
  readonly updatedAt: string;
}

function view(row: repo.SavedReplyRow): SavedReplyView {
  return {
    id: row.id,
    title: row.title,
    shortcut: row.shortcut,
    body: row.body,
    category: row.category,
    usageCount: row.usage_count,
    lastUsedAt: iso(row.last_used_at),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** What an audit row keeps of a saved reply: everything but who and when, which it says itself. */
function snapshot(row: repo.SavedReplyRow): Record<string, unknown> {
  return { title: row.title, shortcut: row.shortcut, body: row.body, category: row.category };
}

function notFound(): InboxError {
  return new InboxError('INBOX_NOT_FOUND', 'No such saved reply.');
}

/** A unique-index violation (23505), through Drizzle's wrapper that hangs it off `.cause`. */
function isUniqueViolation(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if ((current as Error & { code?: unknown }).code === '23505') return true;
  }
  return false;
}

function taken(shortcut: string): InboxError {
  return new InboxError(
    'INBOX_SHORTCUT_TAKEN',
    `Another saved reply already uses /${shortcut}. Choose another shortcut.`,
  );
}

/**
 * The inbox's saved replies (M44a, D-763): a shared library every inbox agent reads and uses
 * (`read SavedReply`), written and removed by the inbox's supervisor (`create`, `update`,
 * `delete SavedReply`: org_admin). Every write is audited with what it changed; using one only
 * counts it, which orders the picker and the quick-reply row.
 */
@Injectable()
export class SavedRepliesService {
  constructor(private readonly audit: AuditService) {}

  async list(context: ActiveContext) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => ({
        items: (await repo.listSavedReplies(tx, context.orgId)).map(view),
      })),
    );
  }

  async create(context: ActiveContext, request: AuditableRequest, input: SavedReplyInput) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.insertSavedReply(tx, context.orgId, input, context.userId);
        if (row === undefined) throw taken(input.shortcut);
        await this.record(tx, context, request, 'create', row.id, null, snapshot(row));
        return view(row);
      }),
    );
  }

  async update(
    context: ActiveContext,
    request: AuditableRequest,
    id: string,
    input: SavedReplyInput,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const before = await repo.savedReplyById(tx, context.orgId, id);
        if (before === undefined) throw notFound();
        if (await repo.shortcutTaken(tx, context.orgId, input.shortcut, id)) {
          throw taken(input.shortcut);
        }
        // Two people renaming to one shortcut at once: the unique index is the backstop.
        const row = await repo
          .updateSavedReply(tx, context.orgId, id, input, context.userId)
          .catch((error: unknown) => {
            if (isUniqueViolation(error)) throw taken(input.shortcut);
            throw error;
          });
        if (row === undefined) throw notFound();
        await this.record(tx, context, request, 'update', id, snapshot(before), snapshot(row));
        return view(row);
      }),
    );
  }

  async remove(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const row = await repo.deleteSavedReply(tx, context.orgId, id);
        if (row === undefined) throw notFound();
        await this.record(tx, context, request, 'delete', id, snapshot(row), null);
        return { id, deleted: true as const };
      }),
    );
  }

  /** Inserted into a reply: counted, and audited as a use (who used which, and when). */
  async use(context: ActiveContext, request: AuditableRequest, id: string) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const count = await repo.bumpSavedReply(tx, context.orgId, id);
        if (count === undefined) throw notFound();
        await this.record(tx, context, request, 'update', id, null, { usageCount: count }, 'use');
        return { id, usageCount: count };
      }),
    );
  }

  private async record(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    operation: 'create' | 'update' | 'delete',
    id: string,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    action: string = operation,
  ): Promise<void> {
    await this.audit.record(tx, {
      orgId: context.orgId,
      actorUserId: context.userId,
      operation,
      action: `inbox.saved_reply.${action}`,
      entityType: 'inbox_saved_reply',
      entityId: id,
      before,
      after,
      requestId: context.requestId,
      request,
    });
  }
}
