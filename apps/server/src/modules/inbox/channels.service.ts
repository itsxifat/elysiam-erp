import { Inject, Injectable } from '@nestjs/common';
import type { InboxChannelUpdateInput, InboxMetaAppInput } from '@elysium/contracts';
import { withOrg } from '@elysium/db';
import { INBOX_CHANNEL_KINDS, type InboxChannelKind } from '@elysium/domain/inbox';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { sealedBoxConfigured } from '../../platform/crypto/sealed-box.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { INBOX_CONFIG, type InboxConfig } from './inbox.config.js';
import {
  appSecretBinding,
  channelTokenBinding,
  sealSecret,
  verifyTokenBinding,
} from './inbox-secrets.js';
import { InboxError, mapInboxErrors } from './inbox.errors.js';
import * as repo from './inbox.repository.js';
import { MESSAGING_GATEWAY, type MessagingGateway } from './providers/meta-messaging.js';
import { META_WEBHOOK_PREFIX } from './raw-body.js';

/**
 * Settings → Inbox (M42, D-733): the brand's Meta app secret and verify token, and each
 * channel's id and token. Secrets are write-only: sealed on the way in, shown afterwards only as
 * "set" with a fingerprint, and never returned, logged or audited in the clear (the audit row
 * carries the fingerprint).
 */
@Injectable()
export class InboxChannelsService {
  constructor(
    private readonly audit: AuditService,
    @Inject(MESSAGING_GATEWAY) private readonly gateway: MessagingGateway,
    @Inject(INBOX_CONFIG) private readonly config: InboxConfig,
  ) {}

  async list(context: ActiveContext) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        const [settings, channels] = await Promise.all([
          repo.settingsOf(tx, context.orgId),
          repo.channelsOf(tx, context.orgId),
        ]);
        const byKind = new Map(channels.map((channel) => [channel.kind, channel]));
        return {
          /** Where the brand points Meta's webhooks: this API's address plus this path. */
          webhookPath: `${META_WEBHOOK_PREFIX}${context.orgId}`,
          provider: this.gateway.provider,
          apiVersion: this.config.INBOX_META_API_VERSION,
          credentialsKey: sealedBoxConfigured(),
          app: {
            appSecretSet: settings?.app_secret_fingerprint != null,
            appSecretFingerprint: settings?.app_secret_fingerprint ?? null,
            verifyTokenSet: settings?.verify_token_fingerprint != null,
            verifyTokenFingerprint: settings?.verify_token_fingerprint ?? null,
          },
          channels: INBOX_CHANNEL_KINDS.map((kind) => {
            const channel = byKind.get(kind);
            return {
              kind,
              configured: channel !== undefined,
              externalId: channel?.external_id ?? null,
              enabled: channel?.enabled ?? false,
              tokenSet: channel?.access_token_fingerprint != null,
              tokenFingerprint: channel?.access_token_fingerprint ?? null,
              updatedAt: channel === undefined ? null : new Date(channel.updated_at).toISOString(),
            };
          }),
        };
      }),
    );
  }

  async saveChannel(
    context: ActiveContext,
    request: AuditableRequest,
    kind: InboxChannelKind,
    input: InboxChannelUpdateInput,
  ) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        if (input.accessToken !== undefined && !sealedBoxConfigured()) {
          throw new InboxError(
            'INBOX_CREDENTIALS_MISSING',
            'This installation has no credentials key, so a token cannot be kept.',
          );
        }
        const before = await repo.channelByKind(tx, context.orgId, kind);
        const token =
          input.accessToken === undefined
            ? undefined
            : sealSecret(input.accessToken, channelTokenBinding(context.orgId, kind));
        const id = await repo.saveChannel(
          tx,
          context.orgId,
          kind,
          {
            externalId: input.externalId,
            enabled: input.enabled,
            ...(token === undefined ? {} : { token }),
          },
          context.userId,
        );
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: before === undefined ? 'create' : 'update',
          action: 'inbox.channel.saved',
          entityType: 'inbox_channel',
          entityId: id,
          before:
            before === undefined
              ? null
              : {
                  kind,
                  externalId: before.external_id,
                  enabled: before.enabled,
                  tokenFingerprint: before.access_token_fingerprint,
                },
          after: {
            kind,
            externalId: input.externalId,
            enabled: input.enabled,
            tokenFingerprint: token?.fingerprint ?? before?.access_token_fingerprint ?? null,
          },
          requestId: context.requestId,
          request,
        });
        return {
          kind,
          externalId: input.externalId,
          enabled: input.enabled,
          tokenSet: token !== undefined || before?.access_token_fingerprint != null,
          tokenFingerprint: token?.fingerprint ?? before?.access_token_fingerprint ?? null,
        };
      }),
    );
  }

  async saveApp(context: ActiveContext, request: AuditableRequest, input: InboxMetaAppInput) {
    return mapInboxErrors(() =>
      withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
        if (!sealedBoxConfigured()) {
          throw new InboxError(
            'INBOX_CREDENTIALS_MISSING',
            'This installation has no credentials key, so Meta secrets cannot be kept.',
          );
        }
        const before = await repo.settingsOf(tx, context.orgId);
        const appSecret =
          input.appSecret === undefined
            ? undefined
            : sealSecret(input.appSecret, appSecretBinding(context.orgId));
        const verifyToken =
          input.verifyToken === undefined
            ? undefined
            : sealSecret(input.verifyToken, verifyTokenBinding(context.orgId));
        await repo.saveSettings(
          tx,
          context.orgId,
          {
            ...(appSecret === undefined ? {} : { appSecret }),
            ...(verifyToken === undefined ? {} : { verifyToken }),
          },
          context.userId,
        );
        const after = await repo.settingsOf(tx, context.orgId);
        await this.audit.record(tx, {
          orgId: context.orgId,
          actorUserId: context.userId,
          operation: before === undefined ? 'create' : 'update',
          action: 'inbox.meta_app.saved',
          entityType: 'inbox_settings',
          entityId: after?.id ?? context.orgId,
          before:
            before === undefined
              ? null
              : {
                  appSecretFingerprint: before.app_secret_fingerprint,
                  verifyTokenFingerprint: before.verify_token_fingerprint,
                },
          after: {
            appSecretFingerprint: after?.app_secret_fingerprint ?? null,
            verifyTokenFingerprint: after?.verify_token_fingerprint ?? null,
          },
          requestId: context.requestId,
          request,
        });
        return {
          appSecretSet: after?.app_secret_fingerprint != null,
          appSecretFingerprint: after?.app_secret_fingerprint ?? null,
          verifyTokenSet: after?.verify_token_fingerprint != null,
          verifyTokenFingerprint: after?.verify_token_fingerprint ?? null,
        };
      }),
    );
  }
}
