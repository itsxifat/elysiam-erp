import { Inject, Injectable } from '@nestjs/common';
import { withGlobal, withOrg } from '@elysium/db';
import { recordingIdFrom } from '@elysium/domain/telephony';
import { sniffMime } from '@elysium/integrations';

import { createLogger } from '../../platform/logging/logger.js';
import { FILES_API, type FilesApi } from '../files/files.api.js';
import { RECORDING_PURPOSE } from './calls.service.js';
import { TelephonyConnectionsService } from './connections.service.js';
import { announce, TELEPHONY_SYSTEM_USER } from './ingest.service.js';
import { EnvoError, type EnvoGateway } from './providers/envo-gateway.js';
import { TELEPHONY_CONFIG, type TelephonyConfig } from './telephony.config.js';
import { TelephonyError } from './telephony.errors.js';
import * as repo from './telephony.repository.js';
import { ENVO_GATEWAY } from './telephony.tokens.js';

/** Tries before a recording is given up as failed (the job's own retries and this count agree). */
export const RECORDING_TRIES = 4;
const KEPT_TYPES = new Set(['audio/wav', 'audio/mpeg', 'audio/ogg']);
const DAY_MS = 86_400_000;

/** Thrown to have pg-boss try the download again later. */
class TryAgain extends Error {}

/**
 * Recordings (M47, D-840, D-842): a call's recording downloaded from its connection's own host
 * (`/api/v1/recordings/<id>?download=1`, with the API key, size-capped, no redirect followed),
 * kept as a private `call-recording` file, and deleted when the connection's retention runs out
 * (the call keeps its row, `expired`). Downloads and storage writes run with no transaction open
 * (invariant 6).
 */
@Injectable()
export class TelephonyRecordingsService {
  private cachedLogger: ReturnType<typeof createLogger> | undefined;

  private get logger(): ReturnType<typeof createLogger> {
    this.cachedLogger ??= createLogger('telephony');
    return this.cachedLogger;
  }

  constructor(
    private readonly connections: TelephonyConnectionsService,
    @Inject(ENVO_GATEWAY) private readonly gateway: EnvoGateway,
    @Inject(TELEPHONY_CONFIG) private readonly config: TelephonyConfig,
    @Inject(FILES_API) private readonly files: FilesApi,
  ) {}

  /** The job: keep one call's recording. Idempotent; a recording kept is never fetched again. */
  async fetch(orgId: string, callId: string): Promise<'stored' | 'failed' | 'skipped'> {
    const actor = { orgId, userId: TELEPHONY_SYSTEM_USER };
    const prepared = await withOrg(actor, async (tx) => {
      const call = await repo.callById(tx, orgId, callId, { lock: true });
      if (call?.recording_status !== 'pending' || call.recording_url === null) return null;
      const connection = await repo.connectionById(tx, orgId, call.connection_id);
      if (connection === undefined) return null;
      const attempts = call.recording_attempts + 1;
      await repo.updateCall(tx, orgId, call.id, { recordingAttempts: attempts });
      return { call, connection, attempts };
    });
    if (prepared === null) return 'skipped';

    const fail = (code: string) => this.finish(orgId, callId, { failed: code });
    const recordingId = recordingIdFrom(
      prepared.call.recording_url,
      new URL(prepared.connection.base_url).origin,
    );
    if (recordingId === null) return fail('not_connection_host');

    let download: { readonly bytes: Uint8Array; readonly mime: string | null };
    try {
      const envo = this.connections.open(prepared.connection, orgId, { requireEnabled: false });
      download = await this.gateway.downloadRecording(
        envo,
        recordingId,
        this.config.TELEPHONY_RECORDING_MAX_BYTES,
      );
    } catch (error) {
      if (error instanceof TelephonyError) return fail('no_key');
      if (error instanceof EnvoError && error.kind === 'too_large') return fail('too_large');
      const retry =
        error instanceof EnvoError &&
        (error.retryable || error.kind === 'not_found') &&
        prepared.attempts < RECORDING_TRIES;
      if (retry) throw new TryAgain(`the recording of ${callId} could not be fetched yet`);
      return fail(
        error instanceof EnvoError && error.kind === 'not_found' ? 'gone' : 'envo_refused',
      );
    }

    const sniffed = sniffMime(download.bytes);
    const mime =
      sniffed === 'audio/wav' || (sniffed !== null && KEPT_TYPES.has(sniffed)) ? sniffed : null;
    if (mime === null || download.bytes.byteLength === 0) return fail('unsupported');

    const stored = await this.files.storeProduced({
      orgId,
      ownerUserId: null,
      purpose: RECORDING_PURPOSE,
      mime,
      originalName: `call-${prepared.call.envo_call_id ?? callId}.${mime === 'audio/wav' ? 'wav' : mime === 'audio/mpeg' ? 'mp3' : 'ogg'}`,
      bytes: download.bytes,
    });
    return this.finish(orgId, callId, { fileId: stored.fileId, bytes: stored.sizeBytes });
  }

  private async finish(
    orgId: string,
    callId: string,
    result: { readonly failed: string } | { readonly fileId: string; readonly bytes: number },
  ): Promise<'stored' | 'failed' | 'skipped'> {
    return withOrg({ orgId, userId: TELEPHONY_SYSTEM_USER }, async (tx) => {
      const call = await repo.callById(tx, orgId, callId, { lock: true });
      if (call?.recording_status !== 'pending') {
        // Kept or given up meanwhile: a file kept now is nobody's.
        if ('fileId' in result)
          await this.files.forget(tx, orgId, result.fileId, RECORDING_PURPOSE);
        return 'skipped';
      }
      const moved = await repo.updateCall(
        tx,
        orgId,
        callId,
        'fileId' in result
          ? {
              recordingStatus: 'stored',
              recordingFileId: result.fileId,
              recordingBytes: result.bytes,
              recordingError: null,
            }
          : { recordingStatus: 'failed', recordingError: result.failed },
      );
      await announce(tx, orgId, moved);
      return 'fileId' in result ? 'stored' : 'failed';
    });
  }

  /**
   * Every night (D-842): each brand's recordings past their connection's retention deleted (the
   * row stays `expired`), and `call-recording` files a day old that no call took (a download
   * whose second transaction failed) forgotten. A brand that fails is logged, the next is done.
   */
  async retention(now: Date = new Date()): Promise<{ expired: number; swept: number }> {
    const orgIds = await withGlobal((tx) => repo.allOrgIds(tx));
    let expired = 0;
    let swept = 0;
    for (const orgId of orgIds) {
      const actor = { orgId, userId: TELEPHONY_SYSTEM_USER };
      try {
        for (;;) {
          const done = await withOrg(actor, async (tx) => {
            const rows = await repo.storedRecordingsPast(tx, orgId, now, 200);
            for (const row of rows) {
              await repo.updateCall(tx, orgId, row.id, {
                recordingStatus: 'expired',
                recordingFileId: null,
                recordingBytes: null,
              });
              await this.files.forget(tx, orgId, row.recording_file_id, RECORDING_PURPOSE);
            }
            return rows.length;
          });
          expired += done;
          if (done < 200) break;
        }
        swept += await this.sweepOrphans(orgId, new Date(now.getTime() - DAY_MS));
      } catch (error) {
        this.logger.error(
          { orgId, reason: error instanceof Error ? error.message : String(error) },
          'call recording retention failed for a brand',
        );
      }
    }
    return { expired, swept };
  }

  private async sweepOrphans(orgId: string, before: Date): Promise<number> {
    const actor = { orgId, userId: TELEPHONY_SYSTEM_USER };
    let after: { createdAt: string; id: string } | null = null;
    let swept = 0;
    for (;;) {
      const page: readonly { id: string; createdAt: string }[] = await withOrg(actor, (tx) =>
        this.files.filesOfPurposeBefore(tx, orgId, RECORDING_PURPOSE, before, {
          after,
          limit: 200,
        }),
      );
      if (page.length === 0) break;
      swept += await withOrg(actor, async (tx) => {
        const kept = await repo.referencedRecordingFiles(
          tx,
          orgId,
          page.map((file) => file.id),
        );
        let forgotten = 0;
        for (const file of page) {
          if (kept.has(file.id)) continue;
          if (await this.files.forget(tx, orgId, file.id, RECORDING_PURPOSE)) forgotten += 1;
        }
        return forgotten;
      });
      const last = page[page.length - 1];
      if (last === undefined || page.length < 200) break;
      after = { createdAt: last.createdAt, id: last.id };
    }
    return swept;
  }
}
