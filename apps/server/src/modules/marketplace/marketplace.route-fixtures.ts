import { randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { ncomSignatureHeader } from '@elysium/domain/storefront';
import { sql } from 'drizzle-orm';

import { seal } from '../../platform/crypto/sealed-box.js';

/**
 * How the route-matrix suite and the cost sweep call M35b's marketplace routes (D-070): the
 * console's Website → Marketplace, and the connector ncom reads (signed as ncom would sign it,
 * with a connector secret sealed into the brand's settings here).
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
export const FIXTURE_CONNECTOR_KEY = 'ncomcat_route_matrix';
export const FIXTURE_CONNECTOR_SECRET = 'ncomsec_route_matrix_secret';

let warehouse: string | undefined;

/** The brand's ncom settings with a sealed connector secret; idempotent. */
export async function prepareMarketplaceFixtures(): Promise<void> {
  const sealed = seal(FIXTURE_CONNECTOR_SECRET, {
    orgId: ORG_A,
    row: 'ncom_settings',
    field: 'connector_secret',
  });
  warehouse = await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into marketplace.ncom_settings
          (org_id, enabled, include_drafts, connector_key_id, connector_secret_sealed,
           connector_secret_fingerprint, key_id, updated_by)
        values (${ORG_A}, true, true, ${FIXTURE_CONNECTOR_KEY}, ${sealed.ciphertext},
                ${sealed.fingerprint}, ${sealed.keyId}, 'usr_marketplace_fixture')
        on conflict (org_id) do nothing
      `);
      return (
        await tx.execute<{ id: string }>(sql`
          select id from org.locations where org_id = ${ORG_A} and code = 'WH-01'
        `)
      )[0]?.id;
    },
    { orgId: ORG_A },
  );
}

/** A fresh, empty hold for a release to give back. */
async function insertHold(): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ id: string }>(sql`
          insert into marketplace.ncom_holds (org_id, order_ref, location_id, lines)
          values (${ORG_A}, ${`matrix-${randomUUID()}`}, ${warehouse ?? ''}, '[]'::jsonb)
          returning id
        `)
      )[0]?.id ?? '',
    { orgId: ORG_A },
  );
}

export const MARKETPLACE_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/marketplace/ncom': () => ({ url: '/v1/marketplace/ncom' }),
  'PUT /v1/marketplace/ncom': () => ({
    url: '/v1/marketplace/ncom',
    body: {
      enabled: true,
      acceptOrders: false,
      includeDrafts: true,
      allowSearch: true,
      allowCategories: true,
      allowReserve: true,
      defaultWeightGrams: 0,
      publicBaseUrl: '',
      baseUrl: 'https://ncom.example.test/api/v1',
      connectorKeyId: FIXTURE_CONNECTOR_KEY,
      orderKeyId: '',
    },
  }),
  'GET /v1/marketplace/ncom/holds': () => ({ url: '/v1/marketplace/ncom/holds' }),
  'POST /v1/marketplace/ncom/holds/:id/release': async () => ({
    url: `/v1/marketplace/ncom/holds/${await insertHold()}/release`,
  }),
  'GET /v1/marketplace/ncom/orders': () => ({ url: '/v1/marketplace/ncom/orders' }),
};

/** The connector's routes, signed as ncom signs them, for the cost sweep. */
export const NCOM_CONNECTOR_FIXTURES: Readonly<
  Record<
    string,
    () => { readonly method: 'GET' | 'POST'; readonly path: string; readonly body?: unknown }
  >
> = {
  'GET /ncom/:orgId/v1/ping': () => ({ method: 'GET', path: `/ncom/${ORG_A}/v1/ping` }),
  'GET /ncom/:orgId/v1/products': () => ({
    method: 'GET',
    path: `/ncom/${ORG_A}/v1/products?limit=100`,
  }),
  'GET /ncom/:orgId/v1/categories': () => ({ method: 'GET', path: `/ncom/${ORG_A}/v1/categories` }),
  'POST /ncom/:orgId/v1/stock': () => ({
    method: 'POST',
    path: `/ncom/${ORG_A}/v1/stock`,
    body: { ids: [] },
  }),
};

/** The headers ncom sends with a connector call. */
export function ncomFixtureHeaders(raw: string): Record<string, string> {
  return {
    'x-ncom-key': FIXTURE_CONNECTOR_KEY,
    'x-ncom-contract': '1',
    'x-ncom-signature': ncomSignatureHeader(
      FIXTURE_CONNECTOR_SECRET,
      raw,
      Math.floor(Date.now() / 1000),
    ),
  };
}
