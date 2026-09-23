import { Injectable } from '@nestjs/common';
import { changedFields, redact } from '@elysium/domain';
import type { Tx } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * The audit log (architecture §25).
 *
 * Two ways in, and the split is the point:
 *
 * - `record(tx, …)` writes **inside the caller's transaction**. This is the
 *   real one. An audit row written in a separate transaction can commit while
 *   the mutation rolls back — inventing history — or the mutation can commit
 *   while the audit write fails, losing it. Neither is acceptable for a table
 *   whose job is to be the record of what happened, so the write is atomic
 *   with the thing it describes.
 * - The interceptor, which catches anything a service forgot. It runs after
 *   the response and therefore in its own transaction, so it is a safety net
 *   rather than the mechanism. `.claude/rules` says never bypass the
 *   interceptor; this says never rely on it alone either.
 */

export type AuditOperation =
  'create' | 'update' | 'delete' | 'approve' | 'reject' | 'login' | 'logout';

export interface AuditEntry {
  readonly orgId: string;
  readonly actorUserId: string | null;
  readonly operation: AuditOperation;
  /** The business verb: `order.confirmed`, `wallet.adjusted`. */
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly before?: Record<string, unknown> | null;
  readonly after?: Record<string, unknown> | null;
  readonly ip?: string | null;
  readonly userAgent?: string | null;
  readonly requestId?: string | null;
}

@Injectable()
export class AuditService {
  /**
   * Write one entry, in the caller's transaction.
   *
   * `before` and `after` are redacted here rather than by the caller, so a
   * module cannot forget: the redaction is a property of the log, not a
   * courtesy each writer performs. §25 asks for it, and `audit.audit_log` is
   * append-only — a credential written here cannot be tidied away later.
   */
  async record(tx: Tx, entry: AuditEntry): Promise<void> {
    const before = entry.before == null ? null : redact(entry.before);
    const after = entry.after == null ? null : redact(entry.after);

    await tx.execute(sql`
      insert into audit.audit_log (
        org_id, actor_user_id, operation, action,
        entity_type, entity_id, before, after,
        ip, user_agent, request_id
      ) values (
        ${entry.orgId},
        ${entry.actorUserId},
        ${entry.operation}::audit.audit_operation,
        ${entry.action},
        ${entry.entityType},
        ${entry.entityId},
        ${before === null ? null : JSON.stringify(before)}::jsonb,
        ${after === null ? null : JSON.stringify(after)}::jsonb,
        ${entry.ip ?? null},
        ${entry.userAgent ?? null},
        ${entry.requestId ?? null}
      )
    `);
  }

  /** Which fields changed, both sides already redacted (see the domain). */
  changed(before: Record<string, unknown> | null, after: Record<string, unknown> | null): string[] {
    return changedFields(before, after);
  }
}
