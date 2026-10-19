import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';

import { enrolSecondFactor, signIn, stack, user } from './stack/helpers.js';

/**
 * The unified inbox against the real stack (M42): the brand's admin connects the channels in
 * Settings → Inbox; signed fake webhooks for Messenger, Instagram and WhatsApp open conversations
 * (a bad signature is refused, a repeat ignored); an agent takes one, saves the phone the
 * customer typed and sees that customer's orders, replies through the worker's job, writes a
 * note, adds a product they asked about, and opens the order desk from the chat; a second agent
 * acts in it only after acknowledging the owner, who is told live; a conversation past its
 * 24-hour window refuses free text with the reason; Fraud shows red in the inbox and on the
 * desk. Each screen is checked with axe in both themes and photographed for review.
 *
 * The API runs the fake Meta gateway (the default): replies are recorded as sent and nothing
 * reaches Meta.
 */

test.describe.configure({ mode: 'serial' });

const REVIEW_DIR = path.resolve(import.meta.dirname, '../../../docs/review/M42');
const APP_SECRET = `e2e-app-secret-${randomUUID()}`;
const VERIFY_TOKEN = `e2e-verify-token-${randomUUID()}`;
const PAGE_ID = '104500000000001';
const IG_ID = '17841400000000009';
const PHONE_ID = '106500000000001';
const PSID = '7000000000000001';
const OLD_PSID = '7000000000000009';
const IGSID = '5400000000000001';
const WA_ID = '8801812345670';

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(REVIEW_DIR, { recursive: true });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(REVIEW_DIR, `${name}.png`), fullPage: true });
}

async function noBlockingViolations(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = result.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) => ({ page: label, id: violation.id, help: violation.help }));
  expect(blocking).toEqual([]);
}

async function bothThemes(page: Page, name: string): Promise<void> {
  await noBlockingViolations(page, `${name} (light)`);
  await shot(page, `${name}-light`);
  await page.evaluate(() => localStorage.setItem('erp-theme', 'dark'));
  await page.reload();
  await page.waitForLoadState('networkidle');
  await noBlockingViolations(page, `${name} (dark)`);
  await shot(page, `${name}-dark`);
  await page.evaluate(() => localStorage.setItem('erp-theme', 'light'));
  await page.reload();
  await page.waitForLoadState('networkidle');
}

async function freshPage(browser: Browser): Promise<Page> {
  return (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
}

/** Post a body to the brand's webhook, signed as Meta signs it unless told otherwise. */
async function deliver(body: unknown, secret: string = APP_SECRET): Promise<Response> {
  const raw = JSON.stringify(body);
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  return fetch(`${stack().apiUrl}/webhooks/meta/${stack().orgId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
}

function messenger(psid: string, text: string, timestamp = Date.now()) {
  return {
    object: 'page',
    entry: [
      {
        id: PAGE_ID,
        time: timestamp,
        messaging: [
          {
            sender: { id: psid },
            recipient: { id: PAGE_ID },
            timestamp,
            message: { mid: `m_${randomUUID()}`, text },
          },
        ],
      },
    ],
  };
}

/** `+8801712345678` → `01712345678`. */
const national = (e164: string) => `0${e164.slice(4)}`;
/** `+8801712345678` → `01712-345678`, as the panel shows it. */
const shown = (e164: string) => `${national(e164).slice(0, 5)}-${national(e164).slice(5)}`;

test('the brand’s admin connects Messenger, Instagram and WhatsApp in Settings → Inbox', async ({
  browser,
}) => {
  const page = await freshPage(browser);
  await signIn(page, user('inboxadmin').email);
  await enrolSecondFactor(page);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await page.goto('/settings/inbox');
  await expect(page.getByText('Callback URL for Meta’s webhooks')).toBeVisible();
  await expect(page.getByText(`/webhooks/meta/${stack().orgId}`)).toBeVisible();

  const app = page.getByRole('form', { name: 'Meta app' });
  await app.getByLabel('App secret').fill(APP_SECRET);
  await app.getByLabel('Verify token').fill(VERIFY_TOKEN);
  await app.getByRole('button', { name: 'Save app' }).click();
  await expect(app.getByText(/^Set · [0-9a-f]{12}$/)).toHaveCount(2);

  for (const [name, id, token] of [
    ['Facebook Page (Messenger)', PAGE_ID, 'EAAB-e2e-page-access-token-0000'],
    ['Instagram', IG_ID, null],
    ['WhatsApp', PHONE_ID, 'EAAG-e2e-cloud-api-token-00000'],
  ] as const) {
    const form = page.getByRole('form', { name });
    await form.locator('input[inputmode="numeric"]').fill(id);
    if (token !== null) await form.getByLabel('Access token').fill(token);
    // A channel not set up yet starts switched on.
    await expect(form.getByRole('checkbox', { name: 'On' })).toBeChecked();
    await form.getByRole('button', { name: 'Save channel' }).click();
    await expect(form.getByText('Saved')).toBeVisible();
  }
  // Nothing typed is shown again: only that it is set.
  await page.reload();
  await expect(page.getByText(APP_SECRET)).toHaveCount(0);
  await expect(page.locator('input[type="password"]').first()).toHaveValue('');
  await bothThemes(page, 'a-settings-inbox');

  // Meta's subscription check, with the token just saved.
  const challenge = await fetch(
    `${stack().apiUrl}/webhooks/meta/${stack().orgId}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(VERIFY_TOKEN)}&hub.challenge=1158201444`,
  );
  expect(challenge.status).toBe(200);
  expect(await challenge.text()).toBe('1158201444');
  await page.context().close();
});

test('signed webhooks open conversations on each channel; a bad signature is refused; a repeat is ignored', async () => {
  const phone = stack().lapsedBuyer.phone;
  const first = messenger(PSID, `Amar number ${national(phone)}. Black kurti ache?`);
  for (const body of [
    first,
    {
      object: 'instagram',
      entry: [
        {
          id: IG_ID,
          time: Date.now(),
          messaging: [
            {
              sender: { id: IGSID },
              recipient: { id: IG_ID },
              timestamp: Date.now(),
              message: { mid: `aWdf_${randomUUID()}`, text: 'Is it available in M?' },
            },
          ],
        },
      ],
    },
    {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: '102290129340398',
          changes: [
            {
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15550783881', phone_number_id: PHONE_ID },
                contacts: [{ profile: { name: 'Rumana Akter' }, wa_id: WA_ID }],
                messages: [
                  {
                    from: WA_ID,
                    id: `wamid.${randomUUID()}`,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'text',
                    text: { body: 'Price koto?' },
                  },
                ],
              },
              field: 'messages',
            },
          ],
        },
      ],
    },
    messenger(OLD_PSID, 'Asked two days ago', Date.now() - 25 * 60 * 60 * 1000),
  ]) {
    const response = await deliver(body);
    expect(response.status).toBe(200);
  }
  const forged = await deliver(messenger(PSID, 'forged'), 'not-the-brands-app-secret-000');
  expect(forged.status).toBe(401);
  const again = await deliver(first);
  expect(again.status).toBe(200);
  expect(((await again.json()) as { duplicate: boolean }).duplicate).toBe(true);
});

let messengerUrl = '';

test('an agent takes a conversation, saves the phone, sees the customer’s orders, replies, notes and adds a product', async ({
  browser,
}) => {
  const page = await freshPage(browser);
  await signIn(page, user('agent').email);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  // The sidebar has the inbox for a sales role (`read Conversation`).
  await expect(page.getByRole('link', { name: 'Inbox', exact: true }).first()).toBeVisible();
  await page.goto('/inbox');
  const list = page.getByRole('list', { name: 'Conversations' });
  await expect(list.getByRole('button', { name: /Black kurti ache/ })).toBeVisible({
    timeout: 30_000,
  });
  await expect(list.getByRole('button', { name: /Rumana Akter/ })).toBeVisible();
  await expect(list.getByRole('button', { name: /available in M/ })).toBeVisible();
  await bothThemes(page, 'b-inbox-list');

  await list.getByRole('button', { name: /Black kurti ache/ }).click();
  await expect(page).toHaveURL(/c=/);
  messengerUrl = page.url();
  const thread = page.getByRole('list', { name: 'Messages' });
  await expect(thread.getByText(/Black kurti ache/)).toBeVisible();

  // The phone the customer typed, offered and saved in one click; it is the lapsed buyer's.
  const phone = stack().lapsedBuyer.phone;
  await page.getByRole('button', { name: `Save ${shown(phone)}` }).click();
  // M49: the linked buyer's card, in the panel's Customer tab.
  const panel = page.getByRole('complementary', { name: 'Customer' });
  await expect(panel.getByText('Lapsed Buyer', { exact: true })).toBeVisible();
  await expect(panel.getByRole('heading', { name: /Recent orders/ })).toBeVisible();
  await expect(panel.getByRole('heading', { name: /Numbers/ })).toBeVisible();
  // A chat Meta gave no name takes the linked buyer's (D-892).
  await expect(list.getByRole('button', { name: /Lapsed Buyer/ })).toBeVisible();

  await page.getByRole('button', { name: 'Take', exact: true }).click();
  await expect(page.getByText('You have this conversation')).toBeVisible();

  await page.getByLabel('Reply').fill('Ji, black kurti available in M.');
  await page.getByLabel('Reply').press('Enter');
  await expect(thread.getByText('Ji, black kurti available in M.')).toBeVisible();
  await expect(thread.getByText('Sent', { exact: true })).toBeVisible({ timeout: 30_000 });

  await bothThemes(page, 'c1-customer-card');

  await page.getByRole('tab', { name: /Notes/ }).click();
  await page
    .getByLabel('What we talked about today')
    .fill('Wants the black kurti in M; call after 6 pm.');
  await page.getByRole('button', { name: 'Add note' }).click();
  await expect(page.getByText('Wants the black kurti in M; call after 6 pm.')).toBeVisible();

  await page.getByRole('tab', { name: /Order/ }).click();
  await page.getByLabel('Find a product they like').fill(stack().productName);
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  await expect(page.getByText(stack().productName, { exact: true })).toBeVisible();
  await expect(page.getByText(/in stock/).first()).toBeVisible();
  await bothThemes(page, 'c-conversation');

  // The order desk opens on the chat's phone (the screenshots reloaded the page: Order again).
  await page.getByRole('tab', { name: /Order/ }).click();
  await page.getByRole('link', { name: 'Open in the order desk' }).click();
  await expect(page).toHaveURL(/\/orders\/new\?conversation=/);
  await expect(page.getByText('Filled in from the chat')).toBeVisible();
  await expect(page.getByLabel('Phone', { exact: false }).first()).toHaveValue(national(phone));
  await shot(page, 'd-order-desk-from-chat');
  await page.context().close();
});

test('another agent acts in it only after acknowledging the owner, who is told live', async ({
  browser,
}) => {
  const owner = await freshPage(browser);
  await signIn(owner, user('agent').email);
  await expect(owner.getByRole('button', { name: 'Account' })).toBeVisible();
  await owner.goto(messengerUrl.replace(/^https?:\/\/[^/]+/, ''));
  await expect(owner.getByText('You have this conversation')).toBeVisible();
  await expect(owner.getByText('Live', { exact: true })).toBeVisible({ timeout: 30_000 });

  const other = await freshPage(browser);
  await signIn(other, user('agent2').email);
  await expect(other.getByRole('button', { name: 'Account' })).toBeVisible();
  await other.goto(messengerUrl.replace(/^https?:\/\/[^/]+/, ''));
  await expect(other.getByText(/E2E agent agent has this conversation/)).toBeVisible();
  await other.getByRole('tab', { name: /Notes/ }).click();
  await other.getByLabel('What we talked about today').fill('Covering while they are at lunch.');
  await other.getByRole('button', { name: 'Add note' }).click();
  const dialog = other.getByRole('dialog', { name: /This conversation is .*’s/ });
  await expect(dialog).toBeVisible();
  await noBlockingViolations(other, 'acknowledge the owner');
  await shot(other, 'e-acknowledge-owner');
  await dialog.getByRole('button', { name: 'Act anyway' }).click();
  await expect(other.getByText('Covering while they are at lunch.')).toBeVisible();

  await expect(owner.getByText(/acted in your conversation/)).toBeVisible({ timeout: 30_000 });
  await shot(owner, 'f-owner-told');
  await owner.context().close();
  await other.context().close();
});

test('free text outside the 24-hour window is refused, with the reason', async ({ browser }) => {
  const page = await freshPage(browser);
  await signIn(page, user('agent').email);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await page.goto('/inbox');
  await page
    .getByRole('list', { name: 'Conversations' })
    .getByRole('button', { name: /Asked two days ago/ })
    .click();
  await expect(page.getByText(/The 24-hour reply window closed at/)).toBeVisible();
  await expect(page.getByLabel('Reply')).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send' })).toBeDisabled();
  await bothThemes(page, 'g-window-closed');
  await page.context().close();
});

test('Fraud shows red in the inbox and on the order desk for that phone', async ({ browser }) => {
  const page = await freshPage(browser);
  await signIn(page, user('agent').email);
  await expect(page.getByRole('button', { name: 'Account' })).toBeVisible();
  await page.goto('/inbox');
  await page
    .getByRole('list', { name: 'Conversations' })
    .getByRole('button', { name: /Rumana Akter/ })
    .click();
  // The WhatsApp id is the customer's number: offered, and saved in one click.
  const phone = `+${WA_ID}`;
  await page.getByRole('button', { name: `Save ${shown(phone)}` }).click();
  await expect(page.getByText('Saved', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: /^Stage:/ }).click();
  await page.getByRole('menuitem', { name: 'Fraud' }).click();
  await expect(
    page.getByText('Marked as fraud. Check before taking an order or sending anything.'),
  ).toBeVisible();
  await bothThemes(page, 'h-fraud');

  await page.goto('/orders/new');
  await page.getByLabel('Phone', { exact: false }).first().fill(national(phone));
  await expect(page.getByText('This phone is marked as fraud in the inbox')).toBeVisible();
  await shot(page, 'i-order-desk-fraud');
  await page.context().close();
});
