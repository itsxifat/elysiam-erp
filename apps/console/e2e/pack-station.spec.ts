import { mkdirSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

/**
 * The packing and return stations in a real browser (M51, D-930 to D-934).
 *
 * The API is stubbed at the network boundary with a small model of the server's answers
 * (`label-recording.db.test.ts` holds the server's own half on real Postgres). What this proves
 * only exists in a browser: this computer's camera (Chromium's fake one) really records from the
 * label's scan, its `MediaRecorder` really pauses after the idle time with no scan and resumes
 * at the next, each lot registers and uploads its own video, and the screens read right in each
 * state, light and dark. Screenshots go to `docs/review/M51/`.
 */

const API = 'http://localhost:3000';
const ORG = '11111111-1111-4111-8111-111111111111';
const ORDER_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const ORDER_NO = 'ELY-2611-00042';
const SHOTS = '../../docs/review/M51';
/** The brand's shortest idle time, so a test waits three seconds for the pause, not ten. */
const IDLE_MS = 3_000;

const SHIRT = { skuId: '55555555-5555-4555-8555-555555555551', code: '2000000000015' };
const CAP = { skuId: '55555555-5555-4555-8555-555555555552', code: '2000000000022' };
const OTHER_CODE = '2000000000039';

const person = { id: 'usr_test', name: 'Rahim Packer' };

interface Recording {
  id: string;
  lot: number;
  state: 'recording' | 'stopped';
  videoRequired: boolean;
  source: 'browser';
  cameraId: null;
  idleMs: number;
  startedAt: string;
  startedBy: typeof person;
  stoppedAt: string | null;
  stopReason: string | null;
  lastActivityAt: string;
  spans: never[];
  recordedMs: number;
}

interface Calls {
  /** The body of every part registered, in order. */
  readonly registered: { videoId: string; recordingId?: string }[];
  /** The video id of every part whose file was attached. */
  readonly attached: string[];
  readonly received: unknown[];
}

function line(sku: typeof SHIRT, name: string, size: string, qty: number) {
  return {
    skuId: sku.skuId,
    name,
    image: '',
    sku: `SKU-${sku.code.slice(-3)}`,
    barcode: sku.code,
    size,
    color: 'Navy',
    qty,
    done: 0,
  };
}

/** A model of one order at one station: what the server would answer as scans come in. */
function makeModel(kind: 'pack' | 'return', lotCount: number) {
  const lines =
    lotCount > 1
      ? [line(SHIRT, 'Linen shirt', 'M', 1), line(CAP, 'Canvas cap', 'One size', 1)]
      : [line(SHIRT, 'Linen shirt', 'M', 2), line(CAP, 'Canvas cap', 'One size', 1)];
  const recordings: Recording[] = [];
  const scans: Record<string, unknown>[] = [];
  const videos: Record<string, unknown>[] = [];
  const closed: number[] = [];
  let completed = false;
  const pieces = new Map<number, number>();

  const running = () => recordings.find((entry) => entry.state === 'recording');
  const openLot = () => (completed ? null : Math.min(closed.length + 1, lotCount));

  const log = (outcome: string, code: string, lot: number, name: string | null = null) => {
    const at = new Date().toISOString();
    scans.unshift({
      id: crypto.randomUUID(),
      scanId: crypto.randomUUID(),
      code,
      skuId: null,
      sku: null,
      name,
      variant: null,
      outcome,
      at,
      by: person,
      lot,
    });
    const current = running();
    if (current?.lot === lot) current.lastActivityAt = at;
  };
  const start = (lot: number) => {
    const at = new Date().toISOString();
    recordings.push({
      id: `66666666-6666-4666-8666-66666666666${String(lot)}`,
      lot,
      state: 'recording',
      videoRequired: true,
      source: 'browser',
      cameraId: null,
      idleMs: IDLE_MS,
      startedAt: at,
      startedBy: person,
      stoppedAt: null,
      stopReason: null,
      lastActivityAt: at,
      spans: [],
      recordedMs: 0,
    });
  };
  const stop = (lot: number, reason: string) => {
    const recording = recordings.find((entry) => entry.lot === lot);
    if (recording === undefined) return;
    recording.state = 'stopped';
    recording.stoppedAt = new Date().toISOString();
    recording.stopReason = reason;
    recording.recordedMs = 9_000;
  };

  const session = () => ({
    id: SESSION_ID,
    orderId: ORDER_ID,
    orderNo: ORDER_NO,
    status: completed ? 'completed' : 'open',
    videoRequired: true,
    startedAt: new Date().toISOString(),
    startedBy: person,
    completedAt: completed ? new Date().toISOString() : null,
    completedBy: completed ? person : null,
    cameraId: null,
    cameraLocked: recordings.length > 0,
  });
  const order = {
    id: ORDER_ID,
    orderNumber: ORDER_NO,
    status: kind === 'pack' ? 'confirmed' : 'return_in_transit',
    channel: 'website',
    paid: false,
    cod: { poisha: '295000', taka: '2950.00' },
    notes: '',
    courier: 'Steadfast',
    consignmentId: '998877',
    trackingCode: 'SFR123',
    recipient: { name: 'Nusrat Jahan', address: 'House 12, Road 5, Dhanmondi, Dhaka' },
  };
  const lotPieces = () =>
    Array.from({ length: lotCount }, (_, index) => ({
      lot: index + 1,
      pieces: pieces.get(index + 1) ?? 0,
    }));
  const counted = () => lines.reduce((sum, entry) => sum + entry.done, 0);
  const wanted = () => lines.reduce((sum, entry) => sum + entry.qty, 0);
  const stateOf = (entry: { qty: number; done: number }) =>
    entry.done === entry.qty ? 'done' : entry.done === 0 ? 'todo' : 'partial';

  const packView = () => {
    const open = openLot();
    return {
      idlePauseMs: IDLE_MS,
      recordings,
      labelNeeded: open !== null && !recordings.some((entry) => entry.lot === open),
      lots: {
        count: lotCount,
        open,
        started: recordings.map((entry) => entry.lot),
        closed: closed.map((lot) => ({ lot, at: new Date().toISOString(), by: person })),
        pieces: lotPieces(),
      },
      terminal: null,
      cameraIds: [],
      you: person,
      session: { ...session(), recordingFrom: null, recordingTo: null, recordingBy: null },
      order,
      lines: lines.map(({ qty, done, ...entry }) => ({
        ...entry,
        required: qty,
        packed: done,
        state: stateOf({ qty, done }),
      })),
      extra: [],
      progress: {
        unitsRequired: wanted(),
        unitsPacked: counted(),
        complete: counted() === wanted(),
      },
      scans,
      videos,
      video: 'pending',
    };
  };
  const returnView = () => {
    const current = running();
    return {
      kind: 'return',
      idlePauseMs: IDLE_MS,
      recordings,
      labelNeeded: !completed && current === undefined,
      lots: {
        count: lotCount,
        recording: current?.lot ?? null,
        done: recordings.filter((entry) => entry.state === 'stopped').map((entry) => entry.lot),
        pieces: lotPieces(),
      },
      cameraIds: [],
      you: person,
      session: session(),
      order,
      lines: lines.map(({ qty, done, ...entry }) => ({
        ...entry,
        expected: qty,
        back: done,
        state: stateOf({ qty, done }),
      })),
      progress: {
        unitsExpected: wanted(),
        unitsBack: counted(),
        missing: wanted() - counted(),
      },
      scans,
      videos,
      video: 'pending',
    };
  };
  const view = () => (kind === 'pack' ? packView() : returnView());

  /** One scan, answered as the server would, or a status and code for a refusal it throws. */
  const scan = (code: string): { status: number; body: unknown } => {
    const isLabel = code === ORDER_NO || /^ELY-2611-00042-L\d$/.test(code);
    const named = /-L(\d)$/.exec(code)?.[1];
    const lot = named === undefined ? null : Number(named);
    const answer = (extra: Record<string, unknown>) => ({
      status: 200,
      body: {
        skuId: null,
        accepted: false,
        message: null,
        repeated: false,
        label: null,
        ...extra,
        view: view(),
      },
    });
    if (isLabel) {
      const current = running();
      if (kind === 'return') {
        if (current !== undefined) {
          log('label', code, current.lot);
          stop(current.lot, 'label');
          return answer({
            outcome: 'label',
            label: { action: 'stopped', lot: current.lot, message: null },
          });
        }
        const bag =
          lot ??
          Array.from({ length: lotCount }, (_, index) => index + 1).find(
            (entry) => !recordings.some((row) => row.lot === entry),
          ) ??
          1;
        log('label', code, bag);
        start(bag);
        return answer({ outcome: 'label', label: { action: 'started', lot: bag, message: null } });
      }
      const open = openLot() ?? lotCount;
      if (lot !== null && lot !== open) {
        const message = `That is lot ${String(lot)}’s label. Lot ${String(open)} is open: scan its label first.`;
        log('label', code, open);
        return answer({ outcome: 'label', message, label: { action: 'refused', lot, message } });
      }
      log('label', code, open);
      if (current === undefined) {
        start(open);
        return answer({ outcome: 'label', label: { action: 'started', lot: open, message: null } });
      }
      if (open < lotCount) {
        closed.push(open);
        stop(open, 'label');
        return answer({
          outcome: 'label',
          label: { action: 'lot_closed', lot: open, message: null },
        });
      }
      if (counted() < wanted()) {
        const message = `${String(wanted() - counted())} of ${String(wanted())} pieces are still to scan.`;
        return answer({
          outcome: 'label',
          message,
          label: { action: 'refused', lot: open, message },
        });
      }
      closed.push(open);
      stop(open, 'label');
      completed = true;
      return answer({
        outcome: 'label',
        label: { action: 'finished', lot: open, message: null },
      });
    }
    const current = running();
    if (current === undefined) {
      return {
        status: 409,
        body: {
          status: 409,
          code: 'PACKING_LABEL_FIRST',
          detail: 'Scan the parcel label first: it starts the recording.',
          message: 'Scan the parcel label first: it starts the recording.',
        },
      };
    }
    const entry = lines.find((candidate) => candidate.barcode === code);
    if (entry === undefined) {
      log('wrong_item', code, current.lot);
      return answer({
        outcome: 'wrong_item',
        message: 'This product did not go out in this parcel.',
      });
    }
    if (entry.done >= entry.qty) {
      log('over', code, current.lot, entry.name);
      return answer({ outcome: 'over', skuId: entry.skuId });
    }
    entry.done += 1;
    pieces.set(current.lot, (pieces.get(current.lot) ?? 0) + 1);
    log('accepted', code, current.lot, entry.name);
    return answer({ outcome: 'accepted', accepted: true, skuId: entry.skuId });
  };

  return {
    view,
    scan,
    complete: () => {
      completed = true;
    },
  };
}

async function stubApi(page: Page, model: ReturnType<typeof makeModel>): Promise<Calls> {
  const calls: Calls = { registered: [], attached: [], received: [] };
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const { pathname: path } = new URL(request.url());
    const method = request.method();
    const cors = {
      'access-control-allow-origin': request.headers().origin ?? '*',
      'access-control-allow-credentials': 'true',
      'access-control-allow-headers': 'content-type,x-csrf-token,x-terminal-device',
      'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    };
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: 'application/json',
        headers: { ...cors, 'set-cookie': 'erp_csrf=test-csrf-token; Path=/; SameSite=Lax' },
        body: JSON.stringify(body),
      });

    if (path === '/v1/me') {
      return json({
        userId: 'usr_test',
        orgId: ORG,
        roles: ['org_admin'],
        branchIds: [],
        isSuperAdmin: false,
        requestId: 'req_test',
      });
    }
    if (path === '/v1/me/orgs') {
      return json({
        orgs: [{ orgId: ORG, slug: 'demo', displayName: 'Demo', roles: ['org_admin'] }],
      });
    }
    if (path === '/v1/me/active-org') return json({ orgId: ORG, roles: ['org_admin'] });
    if (path === '/v1/team/me') {
      return json({ profile: { workTypes: [], hubLocationId: null }, presence: null });
    }
    if (path === '/v1/packing/settings') {
      return json({ videoEnabled: true, idlePauseSeconds: 3, updatedAt: null, canEdit: true });
    }
    if (path === '/v1/packing/sessions' || path === '/v1/packing/returns') {
      return method === 'POST' ? json(model.view()) : json({ items: [] });
    }
    if (/^\/v1\/packing\/(sessions|returns)\/[^/]+\/scans$/.test(path)) {
      const { code } = request.postDataJSON() as { code: string };
      const answer = model.scan(code);
      return json(answer.body, answer.status);
    }
    if (/^\/v1\/packing\/returns\/[^/]+\/receive$/.test(path)) {
      calls.received.push(request.postDataJSON());
      model.complete();
      return json(model.view());
    }
    if (/^\/v1\/packing\/sessions\/[^/]+\/videos$/.test(path)) {
      calls.registered.push(request.postDataJSON() as Calls['registered'][number]);
      return json({ id: 'part', part: calls.registered.length, state: 'waiting', mayAttach: true });
    }
    const attached = /^\/v1\/packing\/sessions\/[^/]+\/videos\/([^/]+)\/file$/.exec(path);
    if (attached !== null) {
      calls.attached.push(attached[1] ?? '');
      return json({ id: attached[1], part: 1, state: 'uploaded', mayAttach: true });
    }
    if (path === '/v1/files') {
      return json(
        {
          fileId: crypto.randomUUID(),
          url: `${API}/upload-target`,
          method: 'PUT',
          headers: {},
          maxBytes: 90_000_000,
        },
        201,
      );
    }
    if (path === '/upload-target') return route.fulfill({ status: 200, headers: cors, body: '' });
    if (/^\/v1\/files\/[^/]+\/finalize$/.test(path)) return json({ state: 'stored' });
    if (path === '/v1/inventory/locations') {
      return json({
        items: [
          {
            id: 'loc-damaged',
            code: 'DMG',
            name: 'Damaged shelf',
            kind: 'damaged',
            isActive: true,
          },
        ],
      });
    }
    return json({ items: [] });
  });
  return calls;
}

/** Every `MediaRecorder` the page makes, kept where the test can read its state. */
async function watchRecorders(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const Native = window.MediaRecorder;
    const made: MediaRecorder[] = [];
    (window as unknown as { recorders: MediaRecorder[] }).recorders = made;
    class Watched extends Native {
      constructor(stream: MediaStream, options?: MediaRecorderOptions) {
        super(stream, options);
        made.push(this);
      }
    }
    window.MediaRecorder = Watched;
  });
}

const recorderStates = (page: Page) =>
  page.evaluate(() =>
    (window as unknown as { recorders: MediaRecorder[] }).recorders.map((entry) => entry.state),
  );

async function scanCode(page: Page, code: string): Promise<void> {
  const field = page.getByRole('textbox', { name: /^Scan / });
  await field.fill(code);
  await field.press('Enter');
}

async function shoot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    for (const element of document.querySelectorAll('main')) element.scrollTo(0, 0);
  });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.use({
  viewport: { width: 1440, height: 1000 },
  permissions: ['camera'],
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  },
});

test.describe('the packing station', () => {
  test('label, pieces, the pause, the label again', async ({ page }) => {
    const model = makeModel('pack', 1);
    const calls = await stubApi(page, model);
    await watchRecorders(page);
    await page.goto(`/packaging?tab=packing&order=${ORDER_ID}`);

    // The label first: the camera's picture is up, nothing records, a piece is refused.
    const stage = page.getByTestId('pack-stage');
    await expect(stage).toHaveAttribute('data-status', 'label');
    await expect(page.getByTestId('pack-steps').locator('[aria-current="step"]')).toContainText(
      'Scan the label',
    );
    await expect.poll(() => recorderStates(page)).toEqual([]);
    await shoot(page, 'a-pack-scan-the-label');
    await scanCode(page, SHIRT.code);
    await expect(page.getByTestId('pack-answer')).toContainText('Scan the parcel label first');
    await expect.poll(() => recorderStates(page)).toEqual([]);

    // The label starts it, at once, from the open camera.
    await scanCode(page, ORDER_NO);
    await expect(stage).toHaveAttribute('data-status', 'recording');
    await expect.poll(() => recorderStates(page)).toEqual(['recording']);
    await expect.poll(() => calls.registered.length).toBe(1);
    expect(calls.registered[0]?.recordingId).toBe('66666666-6666-4666-8666-666666666661');

    await scanCode(page, SHIRT.code);
    await expect(page.getByTestId('pack-answer')).toContainText('Linen shirt');
    await shoot(page, 'b-pack-recording');

    // No scan for the idle time: paused, the recorder too. The next scan resumes both.
    await expect(stage).toHaveAttribute('data-status', 'paused', { timeout: IDLE_MS + 2_000 });
    await expect.poll(() => recorderStates(page)).toEqual(['paused']);
    await shoot(page, 'c-pack-paused');
    await scanCode(page, SHIRT.code);
    await expect(stage).toHaveAttribute('data-status', 'recording');
    await expect.poll(() => recorderStates(page)).toEqual(['recording']);

    // The label too early is refused and the recording runs on.
    await scanCode(page, ORDER_NO);
    await expect(page.getByTestId('pack-answer')).toContainText('1 of 3 pieces');
    await expect.poll(() => recorderStates(page)).toEqual(['recording']);

    await scanCode(page, CAP.code);
    await shoot(page, 'd-pack-every-piece-in');

    // The label again: stopped, packed, the video on its way.
    await scanCode(page, ORDER_NO);
    await expect(page.getByTestId('pack-finished')).toBeVisible();
    await expect.poll(() => recorderStates(page)).toEqual(['inactive']);
    await expect.poll(() => calls.attached.length, { timeout: 15_000 }).toBe(1);
    expect(calls.attached[0]).toBe(calls.registered[0]?.videoId);
    await shoot(page, 'e-pack-finished');
  });

  test('an order in two lots has one video per lot', async ({ page }) => {
    const model = makeModel('pack', 2);
    const calls = await stubApi(page, model);
    await watchRecorders(page);
    await page.goto(`/packaging?tab=packing&order=${ORDER_ID}`);
    const lot1 = `${ORDER_NO}-L1`;
    const lot2 = `${ORDER_NO}-L2`;

    await scanCode(page, lot1);
    await expect.poll(() => recorderStates(page)).toEqual(['recording']);
    await scanCode(page, SHIRT.code);
    await expect(page.getByTestId('pack-answer')).toContainText('Linen shirt');
    await scanCode(page, lot2);
    await expect(page.getByTestId('pack-answer')).toContainText('Lot 1 is open');

    await scanCode(page, lot1);
    await expect(page.getByTestId('pack-answer')).toContainText('Lot 1 is closed');
    await expect.poll(() => recorderStates(page)).toEqual(['inactive']);
    await expect(page.getByTestId('pack-stage')).toHaveAttribute('data-status', 'label');

    await scanCode(page, lot2);
    await expect.poll(() => recorderStates(page)).toEqual(['inactive', 'recording']);
    await shoot(page, 'f-pack-second-lot');
    await scanCode(page, CAP.code);
    await expect(page.getByTestId('pack-answer')).toContainText('Every piece is in');
    await scanCode(page, lot2);
    await expect(page.getByTestId('pack-finished')).toBeVisible();

    // One video per lot, each under its own lot's recording (the upload registers it again).
    await expect
      .poll(() =>
        [
          ...new Set(
            calls.registered.map((entry) => `${entry.videoId}:${entry.recordingId ?? ''}`),
          ),
        ].map((entry) => entry.split(':')[1]),
      )
      .toEqual(['66666666-6666-4666-8666-666666666661', '66666666-6666-4666-8666-666666666662']);
    await expect.poll(() => new Set(calls.attached).size, { timeout: 20_000 }).toBe(2);
  });

  test('reads right in the dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await stubApi(page, makeModel('pack', 2));
    await page.goto(`/packaging?tab=packing&order=${ORDER_ID}`);
    await scanCode(page, `${ORDER_NO}-L1`);
    await scanCode(page, SHIRT.code);
    await expect(page.getByTestId('pack-answer')).toContainText('Linen shirt');
    await shoot(page, 'g-pack-dark');
  });
});

test.describe('the return station', () => {
  test('label, pieces back, the label again, the receipt', async ({ page }) => {
    const model = makeModel('return', 1);
    const calls = await stubApi(page, model);
    await watchRecorders(page);
    await page.goto(`/packaging?tab=returns&ret=${ORDER_ID}`);

    const stage = page.getByTestId('pack-stage');
    await expect(stage).toHaveAttribute('data-status', 'label');
    await shoot(page, 'h-return-scan-the-label');
    await scanCode(page, SHIRT.code);
    await expect(page.getByTestId('pack-answer')).toContainText('Scan the parcel label first');

    await scanCode(page, ORDER_NO);
    await expect.poll(() => recorderStates(page)).toEqual(['recording']);
    await scanCode(page, SHIRT.code);
    await expect(page.getByTestId('pack-answer')).toContainText('Linen shirt');
    await scanCode(page, OTHER_CODE);
    await expect(page.getByTestId('pack-answer')).toContainText('did not go out');
    await shoot(page, 'i-return-recording');

    // Nothing to receive until the bag's recording stopped.
    await expect(page.getByTestId('return-receive')).toHaveCount(0);
    await scanCode(page, ORDER_NO);
    await expect.poll(() => recorderStates(page)).toEqual(['inactive']);
    const receipt = page.getByTestId('return-receive');
    await expect(receipt).toBeVisible();
    await expect(receipt).toContainText('did not come back');
    await expect(page.getByTestId('return-receive-button')).toBeDisabled();

    await receipt.getByRole('button', { name: /One more damaged/ }).click();
    await receipt.getByRole('combobox', { name: 'Why it came back' }).click();
    await page.getByRole('option', { name: 'Buyer refused it' }).click();
    await receipt.getByLabel('What happened').fill('The buyer refused it at the door.');
    await expect(page.getByTestId('return-receive-button')).toBeDisabled();
    await receipt.getByRole('combobox', { name: 'Damaged shelf' }).click();
    await page.getByRole('option', { name: /Damaged shelf/ }).click();
    // A receipt short of what went out is said out loud before it can be booked.
    await expect(page.getByTestId('return-receive-button')).toBeDisabled();
    await receipt.getByRole('checkbox', { name: /receive only what was scanned/ }).click();
    await expect(page.getByTestId('return-receive-button')).toBeEnabled();
    await shoot(page, 'j-return-receipt');
    await page.getByTestId('return-receive-button').click();

    await expect(page.getByTestId('return-received')).toBeVisible();
    expect(calls.received[0]).toEqual({
      damaged: [{ skuId: SHIRT.skuId, qty: 1 }],
      returnReason: 'customer_refused',
      reason: 'The buyer refused it at the door.',
      damagedLocationId: 'loc-damaged',
      acknowledgeShort: true,
    });
    await shoot(page, 'k-return-received');
  });

  test('reads right in the dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await stubApi(page, makeModel('return', 2));
    await page.goto(`/packaging?tab=returns&ret=${ORDER_ID}`);
    await scanCode(page, `${ORDER_NO}-L2`);
    await scanCode(page, SHIRT.code);
    await expect(page.getByTestId('pack-answer')).toContainText('Linen shirt');
    await shoot(page, 'l-return-dark');
  });
});
