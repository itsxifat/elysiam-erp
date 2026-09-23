import { index, jsonb, pgSchema, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { organizations } from '../org/index.js';
import { primaryId } from '../columns.js';

/**
 * The audit log (architecture §25).
 *
 * Every mutation records actor, org, action, entity, before and after, with
 * sensitive fields redacted, plus the request that caused it. Append-only: the
 * migration grants `erp_app` INSERT and SELECT and nothing else, so a bug that
 * tries to tidy history fails rather than succeeds quietly.
 *
 * No `updated_at`. A row that can be updated is not an audit log, and the
 * shared `timestamps` helper would have implied one.
 */
export const audit = pgSchema('audit');

/**
 * What happened. Deliberately coarse: `create`, `update`, `delete` are facts
 * about the row, while the interesting *business* verb lives in `action` on
 * the entity side. A long enum here would need a migration per feature.
 */
export const auditOperation = audit.enum('audit_operation', [
  'create',
  'update',
  'delete',
  'approve',
  'reject',
  'login',
  'logout',
]);

export const auditLog = audit.table(
  'audit_log',
  {
    id: primaryId,
    orgId: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),

    /**
     * Who. Nullable on purpose: a failed login has no actor yet, and a job run
     * by the worker has no user at all. A row whose actor is null is a system
     * action, and the query that asks "what did this person do" naturally
     * excludes them.
     */
    actorUserId: text('actor_user_id'),

    operation: auditOperation('operation').notNull(),
    /** The business verb: `order.confirmed`, `wallet.adjusted`. */
    action: text('action').notNull(),

    entityType: text('entity_type').notNull(),
    /** Text rather than uuid: not every entity is keyed by one. */
    entityId: text('entity_id').notNull(),

    /**
     * The row before and after, already redacted. `before` is null on a create
     * and `after` is null on a delete, which is how you tell them apart without
     * trusting `operation` to be right.
     */
    before: jsonb('before'),
    after: jsonb('after'),

    /** §25 asks for both. `ip` is inet-shaped but kept text for IPv6 and proxies. */
    ip: text('ip'),
    userAgent: text('user_agent'),
    /** Ties a row back to the request that caused it (§26). */
    requestId: text('request_id'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    index('audit_log_org_idx').on(table.orgId),
    // The three questions this table is actually asked: what happened to this
    // entity, what did this person do, and what happened in this window.
    index('audit_log_entity_idx').on(table.orgId, table.entityType, table.entityId),
    index('audit_log_actor_idx').on(table.orgId, table.actorUserId),
    index('audit_log_created_idx').on(table.orgId, table.createdAt),
  ],
);
