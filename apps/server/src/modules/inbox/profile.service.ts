import { Inject, Injectable } from '@nestjs/common';
import { withGlobal, withOrg, type Tx } from '@elysium/db';
import {
  nextContactName,
  PROFILE_REFRESH_MS,
  profileDisplayName,
  profileHandle,
  profilePictureUrl,
  profileRefreshDue,
} from '@elysium/domain/inbox';
import { sql } from 'drizzle-orm';

import { emit } from '../../platform/events/outbox.js';
import { enqueue } from '../../platform/jobs/enqueue.js';
import { createLogger } from '../../platform/logging/logger.js';
import { channelTokenBinding, openSecret } from './inbox-secrets.js';
import { INBOX_QUEUES } from './inbox.queues.js';
import * as profiles from './profiles.repository.js';
import {
  MESSAGING_GATEWAY,
  type FetchProfileRequest,
  type MessagingGateway,
} from './providers/meta-messaging.js';

/** Who the database sees acting when a profile is refreshed. Not a person. */
export const INBOX_PROFILE_ACTOR = 'system:inbox';

/** How many identities one sweep asks about per brand (Meta's rate limits are per Page). */
const SWEEP_PER_BRAND = 50;

export type ProfileOutcome = 'updated' | 'unchanged' | 'none' | 'skipped';

/**
 * Senders' names and photos (M44a, D-761; invariant 6).
 *
 * Messenger's webhooks carry only a PSID and Instagram's only an IGSID, so the inbox showed
 * "Unknown". After a person's first message (and every few days while they keep writing, since
 * Meta's photo URLs expire) `inbox.fetch_profile` asks Meta's User Profile API, outside any
 * transaction, and keeps the name and photo on the contact. WhatsApp sends the name in the
 * webhook (`contacts[].profile.name`), which the webhook job keeps the same way, with no call.
 *
 * A name a person typed in is never overwritten: only a name nobody set, or the one Meta gave
 * last time, follows Meta (`nextContactName`).
 */
@Injectable()
export class InboxProfileService {
  private cachedLogger: ReturnType<typeof createLogger> | undefined;

  private get logger(): ReturnType<typeof createLogger> {
    this.cachedLogger ??= createLogger('inbox');
    return this.cachedLogger;
  }

  constructor(@Inject(MESSAGING_GATEWAY) private readonly gateway: MessagingGateway) {}

  /**
   * Called in the webhook job's transaction for a Messenger or Instagram message: queue a fetch
   * when this person was never asked about, or not for a while. Collapsed per identity.
   */
  async queueIfDue(
    tx: Tx,
    orgId: string,
    identityId: string,
    contactId: string,
    now: Date,
  ): Promise<void> {
    const fetchedAt = await profiles.profileFetchedAt(tx, orgId, contactId);
    if (!profileRefreshDue(fetchedAt, now)) return;
    await enqueue(
      tx,
      INBOX_QUEUES.fetchProfile.name,
      { identityId },
      { orgId, ref: identityId, singletonKey: `profile:${identityId}` },
    );
  }

  /** The job: ask Meta about one identity and keep the answer. */
  async refresh(
    orgId: string,
    identityId: string,
    now: () => Date = () => new Date(),
  ): Promise<ProfileOutcome> {
    const prepared = await withOrg({ orgId, userId: INBOX_PROFILE_ACTOR }, (tx) =>
      this.prepare(tx, orgId, identityId, now()),
    );
    if (prepared === null) return 'skipped';

    // Outside any transaction: no connection is held while Meta answers.
    const fetched = await this.gateway.fetchProfile(prepared.request);

    return withOrg({ orgId, userId: INBOX_PROFILE_ACTOR }, async (tx) => {
      const target = await profiles.profileTarget(tx, orgId, identityId);
      if (target === undefined) return 'skipped';
      const at = now();
      if (fetched === null) {
        await profiles.markProfileFetched(tx, orgId, target.contact_id, at);
        return 'none';
      }
      const fromMeta = profileDisplayName(fetched);
      const avatarUrl = profilePictureUrl(fetched.pictureUrl);
      const handle =
        prepared.request.channel === 'instagram' ? profileHandle(fetched.username) : undefined;
      const displayName = nextContactName(target.display_name, target.profile_name, fromMeta);
      const changed =
        displayName !== target.display_name ||
        avatarUrl !== target.avatar_url ||
        (handle !== undefined && handle !== target.handle);
      await profiles.saveProfile(tx, orgId, {
        identityId,
        contactId: target.contact_id,
        profileName: fromMeta ?? target.profile_name,
        displayName,
        avatarUrl,
        handle,
        fetchedAt: at,
      });
      if (!changed) return 'unchanged';
      await this.announce(tx, orgId, target.contact_id);
      return 'updated';
    });
  }

  /**
   * WhatsApp's name, as the webhook carried it (no call to make). Only for an identity seen
   * before: a new one was created with the name already.
   */
  async applyWhatsAppName(tx: Tx, orgId: string, identityId: string, name: string): Promise<void> {
    const target = await profiles.profileTarget(tx, orgId, identityId);
    if (target === undefined) return;
    const fromMeta = profileDisplayName({ name });
    if (fromMeta === null || fromMeta === target.profile_name) return;
    const displayName = nextContactName(target.display_name, target.profile_name, fromMeta);
    await profiles.saveProfile(tx, orgId, {
      identityId,
      contactId: target.contact_id,
      profileName: fromMeta,
      displayName,
      avatarUrl: undefined,
      handle: undefined,
      fetchedAt: null,
    });
    if (displayName !== target.display_name) await this.announce(tx, orgId, target.contact_id);
  }

  /** Every few hours, in every brand: queue the people still writing whose profile went stale. */
  async sweep(now: () => Date = () => new Date()): Promise<{ readonly queued: number }> {
    const orgIds = await withGlobal(async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        select id from org.organizations where is_active order by slug
      `);
      return [...rows].map((row) => row.id);
    });
    let queued = 0;
    const staleBefore = new Date(now().getTime() - PROFILE_REFRESH_MS);
    for (const orgId of orgIds) {
      try {
        queued += await withOrg({ orgId, userId: INBOX_PROFILE_ACTOR }, async (tx) => {
          const due = await profiles.identitiesDue(tx, orgId, staleBefore, SWEEP_PER_BRAND);
          for (const identityId of due) {
            await enqueue(
              tx,
              INBOX_QUEUES.fetchProfile.name,
              { identityId },
              { orgId, ref: identityId, singletonKey: `profile:${identityId}` },
            );
          }
          return due.length;
        });
      } catch (error) {
        // One brand's failure does not stop the others; the next sweep tries again.
        this.logger.warn(
          { orgId, error: error instanceof Error ? error.message : String(error) },
          'inbox profile sweep failed for a brand',
        );
      }
    }
    return { queued };
  }

  private async prepare(
    tx: Tx,
    orgId: string,
    identityId: string,
    now: Date,
  ): Promise<{ readonly request: FetchProfileRequest } | null> {
    const target = await profiles.profileTarget(tx, orgId, identityId);
    if (target?.channel_enabled !== true) return null;
    if (target.channel_kind !== 'messenger' && target.channel_kind !== 'instagram') return null;
    const fetchedAt =
      target.profile_fetched_at === null ? null : new Date(target.profile_fetched_at);
    // Two jobs queued close together: the second finds the first's answer and stops.
    if (!profileRefreshDue(fetchedAt, now)) return null;

    // Instagram, through the Messenger API, reads with the Page's token unless it has its own
    // (as the send job does, D-731).
    const own = await profiles.channelToken(tx, orgId, target.channel_kind);
    const page =
      target.channel_kind === 'instagram' && own?.sealed == null
        ? await profiles.channelToken(tx, orgId, 'messenger')
        : own;
    const tokenKind =
      target.channel_kind === 'instagram' && own?.sealed == null
        ? 'messenger'
        : target.channel_kind;
    const token =
      page?.enabled === true
        ? openSecret(page.sealed, channelTokenBinding(orgId, tokenKind))
        : null;
    if (token === null) {
      // Nothing to ask with: remembered, so the next message does not queue it again at once.
      await profiles.markProfileFetched(tx, orgId, target.contact_id, now);
      return null;
    }
    return {
      request: { channel: target.channel_kind, userId: target.external_user_id, token },
    };
  }

  private async announce(tx: Tx, orgId: string, contactId: string): Promise<void> {
    await emit(
      tx,
      'inbox.contact_updated',
      {
        contactId,
        conversationIds: await profiles.conversationIdsOfContact(tx, orgId, contactId),
      },
      { orgId },
    );
  }
}
