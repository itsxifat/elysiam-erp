import { Inject, Injectable } from '@nestjs/common';
import { withOrg } from '@elysium/db';
import { isNormalizableBdPhone, normalizeBdPhone } from '@elysium/domain';
import {
  deliveryRisk,
  deliverySuccessPercent,
  recordParcels,
  type DeliveryRecord,
  type DeliveryRisk,
} from '@elysium/domain/courier';

import type { ActiveContext } from '../../platform/http/context.js';
import {
  COURIER_ADAPTERS,
  type AdapterContext,
  type CourierAdapter,
  type CourierAdapterRegistry,
} from './adapters/courier-adapter.js';
import { adapterEnabled, courierEnv } from './courier.config.js';
import { CourierError } from './courier.errors.js';
import * as repo from './courier.repository.js';
import { openCredentials } from './credentials.js';
import { courierName } from './providers.js';

/** How long a phone's record is reused before the courier is asked again. */
const RECORD_TTL_MS = 30 * 60 * 1000;
/** Phones remembered per process; the oldest is forgotten first. */
const RECORD_CACHE_SIZE = 5000;

export interface DeliveryRecordAnswer {
  /** False when no connected courier publishes a record, or it did not answer. */
  readonly available: boolean;
  readonly reason: 'no_courier' | 'unavailable' | null;
  readonly courier: { readonly code: string; readonly name: string } | null;
  readonly record:
    (DeliveryRecord & { readonly parcels: number; readonly successPercent: number | null }) | null;
  readonly risk: DeliveryRisk | null;
  readonly checkedAt: string | null;
  /** Why it is unavailable, in words, when it is. */
  readonly message: string | null;
}

/**
 * A buyer's delivery record with the brand's courier (D-918), and the courier's balance.
 *
 * The record is Steadfast's official fraud check, asked with the brand's own Steadfast keys,
 * so it is only there once Steadfast is connected in Settings → Couriers. The keys are read in
 * one `withOrg` and the courier is called after it closes (invariant 6). Answers are reused for
 * half an hour per phone, in this process: a desk agent who retypes a number must not cost a
 * second call, and a record that is half an hour old says the same thing.
 *
 * A courier that does not answer is a 200 that says so, never an error the desk has to show:
 * the record is advice, and the order is taken either way.
 */
@Injectable()
export class DeliveryRecordService {
  private readonly cache = new Map<string, { at: number; answer: DeliveryRecordAnswer }>();

  constructor(@Inject(COURIER_ADAPTERS) private readonly adapters: CourierAdapterRegistry) {}

  async lookup(context: ActiveContext, phoneInput: string): Promise<DeliveryRecordAnswer> {
    if (!isNormalizableBdPhone(phoneInput)) {
      throw new CourierError('COURIER_ACCOUNT_INVALID', 'That is not a Bangladeshi mobile number.');
    }
    const phone = normalizeBdPhone(phoneInput);
    const key = `${context.orgId}:${phone}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && Date.now() - cached.at < RECORD_TTL_MS) return cached.answer;

    const source = await this.recordSource(context);
    const adapter = source?.adapter;
    if (source === null || adapter?.deliveryRecord === undefined) {
      return unavailable('no_courier', null, null);
    }
    const courier = { code: adapter.code, name: adapter.name };

    let record: DeliveryRecord;
    try {
      record = await adapter.deliveryRecord(source.context, phone);
    } catch (error) {
      if (!(error instanceof CourierError)) throw error;
      return unavailable(
        'unavailable',
        courier,
        error.code === 'COURIER_CREDENTIALS_MISSING'
          ? `${courier.name} refused the saved keys. Connect it again in Settings → Couriers.`
          : `${courier.name} did not answer. Try again in a minute.`,
      );
    }

    const answer: DeliveryRecordAnswer = {
      available: true,
      reason: null,
      courier,
      record: {
        ...record,
        parcels: recordParcels(record),
        successPercent: deliverySuccessPercent(record),
      },
      risk: deliveryRisk(record),
      checkedAt: new Date().toISOString(),
      message: null,
    };
    this.remember(key, answer);
    return answer;
  }

  /**
   * What the courier holds for the brand, which is also the plainest test that its saved keys
   * still work (Settings → Couriers' "Check connection").
   */
  async balance(context: ActiveContext, accountId: string) {
    const found = await withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const account = await repo.accountById(tx, context.orgId, accountId);
      if (account === undefined) return undefined;
      return { account, adapterContext: adapterContextFor(context.orgId, account) };
    });
    if (found === undefined) {
      throw new CourierError('COURIER_ACCOUNT_NOT_FOUND', 'That courier account does not exist.');
    }
    const adapter = this.adapters.get(found.account.provider_code);
    if (adapter?.balance === undefined) {
      throw new CourierError(
        'COURIER_ACCOUNT_INVALID',
        `${courierName(this.adapters, found.account.provider_code)} does not report a balance.`,
      );
    }
    if (found.account.credentials === null) {
      throw new CourierError('COURIER_CREDENTIALS_MISSING', 'This courier has no keys saved yet.');
    }
    const { balancePoisha } = await adapter.balance(found.adapterContext);
    return { balancePoisha, checkedAt: new Date().toISOString() };
  }

  /** The brand's connected courier that publishes delivery records, Steadfast first. */
  private async recordSource(
    context: ActiveContext,
  ): Promise<{ adapter: CourierAdapter; context: AdapterContext } | null> {
    return withOrg({ orgId: context.orgId, userId: context.userId }, async (tx) => {
      const accounts = await repo.listAccounts(tx, context.orgId, { includeInactive: false });
      const usable = accounts
        .map((account) => ({ account, adapter: this.adapters.get(account.provider_code) }))
        .filter(
          (entry): entry is { account: repo.CourierAccountRow; adapter: CourierAdapter } =>
            entry.adapter?.deliveryRecord !== undefined &&
            adapterEnabled(entry.adapter) &&
            entry.account.credentials !== null,
        )
        .sort(
          (a, b) => Number(b.adapter.code === 'steadfast') - Number(a.adapter.code === 'steadfast'),
        );
      const first = usable[0];
      return first === undefined
        ? null
        : { adapter: first.adapter, context: adapterContextFor(context.orgId, first.account) };
    });
  }

  private remember(key: string, answer: DeliveryRecordAnswer): void {
    this.cache.delete(key);
    this.cache.set(key, { at: Date.now(), answer });
    if (this.cache.size > RECORD_CACHE_SIZE) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }
}

function unavailable(
  reason: 'no_courier' | 'unavailable',
  courier: DeliveryRecordAnswer['courier'],
  message: string | null,
): DeliveryRecordAnswer {
  return { available: false, reason, courier, record: null, risk: null, checkedAt: null, message };
}

/** The adapter's view of a saved account: its keys opened, its address and timeout. */
function adapterContextFor(orgId: string, account: repo.CourierAccountRow): AdapterContext {
  const credentials: Record<string, string> =
    account.credentials === null
      ? {}
      : {
          ...openCredentials(account.credentials, {
            orgId,
            accountId: account.courier_id,
            field: 'credentials',
          }),
        };
  return {
    credentials,
    baseUrl: account.base_url,
    mode: account.mode,
    timeoutMs: courierEnv().COURIER_HTTP_TIMEOUT_MS,
  };
}
