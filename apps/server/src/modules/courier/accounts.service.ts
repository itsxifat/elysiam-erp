import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { COURIER_ADAPTERS, type CourierAdapterRegistry } from './adapters/courier-adapter.js';
import { adapterEnabled } from './courier.config.js';
import { CourierError } from './courier.errors.js';
import * as repo from './courier.repository.js';
import { sealCredentials } from './credentials.js';
import type { UpsertCourierAccountInput } from './courier.schemas.js';

/**
 * Courier accounts and their credentials (M12's first bullet; §21, §25).
 *
 * Two things happen here that do not happen anywhere else in the system, and both are
 * about secrets:
 *
 * 1. **A credential is encrypted on the way in and never read back out on this path.**
 *    The account view returns a *fingerprint* — twelve hex characters of a digest — so an
 *    operator can confirm the key in the vault is the key in the database without either
 *    of them ever being displayed. There is no route that returns a credential, and there
 *    should never be one: the only consumer is the adapter, in the worker, at the moment
 *    of a call.
 * 2. **An unverified adapter cannot be activated by accident.** §21 and D-006 require an
 *    adapter built from the courier's official documentation; the Steadfast adapter was
 *    not (see its file, and D-176). So activating an account on an adapter whose
 *    `verified` is false is refused unless the installation has set
 *    `COURIER_STEADFAST_ENABLED=true` — which makes enabling it a decision somebody made
 *    rather than a default they inherited.
 */
@Injectable()
export class CourierAccountsService {
  constructor(
    @Inject(COURIER_ADAPTERS) private readonly adapters: CourierAdapterRegistry,
    private readonly audit: AuditService,
  ) {}

  /** Every account the caller may see, with no secret in it. */
  async list(context: ActiveContext, options: { includeInactive?: boolean } = {}) {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const rows = await repo.listAccounts(tx, context.orgId, {
        includeInactive: options.includeInactive ?? false,
      });
      return { items: rows.map((row) => this.view(row, context.orgId)) };
    });
  }

  /**
   * Register or update the org's account for a courier.
   *
   * An upsert, because setting up a courier is a form somebody re-submits: keys arrive
   * after the brand is created, a webhook secret is rotated, a sandbox becomes live. The
   * credential columns are only overwritten when new values were supplied, so re-saving
   * to change a label does not silently wipe the keys and leave the next booking failing
   * with "no credentials".
   */
  async upsert(
    context: ActiveContext,
    request: AuditableRequest,
    input: UpsertCourierAccountInput,
  ) {
    const adapter = this.adapters.get(input.providerCode);
    if (adapter === undefined) {
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `No courier adapter is built for "${input.providerCode}". Known: ${this.adapters.codes().join(', ')}.`,
      );
    }

    if (input.isActive && !adapterEnabled(adapter)) {
      /*
       * The honesty gate.
       *
       * A wrong guess about a courier's API does not fail loudly: it books parcels that
       * are never picked up, or worse, reports a status we map to `delivered` and posts
       * revenue for cash nobody collected. So an unverified adapter is off until an
       * operator turns it on, and the message says which variable does it.
       */
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `The ${adapter.code} adapter is marked UNVERIFIED (D-176): it was not built from the courier's own API documentation. Set COURIER_${adapter.code.toUpperCase()}_ENABLED=true to use it anyway.`,
      );
    }

    // Which credential fields this courier needs is the adapter's business, not this
    // schema's — a fixed shape here would make adding a courier a change to a shared file.
    if (input.credentials !== undefined) {
      const missing = adapter.credentialFields.filter(
        (field) => field !== 'webhookToken' && input.credentials?.[field] === undefined,
      );
      if (missing.length > 0) {
        throw new CourierError(
          'COURIER_ACCOUNT_INVALID',
          `A ${adapter.code} account needs ${missing.join(', ')}.`,
        );
      }
    }

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const existing = await repo.accountByCourier(tx, context.orgId, input.courierId);

      if (input.isActive && input.credentials === undefined && existing?.credentials == null) {
        // The database's `courier_accounts_active_has_credentials` CHECK says the same, and
        // saying it here first means the operator gets a sentence rather than a constraint
        // name. `fake` is exempt in both places.
        if (adapter.credentialFields.length > 0) {
          throw new CourierError(
            'COURIER_CREDENTIALS_MISSING',
            'An active courier account needs credentials.',
          );
        }
      }

      /*
       * Sealed against the row it will live on.
       *
       * On an insert the id does not exist yet, so the binding uses the *courier* id,
       * which is stable and unique per org. That is the whole point of the associated
       * data: a ciphertext copied into another org's row must not decrypt, and the courier
       * id is enough to guarantee that without a second round trip to learn the account id.
       */
      const bound = { orgId: context.orgId, accountId: input.courierId };
      const sealed =
        input.credentials === undefined
          ? undefined
          : sealCredentials(input.credentials, { ...bound, field: 'credentials' });
      const sealedWebhook =
        input.webhookSecret === undefined
          ? undefined
          : sealCredentials(
              { webhookSecret: input.webhookSecret },
              { ...bound, field: 'webhook_secret' },
            );

      const id = await repo.upsertAccount(tx, {
        orgId: context.orgId,
        courierId: input.courierId,
        providerCode: input.providerCode,
        label: input.label,
        mode: input.mode,
        baseUrl: input.baseUrl ?? null,
        credentials: sealed?.ciphertext ?? null,
        credentialsKeyId: sealed?.keyId ?? null,
        credentialsFingerprint: sealed?.fingerprint ?? null,
        webhookSecret: sealedWebhook?.ciphertext ?? null,
        supportsWebhook: adapter.supportsWebhook,
        pollAfterHours: input.pollAfterHours,
        settlementWalletId: input.settlementWalletId ?? null,
        verified: adapter.verified,
        isActive: input.isActive,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: existing === undefined ? 'create' : 'update',
        action: existing === undefined ? 'courier.account.created' : 'courier.account.updated',
        entityType: 'CourierSettlement',
        entityId: id,
        before:
          existing === undefined
            ? null
            : {
                label: existing.label,
                mode: existing.mode,
                isActive: existing.is_active,
                // The fingerprint, never the credential. An audit log is read by everyone
                // with `read AuditLog`, and a before/after diff of a secret would put it
                // in a table that is deliberately never purged (invariant 10).
                credentialsFingerprint: existing.credentials_fingerprint,
              },
        after: {
          providerCode: input.providerCode,
          label: input.label,
          mode: input.mode,
          isActive: input.isActive,
          credentialsChanged: input.credentials !== undefined,
          webhookSecretChanged: input.webhookSecret !== undefined,
          credentialsFingerprint: sealed?.fingerprint ?? existing?.credentials_fingerprint ?? null,
          verified: adapter.verified,
        },
        requestId: context.requestId,
        request,
      });

      const saved = await repo.accountById(tx, context.orgId, id);
      if (saved === undefined) {
        throw new CourierError('COURIER_ACCOUNT_NOT_FOUND', 'That courier account vanished.');
      }
      return this.view(saved, context.orgId);
    });
  }

  /**
   * The account, safe to send.
   *
   * There is no `credentials` field in the returned shape, and the absence is the design:
   * a view that carried the ciphertext would be a view an operator could screenshot and a
   * log could capture, and the ciphertext plus a leaked key is the plaintext. What is
   * returned instead answers the only question anybody asks — "is a key configured, and is
   * it the one I put in the vault".
   */
  private view(row: repo.CourierAccountRow, orgId: string) {
    return {
      id: row.id,
      courierId: row.courier_id,
      courierCode: row.courier_code,
      providerCode: row.provider_code,
      label: row.label,
      mode: row.mode,
      baseUrl: row.base_url,
      hasCredentials: row.credentials !== null,
      credentialsKeyId: row.credentials_key_id,
      credentialsFingerprint: row.credentials_fingerprint,
      hasWebhookSecret: row.webhook_secret !== null,
      supportsWebhook: row.supports_webhook,
      pollAfterHours: row.poll_after_hours,
      settlementWalletId: row.settlement_wallet_id,
      /** False means the adapter was not built from the courier's own docs (D-006, D-176). */
      verified: row.verified,
      isActive: row.is_active,
      /**
       * Where a webhook for this account is delivered. Not a secret; the token is.
       *
       * With the org id in it, which is the route's actual shape
       * (`/v1/courier/webhooks/:orgId/:provider`). M12 printed the path without it, so an
       * operator copying this into a courier's panel registered a URL that could only 404.
       */
      webhookPath: row.supports_webhook
        ? `/v1/courier/webhooks/${orgId}/${row.provider_code}`
        : null,
    };
  }
}
