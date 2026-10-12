import type { Tx } from '@elysium/db';

import * as kept from './voice-calls.repository.js';

/**
 * A thread page's attachments as the console shows them (M45, D-780, D-784): each kept
 * attachment with its file (`fileId`, played through `GET /v1/inbox/media/:fileId`), whether it
 * is still downloading (`media`), and its length; and each call entry with the call as it stands
 * now. Meta's own link and media id stay as M42 stored them. Messages with nothing to add are
 * left out of the map.
 */
export async function attachmentsForThread(
  tx: Tx,
  orgId: string,
  messages: readonly { readonly id: string; readonly attachments: unknown }[],
  names: ReadonlyMap<string, string>,
): Promise<Map<string, Record<string, unknown>[]>> {
  const out = new Map<string, Record<string, unknown>[]>();
  const listed = messages.map((message) => ({
    id: message.id,
    attachments: Array.isArray(message.attachments)
      ? (message.attachments as unknown[]).filter(
          (item): item is Record<string, unknown> => typeof item === 'object' && item !== null,
        )
      : [],
  }));
  const callIds = listed.flatMap((message) =>
    message.attachments
      .filter((item) => item.type === 'call' && typeof item.callId === 'string')
      .map((item) => item.callId as string),
  );
  const withMedia = listed.filter((message) =>
    message.attachments.some((item) => item.type === 'audio' || item.type === 'image'),
  );
  if (callIds.length === 0 && withMedia.length === 0) return out;

  const media = await kept.mediaOfMessages(
    tx,
    orgId,
    withMedia.map((message) => message.id),
  );
  const mediaAt = new Map(media.map((row) => [`${row.message_id}:${String(row.position)}`, row]));
  const callRows = await kept.callsByIds(tx, orgId, callIds);
  const callOf = new Map(callRows.map((row) => [row.id, row]));
  const person = (userId: string | null) =>
    userId === null ? null : { userId, name: names.get(userId) ?? null };
  const iso = (value: string | Date | null) =>
    value === null ? null : new Date(value).toISOString();

  for (const message of listed) {
    let changed = false;
    const attachments = message.attachments.map((item, position) => {
      if (item.type === 'call' && typeof item.callId === 'string') {
        const call = callOf.get(item.callId);
        if (call === undefined) return item;
        changed = true;
        return {
          type: 'call',
          callId: call.id,
          call: {
            id: call.id,
            channel: call.channel_kind,
            direction: call.direction,
            status: call.status,
            startedAt: new Date(call.started_at).toISOString(),
            connectedAt: iso(call.connected_at),
            endedAt: iso(call.ended_at),
            durationSeconds: call.duration_seconds,
            answeredBy: person(call.answered_by),
            declinedBy: person(call.declined_by),
            callbackNeeded: call.callback_needed,
            callbackDoneBy: person(call.callback_done_by),
            callbackDoneAt: iso(call.callback_done_at),
            callbackPhone: call.channel_kind === 'whatsapp' ? `+${call.external_user_id}` : null,
          },
        };
      }
      const row = mediaAt.get(`${message.id}:${String(position)}`);
      if (row === undefined) return item;
      changed = true;
      return {
        ...item,
        media: row.status,
        ...(row.file_id === null ? {} : { fileId: row.file_id }),
        ...(row.mime === null ? {} : { mimeType: row.mime }),
        ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
        ...(row.error_code === null ? {} : { mediaError: row.error_code }),
      };
    });
    if (changed) out.set(message.id, attachments);
  }
  return out;
}
