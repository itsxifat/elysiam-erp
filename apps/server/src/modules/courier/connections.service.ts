import { Inject, Injectable } from '@nestjs/common';
import {
  defineAbilityFor,
  type ConnectCourierInput,
  type ConnectCourierResult,
} from '@elysium/contracts';
import { withOrg, type Tx } from '@elysium/db';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import type { ActiveContext } from '../../platform/http/context.js';
import {
  COURIER_ADAPTERS,
  type CourierAdapter,
  type CourierAdapterRegistry,
} from './adapters/courier-adapter.js';
import { adapterEnabled, courierEnv } from './courier.config.js';
import { CourierError } from './courier.errors.js';
import * as repo from './courier.repository.js';
import { sealCredentials } from './credentials.js';
import { ORDERS_PORT, type OrdersPort } from './ports/orders.port.js';
import { courierOffered, PANEL_COURIERS, type PanelCourier } from './providers.js';

/**
 * A connected courier's parcels are asked about after an hour without news (D-916). The poll
 * runs every half hour; with no webhook set up it is how a status arrives at all, and six hours
 * (M12's default, still the account form's) left a parcel's status a day part behind. Steadfast
 * caches a status answer for 60 seconds and allows 1,000 requests a minute: an hour is cheap.
 */
const DEFAULT_POLL_AFTER_HOURS = 1;

/** Whether making it the default was asked for and done, and how many zones are active. */
interface DefaultOutcome {
  readonly isDefault: boolean;
  readonly activeZones: number;
}

/**
 * The default courier is every delivery zone's courier, and the zones are edited with
 * `update Catalog` (`PUT /v1/delivery-zones`). Connecting a courier needs only
 * `update CourierSettlement`, so changing the default here needs both: a role that settles
 * couriers' cash (accounts) must not reroute every new order by connecting one.
 */
function defaultRefused(): CourierError {
  return new CourierError(
    'FORBIDDEN',
    'Changing the default courier changes every delivery zone’s courier, and your role cannot edit delivery zones. Turn off “Use as the default courier”, or ask someone who manages delivery zones.',
  );
}

/**
 * Connecting a courier in one step (D-913): choose it, add its keys, default or not.
 *
 * The owner asked for exactly that, and `POST /v1/courier/accounts` asks for eleven things. So
 * this takes the courier's code, its keys and the default switch, and decides the rest the way
 * a brand almost always wants it: the courier's live API at the installation's address, a poll
 * every six hours, active. An existing account keeps its label, mode, API address, polling
 * hours, settlement wallet and webhook secret, because those are not the keys (Advanced sets
 * them) and re-connecting is only ever about the keys; the new keys are checked against the
 * account's own mode and address. An API courier sent with no keys at all, whose account
 * already has saved ones, is "Make default" alone: nothing is checked and the account is left
 * as it is.
 *
 * ## The keys are checked before anything is written
 *
 * With one call the courier's adapter already makes (`verifyCredentials`), outside any
 * transaction (invariant 6). Keys the courier refuses are a 400 with a plain sentence and
 * nothing saved, so a typo never becomes an active account whose first booking fails. A
 * courier that does not answer is a 503 and nothing saved either: an account switched on with
 * keys nobody has seen work is the thing this step exists to prevent.
 *
 * ## The default courier is §9's
 *
 * A brand's default courier is the one its delivery zones name: each zone has a default courier
 * and a new order is given its zone's (`OrdersService.create`), which is the courier a Confirm
 * books. So "make it the default" makes every zone's default this courier, through the orders
 * module that owns the zones, and "is it the default" asks whether every active zone names it.
 * There is no second notion of a default to fall out of step with it. Unticking the default on
 * the current default changes nothing: some courier has to be the default, and that is decided
 * by making another one the default. Changing it needs `update Catalog` as well, the zones'
 * own ability (`defaultRefused`), and the zones are locked while they change.
 */
@Injectable()
export class CourierConnectionsService {
  constructor(
    @Inject(COURIER_ADAPTERS) private readonly adapters: CourierAdapterRegistry,
    @Inject(ORDERS_PORT) private readonly orders: OrdersPort,
    private readonly audit: AuditService,
  ) {}

  async connect(
    context: ActiveContext,
    request: AuditableRequest,
    input: ConnectCourierInput,
  ): Promise<ConnectCourierResult> {
    const adapter = courierOffered(input.provider) ? this.adapters.get(input.provider) : undefined;
    if (adapter !== undefined) return this.connectApi(context, request, adapter, input);
    const panel = PANEL_COURIERS.find((courier) => courier.code === input.provider);
    if (panel !== undefined) return this.connectPanel(context, request, panel, input);
    throw new CourierError('COURIER_ACCOUNT_INVALID', 'Choose a courier from the list.');
  }

  private async connectApi(
    context: ActiveContext,
    request: AuditableRequest,
    adapter: CourierAdapter,
    input: ConnectCourierInput,
  ): Promise<ConnectCourierResult> {
    if (!adapterEnabled(adapter)) {
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `${adapter.name} is switched off on this server. Set COURIER_${adapter.code.toUpperCase()}_ENABLED=true to connect it.`,
      );
    }
    const mayChangeDefault = this.mayChangeDefault(context);
    if (Object.keys(input.credentials).length === 0 && requiredFields(adapter).length > 0) {
      // "Make default" on a connected courier: its saved keys stay, and nothing is asked.
      return this.defaultOnly(context, request, adapter, input, mayChangeDefault);
    }
    const credentials = this.checkFields(adapter, input.credentials);
    const hasKeys = Object.keys(credentials).length > 0;
    if (hasKeys && courierEnv().COURIER_CREDENTIALS_KEY === undefined) {
      // Before the courier is asked: keys that cannot be stored are not worth checking.
      throw new CourierError(
        'COURIER_CREDENTIALS_MISSING',
        'This server has no COURIER_CREDENTIALS_KEY, so courier keys cannot be stored.',
      );
    }

    // What the account has now, read before the courier is asked: its mode and API address
    // (Advanced's) are what the keys are checked against and then kept. A new account is live,
    // at the installation's address.
    const prior = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const existing = await this.accountFor(tx, context.orgId, adapter.code);
      const current =
        input.isDefault && !mayChangeDefault
          ? await this.orders.defaultCourierId(tx, context.orgId)
          : null;
      return { existing, current };
    });
    // Already the default (its account's courier is the zones'): nothing to change, nothing to
    // refuse. A courier with no account yet cannot be.
    if (input.isDefault && !mayChangeDefault && prior.current !== prior.existing?.courier_id) {
      // Refused before the courier is asked: the transaction below would refuse it anyway.
      throw defaultRefused();
    }
    const target = {
      mode: prior.existing?.mode ?? ('live' as const),
      baseUrl: prior.existing?.base_url ?? null,
    };

    // The courier's answer, before any transaction is open (invariant 6).
    await adapter.verifyCredentials({
      credentials,
      baseUrl: target.baseUrl,
      mode: target.mode,
      timeoutMs: courierEnv().COURIER_HTTP_TIMEOUT_MS,
    });

    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const party = await this.partyFor(tx, context.orgId, adapter);
      const existing = await repo.accountByCourier(tx, context.orgId, party.id);
      if (
        existing !== undefined &&
        (existing.mode !== target.mode || existing.base_url !== target.baseUrl)
      ) {
        // Advanced was saved while the keys were being checked: they were checked elsewhere.
        throw new CourierError(
          'COURIER_ACCOUNT_INVALID',
          `${adapter.name}’s settings changed while its keys were being checked. Try again.`,
        );
      }
      // Sealed against the courier id, as `CourierAccountsService.upsert` seals it. A courier
      // that takes no keys (the fake) stores none.
      const sealed = hasKeys
        ? sealCredentials(credentials, {
            orgId: context.orgId,
            accountId: party.id,
            field: 'credentials',
          })
        : undefined;

      const accountId = await repo.upsertAccount(tx, {
        orgId: context.orgId,
        courierId: party.id,
        providerCode: adapter.code,
        label: existing?.label ?? adapter.name,
        // Kept from Advanced, and what the keys were just checked against.
        mode: target.mode,
        baseUrl: target.baseUrl,
        // Null keeps what the account has (the upsert coalesces), which for the fake is none.
        credentials: sealed?.ciphertext ?? null,
        credentialsKeyId: sealed?.keyId ?? null,
        credentialsFingerprint: sealed?.fingerprint ?? null,
        // Null keeps a webhook secret the account already has (the upsert coalesces it).
        webhookSecret: null,
        supportsWebhook: adapter.supportsWebhook,
        pollAfterHours: existing?.poll_after_hours ?? DEFAULT_POLL_AFTER_HOURS,
        settlementWalletId: existing?.settlement_wallet_id ?? null,
        verified: adapter.verified,
        isActive: true,
      });

      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: existing === undefined ? 'create' : 'update',
        action: 'courier.account.connected',
        entityType: 'CourierSettlement',
        entityId: accountId,
        // The fingerprint, never the key (invariant 10), as the account form's audit row.
        before:
          existing === undefined
            ? null
            : {
                label: existing.label,
                mode: existing.mode,
                baseUrl: existing.base_url,
                isActive: existing.is_active,
                credentialsFingerprint: existing.credentials_fingerprint,
              },
        after: {
          providerCode: adapter.code,
          courierId: party.id,
          partyCreated: party.created,
          mode: target.mode,
          baseUrl: target.baseUrl,
          isActive: true,
          credentialsChanged: hasKeys,
          credentialsFingerprint: sealed?.fingerprint ?? existing?.credentials_fingerprint ?? null,
          verified: adapter.verified,
        },
        requestId: context.requestId,
        request,
      });

      const outcome = await this.applyDefault(
        tx,
        context,
        request,
        party.id,
        input.isDefault,
        mayChangeDefault,
      );
      return {
        courierId: party.id,
        accountId,
        connected: true,
        isDefault: outcome.isDefault,
        message: this.message(`${adapter.name} is connected.`, input.isDefault, outcome),
      };
    });
  }

  /**
   * An API courier sent with no keys (D-913: "Make default"): its account's saved keys stay
   * and the account is left as it is — no check with the courier, no re-save — and only the
   * default changes. An account with no saved keys, or switched off, needs its keys, exactly
   * as connecting it the first time does.
   */
  private async defaultOnly(
    context: ActiveContext,
    request: AuditableRequest,
    adapter: CourierAdapter,
    input: ConnectCourierInput,
    mayChangeDefault: boolean,
  ): Promise<ConnectCourierResult> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const existing = await this.accountFor(tx, context.orgId, adapter.code);
      if (existing?.is_active !== true || existing.credentials === null) {
        throw new CourierError(
          'COURIER_ACCOUNT_INVALID',
          `${adapter.name} needs ${requiredFields(adapter).join(', ')}.`,
        );
      }
      const outcome = await this.applyDefault(
        tx,
        context,
        request,
        existing.courier_id,
        input.isDefault,
        mayChangeDefault,
      );
      return {
        courierId: existing.courier_id,
        accountId: existing.id,
        connected: true,
        isDefault: outcome.isDefault,
        message: this.message(`${adapter.name} keeps its saved keys.`, input.isDefault, outcome),
      };
    });
  }

  private async connectPanel(
    context: ActiveContext,
    request: AuditableRequest,
    courier: PanelCourier,
    input: ConnectCourierInput,
  ): Promise<ConnectCourierResult> {
    const typed = Object.keys(input.credentials);
    if (typed.length > 0) {
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `${courier.name} takes no keys here: its parcels are booked in its own merchant panel.`,
      );
    }
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const party = await this.orders.ensureCourierParty(tx, context.orgId, courier);
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: party.created ? 'create' : 'update',
        action: 'courier.party.added',
        entityType: 'CourierSettlement',
        entityId: party.id,
        after: { code: courier.code, connect: 'panel', partyCreated: party.created },
        requestId: context.requestId,
        request,
      });
      const outcome = await this.applyDefault(
        tx,
        context,
        request,
        party.id,
        input.isDefault,
        this.mayChangeDefault(context),
      );
      return {
        courierId: party.id,
        accountId: null,
        connected: false,
        isDefault: outcome.isDefault,
        message: this.message(
          `${courier.name} has no API connection yet: book its parcels in ${courier.name}’s merchant panel.`,
          input.isDefault,
          outcome,
        ),
      };
    });
  }

  /**
   * The keys typed, against the courier's own list (the adapter's `credentialFields`, plus any
   * optional ones it takes): every one it needs, and none it does not.
   */
  private checkFields(
    adapter: CourierAdapter,
    typed: Readonly<Record<string, string>>,
  ): Record<string, string> {
    const required = requiredFields(adapter);
    const allowed = new Set([...required, ...(adapter.optionalCredentialFields ?? [])]);
    const unknown = Object.keys(typed).filter((field) => !allowed.has(field));
    if (unknown.length > 0) {
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `${adapter.name} does not take ${unknown.join(', ')}.`,
      );
    }
    const missing = required.filter((field) => typed[field] === undefined);
    if (missing.length > 0) {
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `${adapter.name} needs ${missing.join(', ')}.`,
      );
    }
    const optional = adapter.optionalCredentialFields ?? [];
    const givenOptional = optional.filter((field) => typed[field] !== undefined);
    if (givenOptional.length > 0 && givenOptional.length < optional.length) {
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `${adapter.name} needs ${optional.join(' and ')} together, or neither.`,
      );
    }
    return { ...typed };
  }

  /**
   * The courier party the account belongs to.
   *
   * The party an account for this courier already sits on, when there is one — an org that set
   * Steadfast up through the account form may have put it on a party of another code, and a
   * second account beside it would split one courier's COD across two parties — else the party
   * with the courier's own code, made when the brand has none.
   */
  private async partyFor(
    tx: Tx,
    orgId: string,
    adapter: CourierAdapter,
  ): Promise<{ readonly id: string; readonly created: boolean }> {
    const first = await this.accountFor(tx, orgId, adapter.code);
    if (first !== undefined) return { id: first.courier_id, created: false };
    const party = await this.orders.ensureCourierParty(tx, orgId, {
      code: adapter.code,
      name: adapter.name,
    });
    return { id: party.id, created: party.created };
  }

  /** The brand's account for this courier, an active one first; undefined when it has none. */
  private async accountFor(
    tx: Tx,
    orgId: string,
    providerCode: string,
  ): Promise<repo.CourierAccountRow | undefined> {
    const accounts = await repo.listAccounts(tx, orgId, { includeInactive: true });
    return accounts
      .filter((account) => account.provider_code === providerCode)
      .sort((left, right) => Number(right.is_active) - Number(left.is_active))[0];
  }

  /** Whether this person may change the brand's default courier: the zones' own ability. */
  private mayChangeDefault(context: ActiveContext): boolean {
    return defineAbilityFor(context).can('update', 'Catalog');
  }

  /**
   * Make this courier the brand's default when asked, and say whether it is now.
   *
   * Through the orders module, which owns the zones (invariant 12), and audited here with every
   * zone's default before, so the change can be read back and undone zone by zone. The zones
   * are locked by `setDefaultCourier` before they are read, so two people making two couriers
   * the default at once are served one after the other and the zones never end up split. A
   * role without the zones' `update Catalog` is refused before anything is written, unless the
   * courier already is the default; a refusal here rolls the whole connection back.
   */
  private async applyDefault(
    tx: Tx,
    context: ActiveContext,
    request: AuditableRequest,
    courierId: string,
    wanted: boolean,
    mayChangeDefault: boolean,
  ): Promise<DefaultOutcome> {
    const state = await this.orders.defaultCourierState(tx, context.orgId);
    if (!wanted || (!mayChangeDefault && state.courierId === courierId)) {
      return { isDefault: state.courierId === courierId, activeZones: state.activeZones };
    }
    if (!mayChangeDefault) throw defaultRefused();

    const { before } = await this.orders.setDefaultCourier(tx, context.orgId, courierId);
    if (before.some((zone) => zone.courierId !== courierId)) {
      const named = new Set(before.filter((zone) => zone.isActive).map((zone) => zone.courierId));
      await this.audit.record(tx, {
        orgId: context.orgId,
        actorUserId: context.userId,
        operation: 'update',
        action: 'courier.default.changed',
        entityType: 'CourierSettlement',
        entityId: courierId,
        before: {
          defaultCourierId: named.size === 1 ? ([...named][0] ?? null) : null,
          zones: before,
        },
        after: { defaultCourierId: courierId },
        requestId: context.requestId,
        request,
      });
    }
    const after = await this.orders.defaultCourierState(tx, context.orgId);
    return { isDefault: after.courierId === courierId, activeZones: after.activeZones };
  }

  private message(done: string, wanted: boolean, outcome: DefaultOutcome): string {
    if (outcome.isDefault) return `${done} It is the default courier for new orders.`;
    if (wanted && outcome.activeZones === 0) {
      return `${done} It could not be made the default: this brand has no active delivery zone. Add one in Settings → Delivery zones.`;
    }
    if (wanted) return `${done} It could not be made the default courier. Try again.`;
    return done;
  }
}

/** The keys a courier needs typed: its adapter's list, less the webhook secret (Advanced's). */
function requiredFields(adapter: CourierAdapter): readonly string[] {
  return adapter.credentialFields.filter((field) => field !== 'webhookToken');
}
