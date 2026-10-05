import { randomInt, randomUUID } from 'node:crypto';

import { SEED_ORG_IDS, withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

/**
 * How the route-matrix suite and the cost sweep call M35b's campaign-link and tracking routes
 * (D-070). A link exists for the reads and the website's code; each delete gets a link of its
 * own so every admitted role's call succeeds.
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const ORG_A = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';

let prepared: { readonly linkId: string; readonly code: string } | undefined;

async function insertLink(): Promise<{ id: string; code: string }> {
  return withSystem(
    async (tx) => {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const code = String(10_000 + randomInt(0, 90_000));
        const rows = await tx.execute<{ id: string }>(sql`
          insert into storefront.custom_links
            (org_id, code, title, base_type, banner, modal, created_by, updated_by)
          values (${ORG_A}, ${code}, 'Route matrix link', 'shop', '{}'::jsonb, '{}'::jsonb,
                  'usr_storefront_fixture', 'usr_storefront_fixture')
          on conflict (org_id, code) do nothing
          returning id
        `);
        const id = rows[0]?.id;
        if (id !== undefined) return { id, code };
      }
      throw new Error('no free campaign code for the fixture');
    },
    { orgId: ORG_A },
  );
}

/** Idempotent; called from `prepareStorefrontFixtures`, so both suites have it. */
export async function prepareWebMarketingFixtures(): Promise<void> {
  if (prepared !== undefined) return;
  const link = await insertLink();
  prepared = { linkId: link.id, code: link.code };
}

function state() {
  if (prepared === undefined) {
    throw new Error('call prepareStorefrontFixtures() in the suite’s beforeAll first');
  }
  return prepared;
}

function linkBody() {
  return {
    title: `Route matrix ${randomUUID().slice(0, 6)}`,
    baseType: 'shop',
    categoryId: null,
    customPath: '',
    highlightProductIds: [],
    banner: { enabled: false, text: '', bgColor: '#B85C3A', textColor: '#FFFFFF', link: '' },
    modal: {
      enabled: false,
      type: 'text',
      title: '',
      text: '',
      imageFileId: null,
      ctaText: '',
      ctaLink: '',
    },
    isActive: true,
  };
}

export const WEB_MARKETING_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/storefront/campaign-links': () => ({ url: '/v1/storefront/campaign-links' }),
  'GET /v1/storefront/campaign-links/:id': () => ({
    url: `/v1/storefront/campaign-links/${state().linkId}`,
  }),
  'POST /v1/storefront/campaign-links': () => ({
    url: '/v1/storefront/campaign-links',
    body: linkBody(),
  }),
  'PUT /v1/storefront/campaign-links/:id': () => ({
    url: `/v1/storefront/campaign-links/${state().linkId}`,
    body: linkBody(),
  }),
  'DELETE /v1/storefront/campaign-links/:id': async () => ({
    url: `/v1/storefront/campaign-links/${(await insertLink()).id}`,
  }),
  'GET /v1/storefront/tracking': () => ({ url: '/v1/storefront/tracking' }),
  'PUT /v1/storefront/tracking': () => ({
    url: '/v1/storefront/tracking',
    body: {
      meta: {
        pixelEnabled: false,
        capiEnabled: false,
        pixelId: '',
        datasetId: '',
        apiVersion: 'v21.0',
        testEventCode: '',
        defaultCountryCode: '880',
      },
      ga4: { clientEnabled: false, mpEnabled: false, measurementId: '' },
      proxy: {
        metaScriptPath: '/e1/s.js',
        metaCollectPath: '/e1/t',
        ga4ScriptPath: '/e2/s.js',
        ga4CollectPath: '/e2',
      },
      testMode: false,
      events: [],
      logRetentionDays: 30,
    },
  }),
  'GET /v1/storefront/tracking/events': () => ({ url: '/v1/storefront/tracking/events' }),
};

/** The signed reads (the cost sweep, as the website). */
export const WEB_MARKETING_PUBLIC_FIXTURES: Readonly<Record<string, () => string>> = {
  'GET /storefront/v1/custom-links/:code': () => `/storefront/v1/custom-links/${state().code}`,
  'GET /storefront/v1/tracking/config': () => '/storefront/v1/tracking/config',
};

/** The signed writes. */
export const WEB_MARKETING_PUBLIC_WRITE_FIXTURES: Readonly<
  Record<string, () => { readonly method: 'POST'; readonly path: string; readonly body: unknown }>
> = {
  'POST /storefront/v1/custom-links/:code/views': () => ({
    method: 'POST',
    path: `/storefront/v1/custom-links/${state().code}/views`,
    body: {},
  }),
  'POST /storefront/v1/events': () => ({
    method: 'POST',
    path: '/storefront/v1/events',
    body: { events: [{ eventName: 'PageView', eventId: `sweep_${randomUUID()}` }] },
  }),
};
