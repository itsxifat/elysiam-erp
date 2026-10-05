import { SEED_ORGS, seedOrgId, TRAINING_ORG_SLUG, trainingOrgId } from '@elysium/db';

import {
  ensureCash,
  ensureInvestors,
  ensureLoan,
  ensurePayroll,
  ensurePeople,
  ensureTargets,
  ensureTill,
  shareProfit,
} from './back-office.js';
import { Context } from './context.js';
import type { People } from './people.js';
import { runSales } from './sales.js';
import {
  ensureCatalog,
  ensureCourierAccount,
  ensureLocations,
  ensureShowroomStock,
  ensureSupply,
  ensureWallets,
  loadAccounts,
  prepareBranches,
} from './setup.js';

/**
 * The preview's demo activity, in the order a brand's first weeks happen (D-380).
 *
 * The brand is the first of the five by default, because the logins are there; the other
 * four keep only the seed's set-up, and the training brand keeps what `pnpm demo:org`
 * imports. `preview:seed --brand <slug>` seeds only that brand and demos it, the way a
 * brand's own ERP is previewed (D-470).
 */

export const DEFAULT_PREVIEW_ORG_SLUG = 'elysium-lifestyle-bd';

export interface PreviewBrand {
  readonly slug: string;
  readonly name: string;
  readonly orgId: string;
}

export function previewBrand(slug: string = DEFAULT_PREVIEW_ORG_SLUG): PreviewBrand {
  const org = SEED_ORGS.find((entry) => entry.slug === slug);
  if (org === undefined) throw new Error(`preview: the seed has no brand "${slug}".`);
  return { slug, name: org.legalName, orgId: seedOrgId(slug) };
}

/** The branch the branch manager's membership is scoped to, needed before the invites. */
export async function prepareScenario(ctx: Context): Promise<Record<string, string>> {
  return prepareBranches(ctx);
}

export async function runScenario(ctx: Context, log: (line: string) => void): Promise<void> {
  const step = async (label: string, work: () => Promise<void>) => {
    log(`  ${label}`);
    await work();
  };
  await step('locations, ledger accounts and wallets', async () => {
    await ensureLocations(ctx);
    await loadAccounts(ctx);
    await ensureWallets(ctx);
  });
  await step('investors and their capital', () => ensureInvestors(ctx));
  await step('cash movements between wallets', () => ensureCash(ctx));
  await step('products, suppliers and purchases', async () => {
    await ensureCatalog(ctx);
    await ensureSupply(ctx);
  });
  await step('showroom stock and the demo courier', async () => {
    await ensureShowroomStock(ctx);
    await ensureCourierAccount(ctx);
  });
  await step('marketing, orders, parcels and COD', () => runSales(ctx));
  await step('employees, attendance and payroll', async () => {
    await ensurePeople(ctx);
    await ensurePayroll(ctx);
  });
  await step('targets and a bonus rule', () => ensureTargets(ctx));
  await step('a day at the showroom till', () => ensureTill(ctx));
  await step('a company loan', () => ensureLoan(ctx));
  await step('last month’s profit share', () => shareProfit(ctx));
  await step('dashboards', async () => {
    await ctx.settle();
    const admin = (await ctx.people.robot('admin')).client;
    await admin.post('/v1/analytics/rollups/refresh', { from: ctx.daysAgo(45), to: ctx.today() });
    const hr = (await ctx.people.as('hr')).client;
    await hr.post('/v1/hr/targets/refresh', {});
    await ctx.settle();
  });
}

export interface BooksCheck {
  readonly brand: string;
  readonly label: string;
  readonly ok: boolean;
  /** What was compared, for the summary. Amounts in poisha. */
  readonly figures: Readonly<Record<string, string>>;
}

/**
 * The books of each brand the preview wrote to, read through the API as an accountant
 * would, and failed on any disagreement (D-380).
 *
 * The trial balance alone cannot fail: the database refuses an unbalanced journal at
 * commit (0014). What can go wrong is a posting to the wrong account or for the wrong
 * amount, so two figures kept outside the ledger are compared with the ledger too: stock
 * on hand at its weighted average cost against 1300 Inventory, and each courier's
 * uncollected cash on delivery against its receivable.
 */
export async function checkBooks(
  people: People,
  today: string,
  options: { readonly training: boolean; readonly brand: PreviewBrand },
): Promise<BooksCheck[]> {
  const root = await people.robot('root');
  const brands = [
    { name: options.brand.name, orgId: options.brand.orgId, demo: true },
    ...(options.training
      ? [{ name: `Training (${TRAINING_ORG_SLUG})`, orgId: trainingOrgId(), demo: false }]
      : []),
  ];
  const checks: BooksCheck[] = [];
  for (const brand of brands) {
    await root.client.post('/v1/me/active-org', { orgId: brand.orgId });
    const balance = await root.client.get<{
      items: { code: string; balancePoisha: string }[];
      totalDebitPoisha: string;
      totalCreditPoisha: string;
      differencePoisha: string;
    }>(`/v1/ledger/trial-balance?asOf=${today}`);
    checks.push({
      brand: brand.name,
      label: 'trial balance',
      ok:
        balance.differencePoisha === '0' && balance.totalDebitPoisha === balance.totalCreditPoisha,
      figures: {
        debits: balance.totalDebitPoisha,
        credits: balance.totalCreditPoisha,
        difference: balance.differencePoisha,
      },
    });
    // The training brand's opening books are M14a's, reconciled by its own report.
    if (!brand.demo) continue;

    const inventoryAccount = balance.items.find((row) => row.code === '1300')?.balancePoisha ?? '0';
    const valuation = await root.client.get<{ stockValuePoisha: string }>(
      '/v1/inventory/valuation',
    );
    checks.push({
      brand: brand.name,
      label: 'stock against 1300 Inventory',
      ok: BigInt(inventoryAccount) === BigInt(valuation.stockValuePoisha),
      figures: { ledger: inventoryAccount, stock: valuation.stockValuePoisha },
    });

    const cod = await root.client.get<{
      couriers: { courierId: string; variancePoisha: string; ledgerOutstandingPoisha: string }[];
    }>(`/v1/courier/reports/cod-reconciliation?asOf=${today}`);
    const off = cod.couriers.filter((row) => BigInt(row.variancePoisha) !== 0n);
    checks.push({
      brand: brand.name,
      label: 'cash on delivery against courier receivables',
      ok: off.length === 0,
      figures: {
        couriers: String(cod.couriers.length),
        disagreeing: String(off.length),
      },
    });
  }
  await root.client.post('/v1/me/active-org', { orgId: options.brand.orgId });
  return checks;
}

export { Context };
