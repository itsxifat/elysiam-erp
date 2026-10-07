import { redact } from '@elysium/domain';
import type { JSONValue, Sql, TransactionSql } from 'postgres';

import { motherSql } from '../db/client.js';

/**
 * The mother's audit log (D-487): every sign-in, owner link, brand change and people action.
 *
 * Append-only by grant and by trigger (migration 0001). The detail is passed through the
 * brand's own `redact`, so a credential-named field never lands in a table nobody can tidy.
 * It holds codes, ids and fingerprints, never a connection string or a key.
 */

export interface AuditEntry {
  readonly actorUserId: string | null;
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly ipAddress?: string | null;
  readonly requestId?: string | null;
}

export async function recordAudit(
  entry: AuditEntry,
  tx: Sql | TransactionSql = motherSql(),
): Promise<void> {
  const detail = redact(entry.detail ?? {}) as Record<string, unknown>;
  await tx`
    insert into mother.audit_log
      (actor_user_id, action, entity_type, entity_id, detail, ip_address, request_id)
    values (${entry.actorUserId}, ${entry.action}, ${entry.entityType}, ${entry.entityId ?? null},
            ${tx.json(detail as JSONValue)}, ${entry.ipAddress ?? null},
            ${entry.requestId ?? null})
  `;
}

/** Who is acting and from where: carried from the request into every audit row. */
export interface Actor {
  readonly userId: string;
  readonly email: string;
  readonly name: string;
  readonly ipAddress: string | null;
  readonly requestId: string | null;
}
