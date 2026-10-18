import { Injectable, UnauthorizedException } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { parseEnvoCall } from '@elysium/domain/telephony';

import { enqueue } from '../../platform/jobs/enqueue.js';
import { createLogger } from '../../platform/logging/logger.js';
import { TELEPHONY_SYSTEM_USER, TelephonyIngestService } from './ingest.service.js';
import { envoSignatureVerdict } from './signature.js';
import { connectionBinding, openSecret } from './telephony-secrets.js';
import { TELEPHONY_QUEUES } from './telephony.queues.js';
import * as repo from './telephony.repository.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DELIVERY = /^[0-9a-zA-Z-]{1,64}$/;

function refused(): UnauthorizedException {
  // One answer for every refusal, as M42's webhook gives: a stranger learns nothing about which
  // brand, which connection or which secret they got wrong.
  return new UnauthorizedException({
    code: 'WEBHOOK_SIGNATURE_INVALID',
    message: 'That webhook was not accepted.',
  });
}

export interface WebhookAnswer {
  readonly accepted: true;
  readonly duplicate: boolean;
  /** Envo's "Send test", or an event that names no call the ERP keeps. */
  readonly ignored?: 'test' | 'not_a_call' | 'switched_off' | 'other_sip_server';
}

/**
 * Envo's webhooks into the ERP (M47, D-832): `POST /webhooks/envo/<org id>/<connection id>`.
 *
 * Verified with the connection's sealed webhook secret before anything is stored (the signature
 * over the raw bytes, within five minutes); a refusal is recorded on the connection (at most once
 * a minute) so Settings → Calls can show it. A signed body is stored once per call and event (an
 * Envo retry, or a second webhook pointed here, is a duplicate) and applied by
 * `telephony.process_webhook` after the commit: Envo waits ten seconds for a 2xx and retries
 * twice, so nothing slow happens here.
 */
@Injectable()
export class TelephonyWebhookService {
  private cachedLogger: ReturnType<typeof createLogger> | undefined;

  private get logger(): ReturnType<typeof createLogger> {
    this.cachedLogger ??= createLogger('telephony');
    return this.cachedLogger;
  }

  constructor(private readonly ingest: TelephonyIngestService) {}

  async accept(
    orgIdParam: string,
    connectionIdParam: string,
    rawBody: Buffer,
    signature: string | undefined,
    deliveryHeader: string | undefined,
    body: unknown,
    nowSeconds: number = Math.floor(Date.now() / 1000),
  ): Promise<WebhookAnswer> {
    if (!UUID.test(orgIdParam) || !UUID.test(connectionIdParam) || rawBody.length === 0) {
      throw refused();
    }
    const orgId = orgIdParam;
    const connectionId = connectionIdParam;
    const connection = await withOrg({ orgId }, (tx) =>
      repo.connectionById(tx, orgId, connectionId),
    );
    if (connection === undefined) throw refused();
    const secret = openSecret(
      connection.webhook_secret_sealed,
      connectionBinding(orgId, connectionId, 'webhook_secret'),
    );
    const verdict =
      secret === null ? 'no_secret' : envoSignatureVerdict(rawBody, signature, secret, nowSeconds);
    if (verdict !== 'ok') {
      await withOrg({ orgId, userId: TELEPHONY_SYSTEM_USER }, (tx) =>
        repo.recordSignatureFailure(tx, orgId, connectionId, verdict),
      );
      this.logger.warn({ orgId, connectionId, reason: verdict }, 'an Envo webhook was refused');
      throw refused();
    }

    const facts = parseEnvoCall(body);
    const deliveryId =
      typeof deliveryHeader === 'string' && DELIVERY.test(deliveryHeader) ? deliveryHeader : null;
    return withOrg({ orgId, userId: TELEPHONY_SYSTEM_USER }, async (tx) => {
      const seen = (label: string) => repo.recordWebhookSeen(tx, orgId, connectionId, label);
      if (facts === null) {
        await seen('not a call');
        return { accepted: true as const, duplicate: false, ignored: 'not_a_call' as const };
      }
      if (facts.test) {
        await seen(`${facts.event} (test)`);
        return { accepted: true as const, duplicate: false, ignored: 'test' as const };
      }
      if (!connection.enabled) {
        await seen(`${facts.event} (switched off)`);
        return { accepted: true as const, duplicate: false, ignored: 'switched_off' as const };
      }
      // Signed with this connection's secret but about another SIP server than its Test found:
      // a webhook of another Envo account pointed here by mistake.
      if (
        connection.envo_server_id !== null &&
        facts.sipServerId !== null &&
        facts.sipServerId !== connection.envo_server_id
      ) {
        await seen(`${facts.event} (other SIP server)`);
        return { accepted: true as const, duplicate: false, ignored: 'other_sip_server' as const };
      }
      await seen(facts.event);
      const stored = await repo.storeWebhookEvent(tx, {
        orgId,
        connectionId,
        event: facts.event,
        envoCallId: facts.callId,
        deliveryId,
        body,
      });
      if (stored.id !== null) {
        await enqueue(
          tx,
          TELEPHONY_QUEUES.processWebhook.name,
          { eventId: stored.id },
          { orgId, ref: stored.id, singletonKey: `envo-webhook:${stored.id}` },
        );
      }
      return { accepted: true as const, duplicate: stored.duplicate };
    });
  }

  /** The job: apply one stored body to its call, once. */
  async process(orgId: string, eventId: string): Promise<string | null> {
    return withOrg({ orgId, userId: TELEPHONY_SYSTEM_USER }, async (tx) => {
      const row = await repo.webhookForProcessing(tx, orgId, eventId);
      if (row?.processed_at !== null) return null;
      const connection = await repo.connectionById(tx, orgId, row.connection_id);
      const facts = parseEnvoCall(row.body);
      if (connection === undefined || facts === null || facts.event === 'sync') {
        await repo.markWebhookProcessed(tx, orgId, eventId, 'unreadable');
        return 'unreadable';
      }
      const applied = await this.ingest.apply(tx, orgId, connection, facts, 'webhook');
      await repo.markWebhookProcessed(tx, orgId, eventId, applied.outcome);
      return applied.outcome;
    });
  }
}
