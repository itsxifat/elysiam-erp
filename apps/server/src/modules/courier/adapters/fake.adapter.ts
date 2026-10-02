import { randomUUID } from 'node:crypto';

import {
  assertParcelInput,
  codAmountAsTaka,
  FAKE_STATUS_MAP,
  type ParcelInput,
  type ParcelRef,
  type ParcelResult,
} from '@elysium/domain/courier';

import { secretMatches } from '../credentials.js';
import { CourierError } from '../courier.errors.js';
import { parseCsvStatement } from './csv-statement.js';
import type {
  AdapterContext,
  CourierAdapter,
  RawCourierEvent,
  SettlementBatch,
} from './courier-adapter.js';

/**
 * The fake courier (architecture §21: "every adapter has a fake implementation").
 *
 * Not a stub. It is the adapter the contract tests run against, the one the
 * duplicate-webhook test and the book → deliver → settle scenario use, and the one a
 * developer with no courier account develops against — so it has to behave like a
 * courier, including the parts of a courier's behaviour that are annoying:
 *
 * - it refuses a parcel whose input is bad, before assigning a number;
 * - it is **idempotent on our reference**, as §9 requires of `createParcel`, so booking
 *   the same order twice returns the same consignment number rather than a second parcel;
 * - it verifies its webhook's authenticity, so the 401 path is exercised;
 * - its status vocabulary is its own, deliberately unlike Steadfast's, so a test that
 *   accidentally depends on one provider's spelling fails on the other.
 *
 * State lives in this instance, which is exactly right for its purpose: one process, one
 * fake courier, reset between suites. Nothing about it is durable, and nothing should be
 * — a fake whose bookings survived a restart would let a test pass because of a previous
 * test's parcel.
 */

interface FakeParcel {
  readonly consignmentNo: string;
  readonly trackingCode: string;
  readonly reference: string;
  readonly codTaka: string;
  rawStatus: string;
  collectedPoisha: string | null;
  at: Date;
}

export class FakeCourierAdapter implements CourierAdapter {
  readonly code = 'fake';
  /** Its own docs are this file, so it is the one adapter that is honestly verified. */
  readonly verified = true;
  readonly statusMap = FAKE_STATUS_MAP;
  readonly supportsWebhook = true;
  readonly credentialFields = [];

  private readonly parcels = new Map<string, FakeParcel>();
  private readonly byReference = new Map<string, string>();

  /** Test-only: forget every parcel, statement and queued failure. */
  reset(): void {
    this.parcels.clear();
    this.byReference.clear();
    this.issuedStatements.length = 0;
    this.failNextFetches = 0;
  }

  /**
   * Test-only: the statements the fake courier's "settlement API" has issued (M15).
   *
   * The fake is the only adapter with `fetchSettlements`, because none of the real couriers'
   * first-party material describes a settlement API (see the interface). So it is what the
   * idempotency check runs against: a test issues a statement here, runs the fetch twice, and
   * asserts one batch.
   */
  readonly issuedStatements: SettlementBatch[] = [];

  /** Test-only: make the next `n` settlement fetches fail as a courier outage would. */
  failNextFetches = 0;

  fetchSettlements(_context: AdapterContext, since: string): Promise<readonly SettlementBatch[]> {
    if (this.failNextFetches > 0) {
      this.failNextFetches -= 1;
      return Promise.reject(
        new CourierError('COURIER_UNAVAILABLE', 'The courier did not answer.', true),
      );
    }
    // Every statement dated on or after `since`, as a real API would answer a window.
    return Promise.resolve(
      this.issuedStatements.filter((statement) => statement.settlementDate >= since),
    );
  }

  /** Test-only: the parcels this fake is holding, for a suite to assert against. */
  snapshot(): readonly FakeParcel[] {
    return [...this.parcels.values()];
  }

  /**
   * Test-only: make the fake refuse the next `n` bookings.
   *
   * What acceptance check 6 needs — "a booking that fails after all retries raises
   * `delivery.booking_failed` and flags the order" — is a courier that is down, and the
   * only honest way to test that is a courier that is down. `retryable` is true, because
   * a courier being unreachable is exactly the case §20's five retries exist for.
   */
  failNextBookings = 0;

  /** Test-only: make the fake refuse the next `n` bookings permanently. */
  rejectNextBookings = 0;

  async createParcel(_context: AdapterContext, input: ParcelInput): Promise<ParcelResult> {
    assertParcelInput(input);

    if (this.rejectNextBookings > 0) {
      this.rejectNextBookings -= 1;
      throw new CourierError(
        'COURIER_BOOKING_FAILED',
        'The courier refused this parcel and will keep refusing it.',
        false,
      );
    }
    if (this.failNextBookings > 0) {
      this.failNextBookings -= 1;
      throw new CourierError('COURIER_UNAVAILABLE', 'The courier did not answer.', true);
    }

    // §9: "idempotent on our order id". The second call for one reference returns the
    // first parcel — which is what makes a retried job safe even when the first attempt
    // reached the courier and only its answer was lost.
    const existingNo = this.byReference.get(input.reference);
    if (existingNo !== undefined) {
      const existing = this.parcels.get(existingNo);
      if (existing !== undefined) {
        return await Promise.resolve({
          consignmentNo: existing.consignmentNo,
          trackingCode: existing.trackingCode,
          rawStatus: existing.rawStatus,
        });
      }
    }

    const consignmentNo = `FK-${randomUUID().slice(0, 8).toUpperCase()}`;
    const parcel: FakeParcel = {
      consignmentNo,
      trackingCode: `TRK${consignmentNo}`,
      reference: input.reference,
      codTaka: codAmountAsTaka(input.codAmountPoisha),
      rawStatus: 'created',
      collectedPoisha: null,
      at: new Date(),
    };
    this.parcels.set(consignmentNo, parcel);
    this.byReference.set(input.reference, consignmentNo);

    return Promise.resolve({
      consignmentNo,
      trackingCode: parcel.trackingCode,
      rawStatus: parcel.rawStatus,
    });
  }

  async cancelParcel(_context: AdapterContext, ref: ParcelRef): Promise<void> {
    const parcel = this.parcels.get(ref.consignmentNo);
    if (parcel === undefined) {
      throw new CourierError('CONSIGNMENT_NOT_FOUND', 'The courier has no such parcel.');
    }
    parcel.rawStatus = 'called_off';
    parcel.at = new Date();
    return Promise.resolve();
  }

  async getStatus(
    _context: AdapterContext,
    ref: ParcelRef,
  ): Promise<{ rawStatus: string; occurredAt: Date | null; collectedPoisha: string | null }> {
    const parcel = this.parcels.get(ref.consignmentNo);
    if (parcel === undefined) {
      throw new CourierError('CONSIGNMENT_NOT_FOUND', 'The courier has no such parcel.');
    }
    return Promise.resolve({
      rawStatus: parcel.rawStatus,
      occurredAt: parcel.at,
      collectedPoisha: parcel.collectedPoisha,
    });
  }

  /**
   * Test and development only: move a parcel, as the courier's own operations would.
   *
   * `collectedPoisha` defaults to the COD we asked for, because that is what a rider who
   * collected in full hands over — and a test that had to restate the amount would be a
   * test that could disagree with the order it was built from.
   */
  advance(
    consignmentNo: string,
    rawStatus: string,
    options: { collectedPoisha?: string; at?: Date } = {},
  ): void {
    const parcel = this.parcels.get(consignmentNo);
    if (parcel === undefined) throw new Error(`the fake courier has no parcel ${consignmentNo}`);
    parcel.rawStatus = rawStatus;
    parcel.at = options.at ?? new Date();
    if (rawStatus === 'handed_to_customer' || rawStatus === 'part_handed') {
      const taka = parcel.codTaka.replace('.', '');
      parcel.collectedPoisha = options.collectedPoisha ?? String(BigInt(taka));
    }
  }

  /** The body this fake's "courier" would POST. Used by the webhook tests. */
  webhookBody(consignmentNo: string): Record<string, unknown> {
    const parcel = this.parcels.get(consignmentNo);
    if (parcel === undefined) throw new Error(`the fake courier has no parcel ${consignmentNo}`);
    return {
      consignment_no: parcel.consignmentNo,
      reference: parcel.reference,
      state: parcel.rawStatus,
      at: parcel.at.toISOString(),
      collected_poisha: parcel.collectedPoisha,
      // Deliberately present, and deliberately dropped by `parseWebhook`: the recipient's
      // details are what a real courier echoes and what invariant 10 keeps out of our
      // stored payload. A fake that did not send them would let the stripping rot.
      recipient_name: 'Rahim Uddin',
      recipient_phone: '+8801712345678',
    };
  }

  async parseWebhook(
    context: AdapterContext,
    request: { headers: Readonly<Record<string, string | undefined>>; raw: Buffer },
  ): Promise<readonly RawCourierEvent[] | null> {
    /*
     * Fail closed with no secret configured, as every real adapter does (M30, D1). The fake
     * is registered everywhere, production included, because the preview and a brand trying
     * the desk use it. Before this, an account set up without a secret accepted any body
     * from anyone who knew the org id (public, from login branding) and a consignment number
     * (in the public tracking answer), and that body could mark an order delivered and post
     * its revenue.
     */
    const expected = context.credentials.webhookSecret;
    const presented = request.headers['x-fake-courier-secret'];
    if (expected === undefined || presented === undefined || !secretMatches(presented, expected)) {
      return Promise.resolve(null);
    }

    let body: unknown;
    try {
      body = JSON.parse(request.raw.toString('utf8'));
    } catch {
      throw new CourierError('SETTLEMENT_FILE_INVALID', 'That webhook body is not JSON.');
    }
    const entries = Array.isArray(body) ? body : [body];

    return Promise.resolve(
      entries.map((entry) => {
        const row = entry as Record<string, unknown>;
        const consignmentNo = typeof row.consignment_no === 'string' ? row.consignment_no : '';
        const rawStatus = typeof row.state === 'string' ? row.state : '';
        const at = typeof row.at === 'string' ? new Date(row.at) : null;
        return {
          consignmentNo,
          reference: typeof row.reference === 'string' ? row.reference : null,
          rawStatus,
          occurredAt: at !== null && !Number.isNaN(at.getTime()) ? at : null,
          collectedPoisha: typeof row.collected_poisha === 'string' ? row.collected_poisha : null,
          // An allow-list, so the recipient's name and number in the body above never
          // reach `consignment_events.payload` (invariant 10, §19).
          payload: { consignment_no: consignmentNo, state: rawStatus, at: row.at ?? null },
        } satisfies RawCourierEvent;
      }),
    );
  }

  async parseSettlementFile(
    _context: AdapterContext,
    file: Buffer,
    name: string,
  ): Promise<SettlementBatch> {
    const { rows } = parseCsvStatement(file);
    // The date and the statement number come out of the file name, which is how the
    // fake mimics the one thing real exports do carry: `FAKE-2026-03-31-S1234.csv`.
    const date = /(\d{4}-\d{2}-\d{2})/.exec(name)?.[1];
    if (date === undefined) {
      throw new CourierError(
        'SETTLEMENT_FILE_INVALID',
        'A fake statement’s name carries its date, e.g. fake-2026-03-31.csv.',
      );
    }
    return Promise.resolve({
      reference: /-(S\d+)\./i.exec(name)?.[1] ?? null,
      settlementDate: date,
      rows,
    });
  }
}
