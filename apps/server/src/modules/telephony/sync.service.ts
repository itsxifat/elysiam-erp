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
import {
  EnvoError,
  type EnvoCallHistoryPage,
  type EnvoConnection,
  type EnvoGateway,
  type EnvoLiveCall,
} from './providers/envo-gateway.js';
import { TelephonyError } from './telephony.errors.js';
import { TELEPHONY_QUEUES } from './telephony.queues.js';
import * as repo from './telephony.repository.js';
import { ENVO_GATEWAY } from './telephony.tokens.js';

/** The first sync of a connection reads this far back; later ones from the cursor. */
const FIRST_SYNC_MS = 24 * 3600_000;
/**
 * Envo lists a call only once it has ended, under the time it started (its CDR's `calldate`). So
 * the cursor stays this far behind now: a call this long, still going during one sync, is read
 * by a later one when it ends.
 */
export const LONGEST_CALL_MS = 2 * 3600_000;
/** And each sync re-reads this much before its cursor, for the clocks of Envo and the ERP. */
const OVERLAP_MS = 5 * 60_000;
const PAGE_SIZE = 200;
/** Requests one sync may make: Envo allows a key 120 a minute, shared with the brand's calls. */
const MAX_REQUESTS = 20;
/** A window is not halved below this, however busy it was. */
const MIN_WINDOW_MS = 60_000;

/**
 * The sync (M47, D-839): every five minutes each enabled connection's call history
 * (`GET /api/v1/calls`, finished calls) since its cursor is applied exactly as `call.ended`
 * webhooks would be, so a webhook Envo could not deliver (the ERP down, a wrong secret for a
 * while) still lands on the right customer and order, with its recording.
 *
 * The history is read oldest window first (`from` and `to`), each window to its last page, and
 * a window with more calls than the requests left is halved first, using Envo's `total`. The
 * cursor moves only past windows read to the end, and never closer to now than the longest call:
 * a page Envo refused, a backlog bigger than one sync, or a long call still going is read by the
 * next sync instead of skipped. Clicks Envo took and never described are closed as not
 * connected, unless Envo shows a call in progress on their extension. A connection Envo refuses,
 * or whose key no longer opens, keeps the reason for Settings → Calls; the next sweep tries again.
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

  /** One connection's sync. Returns how many history rows were applied, and clicks closed. */
  async syncConnection(
    orgId: string,
    connectionId: string,
    now: Date = new Date(),
  ): Promise<{ readonly listed: number; readonly closed: number }> {
    const actor = { orgId, userId: TELEPHONY_SYSTEM_USER };
    const row = await withOrg(actor, (tx) => repo.connectionById(tx, orgId, connectionId));
    // Gone, or switched off since the sweep queued it: nothing to read.
    if (row?.enabled !== true) return { listed: 0, closed: 0 };
    let envo: EnvoConnection;
    try {
      envo = this.connections.open(row, orgId, { requireEnabled: true });
    } catch (cause) {
      if (!(cause instanceof TelephonyError)) throw cause;
      // The key no longer opens (the credentials key changed): say so on the connection, and
      // close only the clicks too old to be any call still going, as Envo cannot be asked.
      const closed = await this.closeStale(orgId, row, now, null);
      await withOrg(actor, (tx) =>
        repo.recordSync(tx, orgId, connectionId, { cursor: null, error: cause.message }),
      );
      this.logger.warn(
        { orgId, connectionId, reason: cause.message },
        'a telephony sync could not start',
      );
      return { listed: 0, closed };
    }

    const cursor = row.sync_cursor === null ? null : new Date(row.sync_cursor);
    const from = new Date((cursor?.getTime() ?? now.getTime() - FIRST_SYNC_MS) - OVERLAP_MS);
    const read = await this.readHistory(orgId, row, envo, from, now);

    let live: readonly EnvoLiveCall[] | null;
    try {
      live = await this.gateway.liveCalls(envo);
    } catch {
      live = null;
    }
    const closed = await this.closeStale(orgId, row, now, live);
    // Never past what was read, nor closer to now than the longest call; no progress, no move.
    const reached = Math.min(read.reached.getTime(), now.getTime() - LONGEST_CALL_MS);
    const moved = read.reached.getTime() > from.getTime() ? new Date(reached) : null;
    await withOrg(actor, (tx) =>
      repo.recordSync(tx, orgId, connectionId, { cursor: moved, error: read.error }),
    );
    if (read.error !== null) {
      this.logger.warn(
        { orgId, connectionId, reason: read.error },
        'an Envo call history read stopped early',
      );
    }
    return { listed: read.listed, closed };
  }

  /**
   * The history since `from`, oldest window first, each to its last page. `reached`: every call
   * that started before it (and after `from`) was read.
   */
  private async readHistory(
    orgId: string,
    row: repo.ConnectionRow,
    envo: EnvoConnection,
    from: Date,
    now: Date,
  ): Promise<{ readonly listed: number; readonly reached: Date; readonly error: string | null }> {
    let requests = 0;
    let listed = 0;
    let start = from.getTime();
    let reached = from;
    const ask = async (windowStart: number, windowEnd: number, page: number) => {
      requests += 1;
      return this.gateway.callHistory(envo, {
        from: new Date(windowStart),
        to: new Date(windowEnd),
        page,
        limit: PAGE_SIZE,
      });
    };
    try {
      while (start < now.getTime() && requests < MAX_REQUESTS) {
        let end = now.getTime();
        let answer: EnvoCallHistoryPage = await ask(start, end, 1);
        // More calls than the requests left can read: a shorter window first.
        while (
          Math.ceil(answer.total / PAGE_SIZE) > MAX_REQUESTS - requests + 1 &&
          end - start > MIN_WINDOW_MS &&
          requests < MAX_REQUESTS
        ) {
          end = start + Math.floor((end - start) / 2);
          answer = await ask(start, end, 1);
        }
        let fetched = 0;
        let page = 1;
        let complete = false;
        for (;;) {
          listed += await this.apply(orgId, row, answer.calls, now);
          fetched += answer.calls.length;
          if (answer.calls.length < PAGE_SIZE || (answer.total > 0 && fetched >= answer.total)) {
            complete = true;
            break;
          }
          if (requests >= MAX_REQUESTS) break;
          page += 1;
          answer = await ask(start, end, page);
        }
        if (!complete) break;
        reached = new Date(end);
        start = end;
      }
      return { listed, reached, error: null };
    } catch (cause) {
      if (!(cause instanceof EnvoError)) throw cause;
      return { listed, reached, error: envoFailure(cause).message };
    }
  }

  private async apply(
    orgId: string,
    row: repo.ConnectionRow,
    calls: readonly unknown[],
    now: Date,
  ): Promise<number> {
    const facts = calls
      .map((call) => parseEnvoCall(call, 'sync'))
      .filter((call): call is EnvoCallFacts => call !== null && !call.test);
    if (facts.length === 0) return 0;
    await withOrg({ orgId, userId: TELEPHONY_SYSTEM_USER }, async (tx) => {
      for (const call of facts) {
        await this.ingest.apply(tx, orgId, row, call, 'sync', now);
      }
    });
    return facts.length;
  }

  /**
   * Clicks Envo took and never described, closed as not connected: those past
   * `CLICK_TO_CALL_STALE_MS` whose extension Envo shows on no call in progress; with Envo not
   * asked (`live` null), only those past the longest call.
   */
  private async closeStale(
    orgId: string,
    row: repo.ConnectionRow,
    now: Date,
    live: readonly EnvoLiveCall[] | null,
  ): Promise<number> {
    const busy = new Set<string>();
    for (const call of live ?? []) {
      if (call.from !== null) busy.add(call.from);
      if (call.to !== null) busy.add(call.to);
      for (const endpoint of call.endpoints) {
        const extension = /^([0-9]{2,8})_/.exec(endpoint)?.[1];
        if (extension !== undefined) busy.add(extension);
      }
    }
    const age = live === null ? LONGEST_CALL_MS : CLICK_TO_CALL_STALE_MS;
    return withOrg({ orgId, userId: TELEPHONY_SYSTEM_USER }, async (tx) => {
      const stale = await repo.staleClicks(tx, orgId, row.id, new Date(now.getTime() - age));
      let closed = 0;
      for (const click of stale) {
        if (click.extension !== null && busy.has(click.extension)) continue;
        const moved = await repo.updateCall(tx, orgId, click.id, {
          status: 'ended',
          errorCode: 'not_connected',
          endedAt: now,
        });
        await announce(tx, orgId, moved);
        closed += 1;
      }
      return closed;
    });
  }
}
