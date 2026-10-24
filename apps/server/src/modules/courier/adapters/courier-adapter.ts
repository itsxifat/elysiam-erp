import type {
  ParcelInput,
  ParcelRef,
  ParcelResult,
  ProviderStatusMap,
  SettlementFileRow,
} from '@elysium/domain/courier';

import type { CourierCredentials } from '../credentials.js';

/**
 * `CourierAdapter` (architecture §9 "Couriers", §21).
 *
 * §9 declares this interface and this file implements it, with three differences that
 * are all about the rules the interface has to live under:
 *
 * 1. **`getStatus` returns the courier's own word, not a normalized status.** §9's
 *    sketch has it return `NormalizedStatus`, which would put the mapping table inside
 *    every adapter — and acceptance check 2 ("every provider status is covered by a
 *    mapping test") is only provable if the mapping is one enumerable table outside
 *    them. So an adapter returns `rawStatus` plus the instant, and
 *    `normalizeStatus(adapter.statusMap, raw)` does the rest, once.
 * 2. **Every method takes its credentials.** §9's sketch reads as though an adapter is
 *    constructed per account. One instance per *provider*, handed the credentials per
 *    call, is what lets the registry be a plain map built at boot — and it means a
 *    credential is decrypted at the moment it is used and never held in a field for the
 *    lifetime of the process (§25).
 * 3. **`parseSettlementFile` is given the bytes and the name.** As §9 has it. What §9
 *    does not say is that no Bangladeshi courier documents its statement format, so the
 *    only honest implementation is a column-mapped CSV parse — see `parseCsvStatement`.
 *
 * Invariant 6 is not this file's to enforce and is the reason it exists: every method
 * here makes an outbound HTTP call, so nothing may call one inside a transaction. They
 * are called from pg-boss handlers, which are handed no `tx` precisely so that the rule
 * is hard to break by accident.
 */

export interface AdapterContext {
  /** Decrypted at the call site, held for the duration of the call and no longer. */
  readonly credentials: CourierCredentials;
  /** Per-account override of the provider's default. */
  readonly baseUrl?: string | null;
  readonly mode: 'sandbox' | 'live';
  readonly timeoutMs: number;
}

/** One courier event, as an adapter reports it before normalization. */
export interface RawCourierEvent {
  /** The courier's id for the parcel. How we find the consignment. */
  readonly consignmentNo: string;
  /** Our own reference, when the courier echoes it. A fallback match. */
  readonly reference: string | null;
  /** The courier's own status word. `normalizeStatus` turns it into one of §9's twelve. */
  readonly rawStatus: string;
  /** When the courier says it happened. Falls back to receipt time at the call site. */
  readonly occurredAt: Date | null;
  /** What the rider collected, when the event says. Poisha as a decimal string. */
  readonly collectedPoisha: string | null;
  /**
   * The event's own body, already stripped of the recipient's name, phone and address.
   *
   * Stripped by the adapter and not by the caller, because only the adapter knows which
   * of its provider's fields carry them — and a caller stripping a fixed list of keys
   * would miss the one the next provider spells differently (invariant 10).
   */
  readonly payload: Record<string, unknown>;
}

/** What a settlement file parsed into. `rows` go straight to the domain's matcher. */
export interface SettlementBatch {
  /** The courier's statement number, when the file carries one. */
  readonly reference: string | null;
  /** The statement's own date. D-037's reference field. */
  readonly settlementDate: string;
  readonly rows: readonly SettlementFileRow[];
}

export interface CourierAdapter {
  /** `steadfast`, `fake`. Matches `sales.couriers.code` and the account's provider. */
  readonly code: string;
  /** The courier's own name, for a person: the party's name when connecting creates it (D-913). */
  readonly name: string;
  /**
   * False for an adapter built from anything other than the courier's own documentation
   * (§21, D-006).
   *
   * On the adapter and not only in decisions.md, because the value is read at the point
   * it matters: activating an account whose adapter is unverified is refused unless the
   * installation has explicitly enabled it.
   */
  readonly verified: boolean;
  /** The vocabulary the mapping test enumerates (acceptance check 2). */
  readonly statusMap: ProviderStatusMap;
  /** Whether §9's webhook path applies, or only the polling fallback. */
  readonly supportsWebhook: boolean;
  /** Which credential fields this adapter needs, for the account form to demand them. */
  readonly credentialFields: readonly string[];
  /** Fields an account may add beyond those (Pathao's password grant), and no others (D-913). */
  readonly optionalCredentialFields?: readonly string[];

  /**
   * Ask the courier whether these keys work (D-913), with a call this adapter already makes —
   * never an endpoint of its own. Resolves when the courier accepted them; throws
   * `COURIER_CREDENTIALS_REJECTED` with a plain sentence when it refused them, and
   * `COURIER_UNAVAILABLE` when it did not answer. An outbound call: never inside a
   * transaction (invariant 6).
   */
  verifyCredentials(context: AdapterContext): Promise<void>;

  /** Idempotent on our order reference, per §9. */
  createParcel(context: AdapterContext, input: ParcelInput): Promise<ParcelResult>;
  cancelParcel?(context: AdapterContext, ref: ParcelRef): Promise<void>;
  /** The courier's own status word and the instant, for `normalizeStatus` to map. */
  getStatus(
    context: AdapterContext,
    ref: ParcelRef,
  ): Promise<{ rawStatus: string; occurredAt: Date | null; collectedPoisha: string | null }>;
  /**
   * Verify the request came from this courier, and pull the events out of it (§9).
   *
   * Returns `null` when authenticity fails, rather than throwing: the caller answers
   * 401 and records nothing, and a thrown error would be indistinguishable from the
   * adapter itself being broken.
   */
  parseWebhook?(
    context: AdapterContext,
    request: {
      readonly headers: Readonly<Record<string, string | undefined>>;
      readonly raw: Buffer;
    },
  ): Promise<readonly RawCourierEvent[] | null>;
  parseSettlementFile?(
    context: AdapterContext,
    file: Buffer,
    name: string,
  ): Promise<SettlementBatch>;

  /**
   * Ask the courier's API for the statements issued since a date (§9, §20; M15).
   *
   * Present only on an adapter whose courier's documentation describes a settlement API.
   * **None of the three real couriers' first-party material does** — Steadfast's package
   * exposes a balance and nothing itemised, Pathao's plugin receives a `order.paid` event
   * per parcel but no statement, and RedX's plugin only creates parcels — so today only the
   * fake implements it. The interface, the job, the idempotency and the tests exist so the
   * day a courier publishes one, the adapter method is the only thing left to write.
   *
   * An outbound call: called from the fetch job, never inside a transaction (invariant 6).
   * Returns every statement dated on or after `since`; returning one already imported is
   * expected and harmless, because the importer recognises it by fingerprint.
   */
  fetchSettlements?(context: AdapterContext, since: string): Promise<readonly SettlementBatch[]>;

  /**
   * What the webhook route must answer with, when the courier specifies it.
   *
   * Pathao's plugin answers every webhook `202` with an `X-Pathao-Merchant-Webhook-Integration-Secret`
   * header, and Pathao's merchant panel refuses to register a callback URL that does not.
   * Absent for a courier that only needs a 2xx.
   */
  readonly webhookAcknowledgement?: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
  };
}

/**
 * The adapters this process has.
 *
 * A map built once at boot rather than a lookup that constructs on demand, so an
 * unknown provider code is an error at the call site with the known codes in the
 * message — not a silently-undefined adapter whose first symptom is a booking job that
 * throws `cannot read properties of undefined`.
 */
export class CourierAdapterRegistry {
  private readonly adapters = new Map<string, CourierAdapter>();

  constructor(adapters: readonly CourierAdapter[]) {
    for (const adapter of adapters) {
      if (this.adapters.has(adapter.code)) {
        throw new Error(`two courier adapters claim the code "${adapter.code}"`);
      }
      this.adapters.set(adapter.code, adapter);
    }
  }

  get(code: string): CourierAdapter | undefined {
    return this.adapters.get(code);
  }

  codes(): readonly string[] {
    return [...this.adapters.keys()];
  }

  all(): readonly CourierAdapter[] {
    return [...this.adapters.values()];
  }
}

/** The Nest injection token for the registry. */
export const COURIER_ADAPTERS = Symbol('CourierAdapterRegistry');
