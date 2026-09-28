import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS } from '@elysium/db';

import {
  seedProductWithSkus,
  warehouseId,
  type SeededSku,
} from '../inventory/inventory.testing.js';
import { applySupplyMigrations, seedSupplier, walletAccountId } from './supply.testing.js';

/**
 * How the route-matrix suite calls M09's routes (M02b's D-070 gate).
 *
 * `route-matrix.e2e.test.ts` asserts that its fixture keys, the manifest and the
 * application's live routes are the same three sets — so the moment `SupplyModule` is
 * registered in `app.module.ts`, that suite fails until these exist. They live here
 * rather than in the suite because the suite is one file shared by every milestone
 * building in parallel, and a second write to it silently discards the first; the
 * integrator adds one import and one spread.
 *
 * The fixtures deliberately do **not** try to succeed. The suite's question is which
 * roles the *guard* admits, so a 404 or a 409 from a handler is as good as a 201 — what
 * matters is that it is not a 403. The exceptions are the mutations, which the suite also
 * checks leave an audit row, so those get real ids to work on and a fresh uuid per call
 * so the second admitted role is not answered from the first's row.
 *
 * `prepare()` is idempotent and cheap after the first call: it applies this milestone's
 * migrations (the journal is integrated separately) and seeds one supplier, one product
 * and one received entry.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

interface Fixtures {
  readonly location: string;
  readonly walletAccount: string;
  readonly supplier: string;
  readonly skuId: string;
  readonly draftId: string;
}

let prepared: Fixtures | undefined;

/** Called once from the route-matrix suite's `beforeAll`. */
export async function prepareSupplyFixtures(): Promise<void> {
  if (prepared !== undefined) return;
  await applySupplyMigrations();

  const location = await warehouseId(ORG_A);
  const walletAccount = await walletAccountId(ORG_A);
  const supplier = await seedSupplier(ORG_A, { code: 'SUP-RM', name: 'Route Matrix Mills' });
  const seeded: { skus: SeededSku[] } = await seedProductWithSkus(ORG_A, 'supplyrm', 1);

  prepared = {
    location,
    walletAccount,
    supplier,
    skuId: seeded.skus[0]?.id ?? '',
    // A draft is not pre-made: `POST /drafts` creates its own, and the receive and
    // patch fixtures point at a uuid that does not exist on purpose — an admitted role
    // gets a 404 from the handler, which is not a 403 and is all the suite asks.
    draftId: randomUUID(),
  };
}

function state(): Fixtures {
  if (prepared === undefined) {
    throw new Error('call prepareSupplyFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

export const SUPPLY_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/supply/suppliers': () => ({ url: '/v1/supply/suppliers' }),
  'GET /v1/supply/suppliers/:id': () => ({ url: `/v1/supply/suppliers/${state().supplier}` }),
  'POST /v1/supply/suppliers': () => ({
    url: '/v1/supply/suppliers',
    // A fresh code per call: the suite runs each fixture once per role, and a duplicate
    // code would answer 409 for the second admitted role.
    body: { code: `SUP-${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Route Matrix Supplier' },
  }),
  'PATCH /v1/supply/suppliers/:id': () => ({
    url: `/v1/supply/suppliers/${state().supplier}`,
    body: { name: 'Route Matrix Mills Ltd' },
  }),
  'POST /v1/supply/suppliers/:id/contacts': () => ({
    url: `/v1/supply/suppliers/${state().supplier}/contacts`,
    body: { name: 'Merchandiser', role: 'merchandiser' },
  }),
  'POST /v1/supply/suppliers/:id/notes': () => ({
    url: `/v1/supply/suppliers/${state().supplier}/notes`,
    body: { body: 'Called about the delayed lot.' },
  }),
  'POST /v1/supply/suppliers/:id/documents': () => ({
    url: `/v1/supply/suppliers/${state().supplier}/documents`,
    // A uuid with no file behind it: an admitted role gets a 404 for the missing file,
    // which is not a 403.
    body: { fileObjectId: randomUUID(), label: 'Trade licence' },
  }),
  'GET /v1/supply/suppliers/:id/statement': () => ({
    url: `/v1/supply/suppliers/${state().supplier}/statement?to=2030-12-31`,
  }),

  'GET /v1/supply/entries': () => ({ url: '/v1/supply/entries' }),
  'GET /v1/supply/entries/:id': () => ({ url: `/v1/supply/entries/${state().draftId}` }),
  'POST /v1/supply/drafts': () => ({
    url: '/v1/supply/drafts',
    body: {
      draftId: randomUUID(),
      supplierId: state().supplier,
      locationId: state().location,
      lines: [{ skuId: state().skuId, qty: 1 }],
    },
  }),
  'PATCH /v1/supply/drafts/:id': () => ({
    url: `/v1/supply/drafts/${state().draftId}`,
    body: { invoiceNumber: 'RM-0001' },
  }),
  'DELETE /v1/supply/drafts/:id': () => ({ url: `/v1/supply/drafts/${randomUUID()}` }),
  'POST /v1/supply/entries/:id/receive': () => ({
    url: `/v1/supply/entries/${state().draftId}/receive`,
    body: { lines: [{ skuId: state().skuId, unitCostPoisha: '1000' }] },
  }),
  'POST /v1/supply/entries': () => ({
    url: '/v1/supply/entries',
    body: {
      supplyId: randomUUID(),
      supplierId: state().supplier,
      locationId: state().location,
      lines: [{ skuId: state().skuId, qty: 1, unitCostPoisha: '1000' }],
    },
  }),

  'GET /v1/supply/returns': () => ({ url: '/v1/supply/returns' }),
  'POST /v1/supply/returns': () => ({
    url: '/v1/supply/returns',
    body: {
      returnId: randomUUID(),
      supplierId: state().supplier,
      locationId: state().location,
      reason: 'Route matrix return',
      lines: [{ skuId: state().skuId, qty: 1, originalUnitCostPoisha: '1000' }],
    },
  }),

  'GET /v1/supply/payments': () => ({ url: '/v1/supply/payments' }),
  'POST /v1/supply/payments': () => ({
    url: '/v1/supply/payments',
    body: {
      paymentId: randomUUID(),
      supplierId: state().supplier,
      walletAccountId: state().walletAccount,
      kind: 'payment',
      amountPoisha: '100',
    },
  }),
  'POST /v1/supply/advance-applications': () => ({
    url: '/v1/supply/advance-applications',
    // Points at no advance on purpose: an admitted role gets a 404, not a 403.
    body: {
      applicationId: randomUUID(),
      paymentId: randomUUID(),
      supplyId: randomUUID(),
      amountPoisha: '100',
    },
  }),
};
