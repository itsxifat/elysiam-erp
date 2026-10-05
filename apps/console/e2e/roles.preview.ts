import { expect, test } from '@playwright/test';

import { inConsole, login, look, preview, signIn } from './preview/helpers.js';

/**
 * Every console role the preview hands the owner, signed in from the credentials file,
 * looking at the screens its line in the file promises (D-387). A screen that fails to
 * load, refuses the role, or shows no seeded data fails the run.
 */

const consoleUrl = () => preview().urls.console;

test('super admin: enrols two-step login, chooses a brand, reads its dashboard', async ({
  page,
}) => {
  await signIn(page, consoleUrl(), login('superadmin'));
  // A super admin enters no brand by default: the switcher asks.
  await expect(page.getByText('Choose an organisation to continue.')).toBeVisible();
  await page.getByRole('button', { name: 'Switch organisation' }).click();
  await page.getByRole('option', { name: /Elysium Lifestyle BD/ }).click();
  await inConsole(page);

  // The all-brands views left the brand's ERP with M31 (D-471).
  await look(page, 'superadmin-dashboard', '/analytics', 'Analytics');
  await look(page, 'superadmin-approvals', '/approvals', 'Approvals');
});

test('org admin: overview, dashboard, catalog, approvals', async ({ page }) => {
  await signIn(page, consoleUrl(), login('admin'));
  await inConsole(page);
  await look(page, 'admin-overview', '/', 'Overview');
  await look(page, 'admin-dashboard', '/analytics', 'Analytics');
  await look(page, 'admin-catalog', '/catalog', 'Catalog', /Classic Cotton Tee/);
  await look(page, 'admin-approvals', '/approvals', 'Approvals');
});

test('accounts: wallets, statements, purchases, COD, investors, loans', async ({ page }) => {
  await signIn(page, consoleUrl(), login('accounts'));
  await inConsole(page);
  await look(page, 'accounts-wallets', '/accounts', 'Accounts');
  await look(page, 'accounts-statements', '/accounts/reports', 'Statements');
  await look(page, 'accounts-supply-entries', '/supply/entries', 'Supply entries', /DTM-2026-101/);
  await look(page, 'accounts-cod-settlements', '/courier/settlements', 'Settlements');
  await look(page, 'accounts-investors', '/investors', 'Investors', /Preview Investor/);
  await look(page, 'accounts-loans', '/loans', 'Company loans', /Demo Bank Ltd/);
});

test('sales agent: orders, the order desk, buyers, own target', async ({ page }) => {
  await signIn(page, consoleUrl(), login('sales'));
  await inConsole(page);
  await look(page, 'sales-orders', '/orders', 'Orders', /ELY-\d{4}-\d{5}/);
  await look(page, 'sales-new-order', '/orders/new', 'New order');
  await look(page, 'sales-customers', '/customers', 'Customers', /Demo Buyer/);
  await look(page, 'sales-my-performance', '/performance', 'My performance');
});

test('warehouse: stock, transfers, parcels', async ({ page }) => {
  await signIn(page, consoleUrl(), login('warehouse'));
  await inConsole(page);
  await look(page, 'warehouse-stock', '/stock', 'Stock');
  await look(page, 'warehouse-transfers', '/stock/transfers', 'Transfers');
  await look(page, 'warehouse-parcels', '/courier', 'Parcels');
});

test('branch manager: the branch in the console', async ({ page }) => {
  await signIn(page, consoleUrl(), login('branch'));
  await inConsole(page);
  await look(page, 'branch-branches', '/branches', 'Branches', /Dhanmondi/);
});

test('HR: people, attendance, payroll, targets', async ({ page }) => {
  await signIn(page, consoleUrl(), login('hr'));
  await inConsole(page);
  await look(page, 'hr-people', '/people', 'People', /Demo Staff Rafi/);
  await look(page, 'hr-attendance', '/people/attendance', 'Attendance');
  await look(page, 'hr-payroll', '/payroll', 'Payroll');
  await look(page, 'hr-targets', '/performance/targets', 'Targets');
});

test('marketing: dashboard, promo codes, leads', async ({ page }) => {
  await signIn(page, consoleUrl(), login('marketing'));
  await inConsole(page);
  await look(page, 'marketing-dashboard', '/marketing', 'Marketing');
  await look(page, 'marketing-promo-codes', '/campaigns', 'Promo codes', /EID10/);
  await look(page, 'marketing-leads', '/marketing/leads', 'Leads', /Demo Lead/);
});
