import {
  canReadCost,
  COST_FIELDS,
  findCostFields,
  MEMBERSHIP_ROLES,
  type MembershipRole,
} from '@elysium/contracts';
import { seedAccountId } from '@elysium/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  CATALOG_ROUTE_FIXTURES,
  prepareCatalogFixtures,
} from '../../modules/catalog/catalog.route-fixtures.js';
import {
  COURIER_ROUTE_FIXTURES,
  prepareCourierFixtures,
} from '../../modules/courier/courier.route-fixtures.js';
import {
  FRAUD_ROUTE_FIXTURES,
  prepareFraudFixtures,
} from '../../modules/fraud/fraud.route-fixtures.js';
import { HR_ROUTE_FIXTURES, prepareHrFixtures } from '../../modules/hr/hr.route-fixtures.js';
import {
  INTAKE_ROUTE_FIXTURES,
  prepareIntakeFixtures,
} from '../../modules/intake/intake.route-fixtures.js';
import {
  INVENTORY_ROUTE_FIXTURES,
  prepareInventoryFixtures,
} from '../../modules/inventory/inventory.route-fixtures.js';
import {
  INVESTORS_ROUTE_FIXTURES,
  prepareInvestorFixtures,
} from '../../modules/investors/investors.route-fixtures.js';
import {
  ORDERS_ROUTE_FIXTURES,
  prepareOrderFixtures,
} from '../../modules/orders/orders.route-fixtures.js';
import {
  prepareSupplyFixtures,
  SUPPLY_ROUTE_FIXTURES,
} from '../../modules/supply/supply.route-fixtures.js';
import { NOTIFY_ROUTE_FIXTURES } from '../../modules/notify/notify.route-fixtures.js';
import { POS_ROUTE_FIXTURES, preparePosFixtures } from '../../modules/pos/pos.route-fixtures.js';
import {
  PROMO_ROUTE_FIXTURES,
  preparePromoFixtures,
} from '../../modules/promo/promo.route-fixtures.js';
import {
  prepareWalletsFixtures,
  WALLETS_ROUTE_FIXTURES,
} from '../../modules/wallets/wallets.route-fixtures.js';
import {
  ORG_A,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { describeRoutes } from './route-map.js';
import { ROUTE_MATRIX_MANIFEST, routeKey } from './route-matrix.manifest.js';

/**
 * Invariant 5 and M09 check 4, swept across the whole API: "roles without `read:cost`
 * never receive cost fields" — from **any** endpoint, not from the ones a module's own
 * suite remembered to check.
 *
 * Each module's suite asserts no cost on its own responses, and that is exactly the
 * arrangement that leaked: this batch sent purchase cost to the order desk through two
 * order-line columns nobody had added to `COST_FIELDS`, with every module suite green,
 * because no suite looked at the order routes as a role without cost. So this one looks at
 * everything. It drives every `GET` in the route-matrix manifest — the list
 * `check-route-matrix` holds equal to the live routes — as every membership role, through
 * the real guard, scope interceptor and serializer, using each module's own route
 * fixtures so a response has real rows in it rather than an empty page. Every JSON body a
 * role without `read:cost` gets back goes through `findCostFields`, which walks the whole
 * structure, so a cost nested in `order.lines[3]` is found as surely as one at the top.
 *
 * Two controls keep it honest:
 *
 * * **Positive.** The same sweep as the roles that *do* hold `read:cost` must find cost
 *   fields. A sweep that never sees one — because the fixtures left every list empty, or
 *   because a refactor made `findCostFields` blind — would pass for every role, so the
 *   suite fails unless the cost roles see cost on the endpoints that carry it.
 * * **Coverage.** Most routes must actually have answered 2xx, with a JSON or text body,
 *   for the roles under test.
 */

let harness: HttpHarness;
const clients = new Map<MembershipRole, RoleClient>();

interface Call {
  readonly url: string;
}
type Fixture = () => Promise<Call> | Call;

const BANK = seedAccountId(ORG_A, '1100');

/**
 * The platform's own GET routes. The route-matrix suite writes these inline rather than
 * in a module file, and that suite is shared by every milestone, so they are repeated
 * here — only the reads, which is all a cost sweep needs.
 */
const PLATFORM_FIXTURES: Readonly<Record<string, Fixture>> = {
  'GET /v1/approvals': () => ({ url: '/v1/approvals' }),
  'GET /v1/approvals/:id': async () => {
    const maker = await harness.asRole('org_admin', ORG_A);
    const created = await maker.client.request('POST', '/v1/approvals', {
      body: { type: 'closing_variance', amountPoisha: '900000' },
    });
    const { id } = JSON.parse(created.body) as { id: string };
    return { url: `/v1/approvals/${id}` };
  },
  'GET /v1/demo/costed-items': () => ({ url: '/v1/demo/costed-items' }),
  'GET /v1/jobs/failed': () => ({ url: '/v1/jobs/failed' }),
  'GET /v1/files/:id/download': async () => {
    const owner = await harness.asRole('org_admin', ORG_A);
    const created = await owner.client.request('POST', '/v1/files', {
      body: { purpose: 'product-image', contentType: 'image/png', sizeBytes: 1024 },
    });
    const { fileId } = JSON.parse(created.body) as { fileId: string };
    return { url: `/v1/files/${fileId}/download` };
  },
  'GET /v1/ledger/accounts': () => ({ url: '/v1/ledger/accounts' }),
  'GET /v1/ledger/accounts/:id/ledger': () => ({
    url: `/v1/ledger/accounts/${BANK}/ledger?to=2030-12-31`,
  }),
  'GET /v1/ledger/day-book': () => ({ url: '/v1/ledger/day-book?from=2026-01-01&to=2030-12-31' }),
  'GET /v1/ledger/party-balances': () => ({ url: '/v1/ledger/party-balances?asOf=2030-12-31' }),
  'GET /v1/ledger/periods': () => ({ url: '/v1/ledger/periods' }),
  'GET /v1/ledger/trial-balance': () => ({ url: '/v1/ledger/trial-balance?asOf=2030-12-31' }),
  'GET /v1/ledger/wallets': () => ({ url: '/v1/ledger/wallets' }),
  'GET /v1/ledger/wallets/:id/cash-book': () => ({
    url: `/v1/ledger/wallets/${BANK}/cash-book?to=2030-12-31`,
  }),
  'GET /v1/me': () => ({ url: '/v1/me' }),
  'GET /v1/me/orgs': () => ({ url: '/v1/me/orgs' }),
};

const FIXTURES: Readonly<Record<string, Fixture>> = {
  ...PLATFORM_FIXTURES,
  ...CATALOG_ROUTE_FIXTURES,
  ...INVENTORY_ROUTE_FIXTURES,
  ...WALLETS_ROUTE_FIXTURES,
  ...ORDERS_ROUTE_FIXTURES,
  ...FRAUD_ROUTE_FIXTURES,
  ...INVESTORS_ROUTE_FIXTURES,
  ...HR_ROUTE_FIXTURES,
  ...COURIER_ROUTE_FIXTURES,
  ...SUPPLY_ROUTE_FIXTURES,
  ...INTAKE_ROUTE_FIXTURES,
  ...POS_ROUTE_FIXTURES,
  ...PROMO_ROUTE_FIXTURES,
  ...NOTIFY_ROUTE_FIXTURES,
};

/**
 * Names that smell of purchase cost but are not in `COST_FIELDS`, and are known not to be.
 *
 * `findCostFields` only knows the names it is given, and the leak this suite exists for was
 * two columns missing from that list. So every key a role without `read:cost` receives is
 * also checked against a pattern, and anything that matches must be either a listed cost
 * field (which `findCostFields` reports) or named here with the reason it is not cost. A new
 * `landedCostPoisha` on some response therefore fails this suite until somebody decides
 * which list it belongs on — which is the decision that was skipped last time.
 */
const COST_LIKE =
  /cost|wac|cogs|margin|stock_?value|gross_?profit|purchase_?price|supplier_?balance/i;
const NOT_COST: Readonly<Record<string, string>> = {
  // A boolean telling the P&L's reader that COGS was withheld (D-085): it carries no amount.
  costWithheld: 'a flag that cost was removed, not a cost',
};

interface Finding {
  readonly role: MembershipRole;
  readonly route: string;
  readonly paths: readonly string[];
}

/**
 * Cost named anywhere in a text body: a CSV export's header row, an HTML document, a
 * JSON string sent as `text/plain`.
 *
 * Exports are where a leak is most likely and least looked at — a buyer list or a stuck-
 * parcel export built from a query that selects `*` carries every column the query found,
 * and no serializer stands between a CSV writer and the download. `findCostFields` only
 * walks parsed JSON, so without this every non-JSON response would be waved through.
 * Binary bodies (a PDF, an image) are skipped; they cannot be searched as text, and the
 * PDF routes render from view models that the JSON routes already cover.
 */
const COST_WORD = new RegExp(`(?<![A-Za-z0-9_])(?:${COST_FIELDS.join('|')})(?![A-Za-z0-9_])`, 'g');
const TEXTUAL = /^(?:text\/|application\/(?:csv|xml|xhtml))/i;

function costInText(body: string): string[] {
  const named = [...body.matchAll(COST_WORD)].map((match) => match[0]);
  // A CSV header whose column names smell of cost but are not listed: the same decision
  // `suspectKeys` forces for JSON keys.
  const header = (body.split(/\r?\n/, 1)[0] ?? '').split(',').map((cell) => cell.trim());
  const smelly = header.filter((cell) => COST_LIKE.test(cell) && NOT_COST[cell] === undefined);
  return [...new Set([...named, ...smelly])];
}

function suspectKeys(input: unknown, path = '$', out: string[] = []): string[] {
  if (Array.isArray(input)) {
    input.forEach((entry, index) => suspectKeys(entry, `${path}[${String(index)}]`, out));
  } else if (input !== null && typeof input === 'object') {
    for (const [key, value] of Object.entries(input)) {
      const listed = (COST_FIELDS as readonly string[]).includes(key);
      if (!listed && COST_LIKE.test(key) && NOT_COST[key] === undefined) {
        out.push(`${path}.${key}`);
      }
      suspectKeys(value, `${path}.${key}`, out);
    }
  }
  return out;
}

beforeAll(async () => {
  harness = await startHttpHarness('cost-sweep');

  await prepareCatalogFixtures();
  await prepareInventoryFixtures();
  await prepareWalletsFixtures();
  await prepareOrderFixtures();
  await prepareFraudFixtures();
  await prepareInvestorFixtures();
  await prepareHrFixtures();
  await prepareCourierFixtures();
  await prepareSupplyFixtures();
  await prepareIntakeFixtures();
  await preparePosFixtures();
  await preparePromoFixtures();

  for (const role of MEMBERSHIP_ROLES) clients.set(role, await harness.asRole(role, ORG_A));

  // A costed row for the demo resource, so its list is not empty for the positive control.
  const admin = clients.get('org_admin');
  const created = await admin?.client.request('POST', '/v1/demo/costed-items', {
    body: { sku: `SWEEP-${String(Date.now())}`, name: 'Cost sweep control' },
  });
  expect(created?.statusCode, created?.body).toBe(201);
}, 420_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

/** Every GET the sweep must cover: the manifest's, plus live ones it does not list yet. */
function sweptRoutes(): string[] {
  const manifest = ROUTE_MATRIX_MANIFEST.filter((key) => key.startsWith('GET '));
  const live = describeRoutes(harness.app)
    .filter((route) => route.method === 'GET' && !route.declared?.startsWith('public:'))
    .map(routeKey);
  return [...new Set([...manifest, ...live])].sort();
}

describe('invariant 5, across every endpoint', () => {
  it('has a fixture for every GET route it sweeps', () => {
    const missing = sweptRoutes().filter((key) => FIXTURES[key] === undefined);
    expect(missing).toEqual([]);
  });

  it('gives no role without read:cost a cost field, and gives the cost roles theirs', async () => {
    const leaks: Finding[] = [];
    const suspects: Finding[] = [];
    const costSeen: Finding[] = [];
    const answered = new Set<string>();
    const routes = sweptRoutes();

    for (const key of routes) {
      const fixture = FIXTURES[key];
      if (fixture === undefined) continue; // reported by the test above
      const method = key.slice(0, key.indexOf(' '));

      for (const role of MEMBERSHIP_ROLES) {
        const actor = clients.get(role);
        if (actor === undefined) throw new Error(`no client for ${role}`);

        const call = await fixture();
        const response = await actor.client.request(method, call.url);
        if (response.statusCode < 200 || response.statusCode >= 300) continue;
        const header = response.headers['content-type'];
        const type = typeof header === 'string' ? header : '';

        if (!type.includes('json')) {
          if (!TEXTUAL.test(type)) continue;
          const named = costInText(response.body);
          if (canReadCost([role], false)) {
            if (named.length > 0) costSeen.push({ role, route: key, paths: named.slice(0, 3) });
          } else {
            answered.add(key);
            if (named.length > 0) leaks.push({ role, route: key, paths: named.slice(0, 5) });
          }
          continue;
        }

        const parsed: unknown = JSON.parse(response.body);
        const found = findCostFields(parsed);

        if (canReadCost([role], false)) {
          if (found.length > 0) costSeen.push({ role, route: key, paths: found.slice(0, 3) });
          continue;
        }

        answered.add(key);
        if (found.length > 0) leaks.push({ role, route: key, paths: found.slice(0, 5) });
        const smells = suspectKeys(parsed);
        if (smells.length > 0) suspects.push({ role, route: key, paths: smells.slice(0, 5) });
      }
    }

    const report = (findings: readonly Finding[]) =>
      findings.map((finding) => `${finding.role} ${finding.route}: ${finding.paths.join(', ')}`);

    expect(report(leaks), 'cost fields reached a role without read:cost').toEqual([]);
    expect(
      report(suspects),
      'cost-like fields that are not in COST_FIELDS — add them there, or to NOT_COST with a reason',
    ).toEqual([]);

    // Positive control: the cost roles see cost where it lives. Without this, a sweep of
    // empty lists — or a `findCostFields` that had stopped recognising anything — passes.
    const costRoutes = new Set(costSeen.map((finding) => finding.route));
    for (const route of [
      'GET /v1/demo/costed-items',
      'GET /v1/inventory/stock',
      'GET /v1/inventory/movements',
    ]) {
      expect(costRoutes, `the cost roles saw no cost on ${route}`).toContain(route);
    }

    // Coverage: most routes answered at least one role without cost, with a body the sweep
    // could read. A sweep of 403s proves the guard, not the serializer.
    expect(
      answered.size,
      `only ${String(answered.size)} of ${String(routes.length)} routes answered a role without cost`,
    ).toBeGreaterThan(routes.length / 2);
  }, 600_000);
});
