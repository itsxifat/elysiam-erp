import { Inject, Injectable } from '@nestjs/common';
import { withGlobal, withOrg } from '@elysium/db';
import {
  CLICK_TO_CALL_STALE_MS,
  parseEnvoCall,
  type EnvoCallFacts,
} from '@elysium/domain/telephony';

import { enqueue } from '../../platform/jobs/enqueue.js';
import { createLogger } from '../../platform/logging/logger.js';
import { envoFailure, TelephonyConnectionsService } from './connections.service.js';
import { announce, TELEPHONY_SYSTEM_USER, TelephonyIngestService } from './ingest.service.js';
import { EnvoError, type EnvoGateway } from './providers/envo-gateway.js';
import { TELEPHONY_QUEUES } from './telephony.queues.js';
import * as repo from './telephony.repository.js';
import { ENVO_GATEWAY } from './telephony.tokens.js';

/** The first sync of a connection reads this far back; later ones from the cursor. */
const FIRST_SYNC_MS = 24 * 3600_000;
/** Each sync re-reads this much before its cursor, for calls that were still going. */
const OVERLAP_MS = 15 * 60_000;
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

/**
 * The sync (M47, D-839): every five minutes each enabled connection's call history
 * (`GET /api/v1/calls`, finished calls, newest first, paged) since its cursor is applied exactly
 * as `call.ended` webhooks would be, so a webhook Envo could not deliver (the ERP down, a wrong
 * secret for a while) still lands on the right customer and order, with its recording. Clicks
 * Envo took and never described are closed as not connected. A connection Envo refuses keeps the
 * reason for Settings → Calls; the next sweep tries again.
 */
@Injectable()
export class TelephonySyncService {
  private cachedLogger: ReturnType<typeof createLogger> | undefined;

  private get logger(): ReturnType<typeof createLogger> {
    this.cachedLogger ??= createLogger('telephony');
    return this.cachedLogger;
  }

  constructor(
    private readonly connections: TelephonyConnectionsService,
    private readonly ingest: TelephonyIngestService,
    @Inject(ENVO_GATEWAY) private readonly gateway: EnvoGateway,
  ) {}

  /** The sweep: one sync job per enabled connection of every brand. */
  async sweep(): Promise<{ readonly queued: number }> {
    const orgIds = await withGlobal((tx) => repo.allOrgIds(tx));
    let queued = 0;
    for (const orgId of orgIds) {
      try {
        queued += await withOrg({ orgId, userId: TELEPHONY_SYSTEM_USER }, async (tx) => {
          const ids = await repo.syncableConnectionIds(tx, orgId);
          for (const connectionId of ids) {
            await enqueue(
              tx,
              TELEPHONY_QUEUES.syncConnection.name,
              { connectionId },
              { orgId, ref: connectionId, singletonKey: `sync:${connectionId}` },
            );
          }
          return ids.length;
        });
      } catch (error) {
        this.logger.error(
          { orgId, reason: error instanceof Error ? error.message : String(error) },
          'the telephony sync sweep failed for a brand',
        );
      }
    }
    return { queued };
  }

  /** One connection's sync. Returns how many calls Envo listed. */
  async syncConnection(
    orgId: string,
    connectionId: string,
    now: Date = new Date(),
  ): Promise<{ readonly listed: number; readonly closed: number }> {
    const actor = { orgId, userId: TELEPHONY_SYSTEM_USER };
    let row: repo.ConnectionRow;
    let envo;
    try {
      ({ row, envo } = await this.connections.credentials(actor, connectionId, {
        requireEnabled: true,
      }));
    } catch {
      return { listed: 0, closed: 0 };
    }
    const cursor = row.sync_cursor === null ? null : new Date(row.sync_cursor);
    const from = new Date((cursor?.getTime() ?? now.getTime() - FIRST_SYNC_MS) - OVERLAP_MS);
    let listed = 0;
    let newest: Date | null = null;
    let error: string | null = null;
    try {
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        const answer = await this.gateway.callHistory(envo, { from, page, limit: PAGE_SIZE });
        const facts = answer.calls
          .map((call) => parseEnvoCall(call, 'sync'))
          .filter((call): call is EnvoCallFacts => call !== null && !call.test);
        await withOrg(actor, async (tx) => {
          for (const call of facts) {
            await this.ingest.apply(tx, orgId, row, call, 'sync', now);
          }
        });
        for (const call of facts) {
          if (call.startedAt !== null && (newest === null || call.startedAt > newest)) {
            newest = call.startedAt;
          }
        }
        listed += facts.length;
        if (answer.calls.length < PAGE_SIZE) break;
      }
    } catch (cause) {
      if (!(cause instanceof EnvoError)) throw cause;
      error = envoFailure(cause).message;
    }
    const closed = await withOrg(actor, async (tx) => {
      const stale = await repo.staleClicks(
        tx,
        orgId,
        connectionId,
        new Date(now.getTime() - CLICK_TO_CALL_STALE_MS),
      );
      for (const click of stale) {
        const moved = await repo.updateCall(tx, orgId, click.id, {
          status: 'ended',
          errorCode: 'not_connected',
          endedAt: now,
        });
        await announce(tx, orgId, moved);
      }
      await repo.recordSync(tx, orgId, connectionId, { cursor: newest, error });
      return stale.length;
    });
    if (error !== null) {
      this.logger.warn({ orgId, connectionId, reason: error }, 'an Envo call history read failed');
    }
    return { listed, closed };
  }
}
