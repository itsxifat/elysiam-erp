import { withSystem } from '@elysium/db';
import { sql } from 'drizzle-orm';

import { ORG_A } from '../../testing/http-harness.js';

/**
 * The route-matrix suite's calls for M18's marketing routes.
 *
 * Every fixture is a thunk, evaluated once per role; the suite's question is which roles
 * the guard admits. Writes are chosen to be repeatable by every admitted role:
 *
 * - creating a campaign or a lead makes a new row each time;
 * - `PUT /v1/marketing/spend` replaces one day's figure;
 * - a ref is idempotent for the campaign it already names;
 * - `PUT /v1/marketing/meta-connection` saves a switch that turns **nothing on**: a brand
 *   with conversions on enqueues a job on every delivery, and this harness runs no job
 *   runtime, so later suites' deliveries would 500;
 * - `POST /v1/marketing/meta/import` answers 409 for every admitted role, because ORG_A
 *   has no Meta link — an import that queued would need the job runtime this harness does
 *   not start. A 409 is not a guard refusal, which is all the suite asks.
 *
 * The phone is a test value, not anybody's (invariant 10).
 */

interface Call {
  readonly url: string;
  readonly body?: unknown;
}

const CAMPAIGN_ID = '0e180000-0000-4000-8000-00000000c001';
const REF_ID = '0e180000-0000-4000-8000-00000000f001';
const LEAD_ID = '0e180000-0000-4000-8000-00000000a001';

/** One campaign, one ref and one lead in ORG_A for the routes that name an id. */
export async function prepareMarketingFixtures(): Promise<void> {
  await withSystem(
    async (tx) => {
      await tx.execute(sql`
        insert into marketing.campaigns (id, org_id, name, platform, created_by)
        values (${CAMPAIGN_ID}, ${ORG_A}, 'Route matrix', 'meta', 'usr_route_matrix')
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into marketing.campaign_refs (id, org_id, campaign_id, kind, value, created_by)
        values (${REF_ID}, ${ORG_A}, ${CAMPAIGN_ID}, 'utm_campaign', 'route-matrix',
                'usr_route_matrix')
        on conflict do nothing
      `);
      await tx.execute(sql`
        insert into marketing.leads (id, org_id, phone_e164, channel, created_by)
        values (${LEAD_ID}, ${ORG_A}, '+8801700000098', 'facebook', 'usr_route_matrix')
        on conflict do nothing
      `);
    },
    { orgId: ORG_A },
  );
}

let leadSeq = 0;

export const MARKETING_ROUTE_FIXTURES: Readonly<Record<string, () => Promise<Call> | Call>> = {
  'GET /v1/marketing/campaigns': () => ({ url: '/v1/marketing/campaigns' }),
  'POST /v1/marketing/campaigns': () => ({
    url: '/v1/marketing/campaigns',
    body: { name: 'Matrix probe', platform: 'other' },
  }),
  'PATCH /v1/marketing/campaigns/:id': () => ({
    url: `/v1/marketing/campaigns/${CAMPAIGN_ID}`,
    body: { name: 'Route matrix' },
  }),
  'POST /v1/marketing/campaigns/:id/refs': () => ({
    url: `/v1/marketing/campaigns/${CAMPAIGN_ID}/refs`,
    body: { kind: 'utm_campaign', value: 'route-matrix-probe' },
  }),
  // The ref may already be gone after the first admitted role; removing it again is a no-op.
  'DELETE /v1/marketing/campaigns/:id/refs/:refId': () => ({
    url: `/v1/marketing/campaigns/${CAMPAIGN_ID}/refs/${REF_ID}`,
  }),
  'GET /v1/marketing/spend': () => ({ url: '/v1/marketing/spend?from=2026-09-01&to=2026-09-30' }),
  'GET /v1/marketing/spend/campaigns': () => ({ url: '/v1/marketing/spend/campaigns' }),
  'PUT /v1/marketing/spend': () => ({
    url: '/v1/marketing/spend',
    body: { campaignId: CAMPAIGN_ID, spendDate: '2026-09-15', amountPoisha: '125000' },
  }),
  'POST /v1/marketing/meta/import': () => ({
    url: '/v1/marketing/meta/import',
    body: { from: '2026-09-01', to: '2026-09-03' },
  }),
  'GET /v1/marketing/meta-connection': () => ({ url: '/v1/marketing/meta-connection' }),
  'PUT /v1/marketing/meta-connection': () => ({
    url: '/v1/marketing/meta-connection',
    body: { sendNameAndCity: false },
  }),
  'GET /v1/marketing/capi-events': () => ({ url: '/v1/marketing/capi-events' }),
  'GET /v1/marketing/dashboard': () => ({
    url: '/v1/marketing/dashboard?from=2026-09-01&to=2026-09-30',
  }),
  'GET /v1/marketing/leads': () => ({ url: '/v1/marketing/leads' }),
  'GET /v1/marketing/leads/segments': () => ({
    url: '/v1/marketing/leads/segments?dimension=age_band',
  }),
  'POST /v1/marketing/leads': () => {
    leadSeq += 1;
    return {
      url: '/v1/marketing/leads',
      body: {
        phone: `0170000${String(1000 + leadSeq).slice(-4)}`,
        channel: 'whatsapp',
        ageBand: '25_34',
      },
    };
  },
  'PATCH /v1/marketing/leads/:id': () => ({
    url: `/v1/marketing/leads/${LEAD_ID}`,
    body: { status: 'contacted' },
  }),
};

export const MARKETING_ROUTE_KEYS: readonly string[] = Object.keys(MARKETING_ROUTE_FIXTURES);
