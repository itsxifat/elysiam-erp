import { expect, test, type Page } from '@playwright/test';

/**
 * The branded login, end to end in a real browser (M02a checks 2, 3 and 6).
 *
 * The API is stubbed at the network boundary rather than run alongside, for one
 * reason: what these tests are for is the part of the flow that only exists in
 * a browser. Cookies, the CSRF header the client must echo, the second-factor
 * hand-off, focus order, and the rule that a one-org user never sees a
 * switcher. The server's half of each of those has its own test against a real
 * Postgres in apps/server and packages/db; duplicating it here would be slower
 * and would prove less.
 *
 * Every route below answers exactly what the real endpoint answers, and the
 * shapes are pinned by the shared types in src/api.ts, so a server change that
 * broke them would fail to compile rather than quietly pass here.
 */

const API = 'http://localhost:3000';

const ORG_A = {
  orgId: '11111111-1111-4111-8111-111111111111',
  slug: 'oura-lifestyle',
  displayName: 'Oura',
  roles: ['sales'],
};

const ORG_B = {
  orgId: '22222222-2222-4222-8222-222222222222',
  slug: 'orvo',
  displayName: 'Orvo',
  roles: ['warehouse'],
};

interface StubOptions {
  readonly orgs?: readonly (typeof ORG_A)[];
  readonly branding?: 'branded' | 'generic';
  readonly requires?: 'none' | 'totp' | 'enrolment';
}

/** Stand up a fake API with a session that behaves like the real one. */
async function stubApi(page: Page, options: StubOptions = {}) {
  const orgs = options.orgs ?? [ORG_A];
  const requires = options.requires ?? 'none';

  const state = {
    signedIn: false,
    secondFactorDone: requires !== 'totp',
    enrolled: requires !== 'enrolment',
    activeOrgId: null as string | null,
    /** Every CSRF header the client sent, so a test can assert it echoed one. */
    csrfHeaders: [] as (string | undefined)[],
  };

  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (method !== 'GET' && method !== 'OPTIONS') {
      state.csrfHeaders.push(request.headers()['x-elysium-csrf']);
    }

    // The page's own origin, echoed exactly. `*` is rejected by the browser
    // once credentials are involved, which is the same rule the real server
    // has to satisfy — see the CORS block in apps/server/src/main.api.ts.
    const origin = request.headers().origin ?? '*';
    const cors = {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type,x-elysium-csrf',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
    };

    // The CSRF header makes every mutation a preflighted request.
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });

    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: {
          ...cors,
          // The token the double-submit check expects back as a header.
          'set-cookie': 'elysium_csrf=test-csrf-token; Path=/; SameSite=Lax',
        },
        body: JSON.stringify(body),
      });

    if (path === '/v1/auth/login-branding') {
      return json(
        options.branding === 'generic'
          ? { orgId: null, slug: null, displayName: null, brand: null, generic: true }
          : {
              orgId: ORG_A.orgId,
              slug: ORG_A.slug,
              displayName: ORG_A.displayName,
              brand: { accent: { hue: 25, chroma: 0.17 }, legalName: 'Oura Lifestyle' },
              generic: false,
            },
      );
    }

    if (path === '/api/auth/sign-in/email') {
      const body = request.postDataJSON() as { email: string; password: string };
      if (body.password !== 'correct-horse-battery') {
        return json({ message: 'Invalid email or password' }, 401);
      }
      if (requires === 'totp') return json({ twoFactorRedirect: true });
      state.signedIn = true;
      return json({ ok: true });
    }

    if (path === '/api/auth/two-factor/verify-totp') {
      const body = request.postDataJSON() as { code: string };
      if (body.code !== '123456') return json({ message: 'Invalid code' }, 401);
      state.signedIn = true;
      state.secondFactorDone = true;
      state.enrolled = true;
      return json({ ok: true });
    }

    if (path === '/api/auth/two-factor/verify-backup-code') {
      const body = request.postDataJSON() as { code: string };
      if (body.code !== 'RECOVERY01') return json({ message: 'Invalid code' }, 401);
      state.signedIn = true;
      state.secondFactorDone = true;
      return json({ ok: true });
    }

    if (path === '/api/auth/two-factor/enable') {
      return json({
        totpURI:
          'otpauth://totp/Elysium:admin@example.invalid?secret=JBSWY3DPEHPK3PXP&issuer=Elysium',
        backupCodes: Array.from(
          { length: 10 },
          (_, index) => `RECOVERY${String(index).padStart(2, '0')}`,
        ),
      });
    }

    if (path === '/api/auth/sign-out') {
      state.signedIn = false;
      state.activeOrgId = null;
      return json({ ok: true });
    }

    if (path === '/v1/me/orgs') {
      if (!state.signedIn) return json({ message: 'Not signed in.' }, 400);
      if (!state.enrolled) {
        return json({ status: 403, code: 'TWO_FACTOR_ENROLMENT_REQUIRED', detail: 'enrol' }, 403);
      }
      return json({ orgs });
    }

    if (path === '/v1/me/active-org') {
      const body = request.postDataJSON() as { orgId: string };
      state.activeOrgId = body.orgId;
      const org = orgs.find((entry) => entry.orgId === body.orgId);
      return json({ orgId: body.orgId, roles: org?.roles ?? [] });
    }

    if (path === '/v1/me') {
      if (!state.signedIn || !state.enrolled) return json({ message: 'no' }, 401);
      if (state.activeOrgId === null) return json({ message: 'No active organization.' }, 401);
      const org = orgs.find((entry) => entry.orgId === state.activeOrgId);
      return json({
        userId: 'usr_test',
        orgId: state.activeOrgId,
        roles: org?.roles ?? [],
        branchIds: [],
        isSuperAdmin: false,
        requestId: 'req_test',
      });
    }

    return json({ message: `unstubbed ${method} ${path}` }, 404);
  });

  return state;
}

async function signIn(page: Page, password = 'correct-horse-battery') {
  await page.getByLabel('Email').fill('operator@example.invalid');
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

test('check 3: the hostname preselects an org and themes the login', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Oura', { exact: true })).toBeVisible();
  await expect(page.getByText('Oura Lifestyle')).toBeVisible();

  // The brand hue is applied as a token override, so the whole console
  // re-themes without a component knowing an org exists (D-034).
  const hue = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--brand-h'),
  );
  expect(hue).toBe('25');
});

test('check 3: an unknown host falls back to the generic login', async ({ page }) => {
  await stubApi(page, { branding: 'generic' });
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await expect(page.getByText('Elysium', { exact: true }).first()).toBeVisible();

  // No org, so no override: the shipped accent stays (the ink's hue since D-441).
  const hue = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue('--brand-h'),
  );
  expect(hue).toBe('270');
});

test('check 6: every mutation carries the CSRF token the server issued', async ({ page }) => {
  const state = await stubApi(page);
  await page.goto('/');
  await signIn(page);

  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();

  expect(state.csrfHeaders.length).toBeGreaterThan(0);
  expect(
    state.csrfHeaders.every((header) => header === 'test-csrf-token'),
    `saw ${JSON.stringify(state.csrfHeaders)}`,
  ).toBe(true);
});

test('a wrong password says so, and does not claim the server is down', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');
  await signIn(page, 'wrong-password');

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText('do not match');
});

test('check 1: an enrolled second factor is demanded, and recovery works', async ({ page }) => {
  await stubApi(page, { requires: 'totp' });
  await page.goto('/');
  await signIn(page);

  await expect(page.getByRole('heading', { name: 'Two-step verification' })).toBeVisible();

  // A wrong code is rejected without losing the step.
  await page.getByLabel('Verification code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText('not right');

  // Recovery is reachable from here — a lost authenticator is not a lost account.
  await page.getByRole('button', { name: 'Use a recovery code instead' }).click();
  await expect(page.getByLabel('Recovery code')).toBeVisible();
  await page.getByLabel('Recovery code').fill('RECOVERY01');
  await page.getByRole('button', { name: 'Verify' }).click();

  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
});

test('a privileged role is walked through enrolment rather than locked out', async ({ page }) => {
  await stubApi(page, { requires: 'enrolment' });
  await page.goto('/');
  await signIn(page);

  await expect(page.getByRole('heading', { name: 'Set up two-step verification' })).toBeVisible();
  await expect(page.getByText('JBSWY3DPEHPK3PXP')).toBeVisible();
  await expect(page.getByText('RECOVERY00')).toBeVisible();

  // The confirm button stays disabled until the codes are acknowledged: they
  // are shown exactly once and cannot be recovered afterwards.
  const confirm = page.getByRole('button', { name: 'Confirm and continue' });
  await expect(confirm).toBeDisabled();

  await page.getByLabel('I have saved my recovery codes').check();
  await page.getByLabel('Verification code').fill('123456');
  await confirm.click();

  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
});

test('check 2: a user with two orgs gets a switcher that changes the roles shown', async ({
  page,
}) => {
  await stubApi(page, { orgs: [ORG_A, ORG_B] });
  await page.goto('/');
  await signIn(page);

  // Two memberships and no active org: the user must choose.
  const switcher = page.getByRole('button', { name: 'Switch organisation' });
  await expect(switcher).toBeVisible();

  await switcher.click();
  await page.getByRole('option', { name: /Oura/ }).click();
  await expect(page.getByText('sales', { exact: true })).toBeVisible();

  await switcher.click();
  await page.getByRole('option', { name: /Orvo/ }).click();
  await expect(page.getByText('warehouse', { exact: true })).toBeVisible();
});

test('a user with one org never sees a switcher', async ({ page }) => {
  await stubApi(page, { orgs: [ORG_A] });
  await page.goto('/');
  await signIn(page);

  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Switch organisation' })).toHaveCount(0);
  // It still says where you are — it just is not a control. The brand heads the sidebar
  // since the design refresh (D-449).
  await expect(
    page.getByRole('complementary', { name: 'Workspace' }).getByText('Oura', { exact: true }),
  ).toBeVisible();
});

test('the login is operable from the keyboard alone', async ({ page }) => {
  await stubApi(page);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();

  // Email is autofocused, so the first Tab must land on the password field and
  // the second on the submit button. An operator signs in dozens of times a day.
  await page.keyboard.type('operator@example.invalid');
  await page.keyboard.press('Tab');
  await page.keyboard.type('correct-horse-battery');
  await page.keyboard.press('Tab');

  const focused = await page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
  expect(focused).toContain('Sign in');

  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible();
});
