import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { makeLocation } from '../inventory/inventory.testing.js';
import { seedWallet } from '../wallets/wallets.testing.js';

/**
 * How the route-matrix suite calls M23's routes (M02b's D-070 gate).
 *
 * The suite asserts its fixture keys, the manifest and the application's live
 * routes are the same three sets. They live here because the suite is one file
 * shared by every milestone, which takes one import and one spread per module.
 *
 * Every fixture is a **thunk** (`() => Call`), never a getter: each is evaluated
 * once per role, after `preparePosFixtures()` has run, so a fresh id per call is
 * possible and nothing reads state at import time.
 *
 * The fixtures do not try to succeed. The suite's question is which roles the
 * *guard* admits, and three things about this module shape the answers:
 *
 * - **A branch-scoped caller answers 404.** The suite signs its roles in with no
 *   branch memberships, so a branch manager's `Wallet` scope matches no register
 *   and every register, shift and branch here reads as missing — deliberately, and
 *   an admission by the guard.
 * - **The sync answers 200 even when it refuses the document.** One result per
 *   document is the contract, so a sale on a shift that does not exist is a 200
 *   whose result says `rejected`. The audit interceptor's net records that
 *   mutation, which is what the suite's audit assertion finds.
 * - **Each branch day close takes its own date**, in 2018, before anything this
 *   suite posts: the expectation is derived up to the date being closed, so it is
 *   zero, a counted zero balances, and no approval is raised. `wallet_closings` is
 *   unique per (wallet, date), so a shared date would answer 409 after the first
 *   admitted role.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

interface Fixtures {
  readonly branchId: string;
  readonly locationId: string;
  readonly cashWalletId: string;
  readonly registerId: string;
}

let prepared: Fixtures | undefined;

/** Called once from the route-matrix suite's `beforeAll`, after the harness boots. */
export async function preparePosFixtures(): Promise<void> {
  if (prepared !== undefined) return;

  const branchId = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(
          sql`select id from org.branches where org_id = ${ORG_A} and code = 'HQ'`,
        )
      )[0]?.id ?? '',
    { orgId: ORG_A },
  );
  const locationId = await makeLocation(ORG_A, {
    code: 'RM-POS',
    name: 'Route matrix showroom',
    kind: 'showroom',
    branchId,
  });
  const cash = await seedWallet(ORG_A, '1010-HQ', { provider: 'Route matrix till' });

  const registerId = await withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          insert into pos.registers (org_id, branch_id, location_id, code, name, cash_wallet_id, created_by)
          values (${ORG_A}, ${branchId}, ${locationId}, 'RM01', 'Route matrix till', ${cash.id}, 'usr_route_matrix')
          on conflict (org_id, code) do update set name = excluded.name
          returning id
        `)
      )[0]?.id ?? '',
    { orgId: ORG_A },
  );

  prepared = { branchId, locationId, cashWalletId: cash.id, registerId };
}

function state(): Fixtures {
  if (prepared === undefined) {
    throw new Error('call preparePosFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

/** Upper-case alphanumerics, which is what a register code is made of. */
function token(length = 6): string {
  return randomUUID().replace(/-/g, '').slice(0, length).toUpperCase();
}

let closingIndex = 0;
/** A distinct, long-past business date per call: 2018-01-01, 2018-01-02, … */
function nextClosingDate(): string {
  closingIndex += 1;
  return new Date(Date.UTC(2018, 0, closingIndex)).toISOString().slice(0, 10);
}

/** A fresh branch to rename (M39a, D-633): never the brand's own head office. */
async function freshBranch(): Promise<string> {
  return withSystem(
    async (tx) => {
      const rows = await tx.execute<{ id: string }>(sql`
        insert into org.branches (org_id, code, name, kind)
        values (${ORG_A}, ${`RMB${token(5)}`}, 'Route matrix branch', 'showroom')
        returning id
      `);
      return rows[0]?.id ?? '';
    },
    { orgId: ORG_A },
  );
}

export const POS_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  // M39a (D-633): what still runs at a branch, and renaming one.
  'GET /v1/pos/branches/:id/holds': () => ({ url: `/v1/pos/branches/${state().branchId}/holds` }),
  'PATCH /v1/pos/branches/:id': async () => ({
    url: `/v1/pos/branches/${await freshBranch()}`,
    body: { name: 'Route matrix branch renamed' },
  }),
  'GET /v1/pos/registers': () => ({ url: '/v1/pos/registers' }),
  'POST /v1/pos/registers': () => ({
    url: '/v1/pos/registers',
    // A new code per call: `pos_registers_org_code_idx` is unique per org, so a
    // fixed one would answer 400 to every admitted role after the first.
    body: {
      branchId: state().branchId,
      locationId: state().locationId,
      code: `R${token(5)}`,
      name: 'Route matrix',
      cashWalletId: state().cashWalletId,
    },
  }),
  'PATCH /v1/pos/registers/:id': () => ({
    url: `/v1/pos/registers/${state().registerId}`,
    // The name, never `isActive: false`: a deactivated register would turn every
    // later shift fixture into a refusal for a reason unrelated to the guard.
    body: { name: 'Route matrix till' },
  }),
  'GET /v1/pos/registers/:id/session': () => ({
    url: `/v1/pos/registers/${state().registerId}/session`,
  }),
  'GET /v1/pos/registers/:id/price-list': () => ({
    url: `/v1/pos/registers/${state().registerId}/price-list?limit=5`,
  }),
  'POST /v1/pos/promo-codes/check': () => ({
    url: '/v1/pos/promo-codes/check',
    body: { registerId: state().registerId, code: 'ROUTE', basketPoisha: '1000' },
  }),

  'GET /v1/pos/shifts': () => ({ url: '/v1/pos/shifts' }),
  'GET /v1/pos/shifts/:id': () => ({ url: `/v1/pos/shifts/${randomUUID()}` }),
  'POST /v1/pos/shifts': () => ({
    url: '/v1/pos/shifts',
    // The first admitted role opens it; the rest answer 409, which is still an
    // admission. A fresh shift id each time, so none of them is a replay.
    body: { shiftId: randomUUID(), registerId: state().registerId, openingFloatPoisha: '0' },
  }),
  'POST /v1/pos/shifts/:id/close': () => ({
    url: `/v1/pos/shifts/${randomUUID()}/close`,
    body: { countedCashPoisha: '0' },
  }),

  'POST /v1/pos/sync': () => ({
    url: '/v1/pos/sync',
    // A sale on a shift that does not exist: 200, with the document `rejected`.
    // Nothing is posted and no stock moves, so the fixture needs no catalog.
    body: {
      documents: [
        {
          kind: 'sale',
          id: randomUUID(),
          registerId: state().registerId,
          shiftId: randomUUID(),
          receiptNo: `RM01-0-${token(4)}`,
          occurredAt: new Date().toISOString(),
          lines: [
            {
              lineNo: 1,
              skuId: randomUUID(),
              qty: 1,
              unitPricePoisha: '1000',
              discountPoisha: '0',
            },
          ],
          tenders: [{ tender: 'cash', amountPoisha: '1000' }],
          totals: { grossPoisha: '1000', discountPoisha: '0', netPoisha: '1000' },
        },
      ],
    },
  }),
  'GET /v1/pos/receipts/:receiptNo': () => ({ url: '/v1/pos/receipts/RM01-0-0000' }),
  'GET /v1/pos/sales/:id': () => ({ url: `/v1/pos/sales/${randomUUID()}` }),

  'GET /v1/pos/reviews': () => ({ url: '/v1/pos/reviews?status=open' }),
  'POST /v1/pos/reviews/:id/resolve': () => ({
    url: `/v1/pos/reviews/${randomUUID()}/resolve`,
    body: { action: 'void', note: 'Route matrix' },
  }),

  'GET /v1/pos/branches': () => ({ url: '/v1/pos/branches' }),
  'GET /v1/pos/branches/:id/summary': () => ({
    url: `/v1/pos/branches/${state().branchId}/summary?from=2018-01-01&to=2018-01-31`,
  }),
  'GET /v1/pos/branches/:id/closings': () => ({
    url: `/v1/pos/branches/${state().branchId}/closings?from=2018-01-01&to=2018-12-31`,
  }),
  'POST /v1/pos/branches/:id/closings': () => ({
    url: `/v1/pos/branches/${state().branchId}/closings`,
    body: {
      closingId: randomUUID(),
      businessDate: nextClosingDate(),
      counts: [{ walletId: state().cashWalletId, countedPoisha: '0' }],
    },
  }),
};

/** This module's manifest entries, derived from the fixtures. */
export const POS_ROUTE_KEYS: readonly string[] = Object.keys(POS_ROUTE_FIXTURES);
