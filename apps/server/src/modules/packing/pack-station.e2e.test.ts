import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { withOrg, withSystem } from '@elysium/db';
import { internalEan13 } from '@elysium/domain/barcode';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import {
  ORG_A,
  ORG_B,
  startHttpHarness,
  type HttpHarness,
  type RoleClient,
} from '../../testing/http-harness.js';
import { FILES_API, type FilesApi } from '../files/files.api.js';
import { resetFilesEnv } from '../files/files.config.js';
import { FILES_QUEUE_DEFINITIONS } from '../files/files.queues.js';
import { FilesService } from '../files/files.service.js';
import { registerFilesJobs } from '../files/files.worker.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { applyOrderMigrations, seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { PACKING_QUEUE_DEFINITIONS } from './packing.queues.js';
import { ORPHAN_AFTER_MS, PackingVideoService } from './video.service.js';

/**
 * The packing station and the packing video on real Postgres (M38b, D-610 to D-614; M38
 * acceptance checks 5 and 6, M38b's 1 and 2).
 *
 * A wrong product, a wrong size and one piece too many are refused and recorded; a scan
 * retried under its key counts once; finishing moves the order to `packed` through the state
 * machine exactly once, however often it is pressed; the station and the video respect the
 * order's scope and the brand; the video is a private file only the right roles can open; and
 * the retention job deletes exactly the videos whose order ended seven Dhaka days ago, with an
 * audit row, and the stored bytes go after the commit.
 */

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let storageRoot = '';
let admin: RoleClient;
let packer: RoleClient;
let sales: RoleClient;
let accounts: RoleClient;
let marketing: RoleClient;
let customerId = '';
const suffix = randomUUID().slice(0, 6);
let barcodeSeq = 70_000_000_000 + Math.floor(Math.random() * 1_000_000_000);

interface Sku {
  readonly id: string;
  readonly code: string;
  readonly barcode: string;
}

let shirtM: Sku;
let shirtL: Sku;
let cap: Sku;

async function withBarcodes(skus: readonly { id: string; code: string }[]): Promise<Sku[]> {
  const out: Sku[] = [];
  for (const sku of skus) {
    barcodeSeq += 1;
    const barcode = internalEan13(barcodeSeq);
    await withSystem(
      (tx) =>
        tx.execute(
          sql`update catalog.skus set barcode = ${barcode} where org_id = ${ORG_A} and id = ${sku.id}`,
        ),
      { orgId: ORG_A },
    );
    out.push({ ...sku, barcode });
  }
  return out;
}

async function confirmedOrder(
  lines: readonly { sku: Sku; qty: number }[],
  createdBy = admin.userId,
): Promise<{ id: string; orderNo: string }> {
  return seedOrder(ORG_A, {
    status: 'confirmed',
    customerId,
    createdBy,
    lines: lines.map((line) => ({
      skuId: line.sku.id,
      skuCode: line.sku.code,
      productName: `Product ${line.sku.code}`,
      qty: line.qty,
      unitPricePoisha: 150_000n,
    })),
  });
}

type Json = Record<string, unknown>;

async function call(
  actor: RoleClient,
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: Json }> {
  const response = await actor.client.request(method, url, body === undefined ? {} : { body });
  return {
    status: response.statusCode,
    body: response.body === '' ? {} : (JSON.parse(response.body) as Json),
  };
}

const open = (actor: RoleClient, input: Json) => call(actor, 'POST', '/v1/packing/sessions', input);

const scan = (actor: RoleClient, sessionId: string, code: string, scanId = randomUUID()) =>
  call(actor, 'POST', `/v1/packing/sessions/${sessionId}/scans`, { scanId, code });

const complete = (actor: RoleClient, sessionId: string) =>
  call(actor, 'POST', `/v1/packing/sessions/${sessionId}/complete`);

function sessionIdOf(view: Json): string {
  return (view.session as { id: string }).id;
}

async function orderStatus(orderId: string): Promise<string> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ status: string }>(
          sql`select status::text as status from sales.orders where id = ${orderId}`,
        )
      )[0]?.status ?? '',
    { orgId: ORG_A },
  );
}

async function packEvents(orderId: string): Promise<number> {
  return withSystem(
    async (tx) =>
      (
        await tx.execute<{ n: number }>(sql`
          select count(*)::int as n from sales.order_events
          where order_id = ${orderId} and trigger = 'pack'
        `)
      )[0]?.n ?? 0,
    { orgId: ORG_A },
  );
}

/** A tiny WebM: the EBML header naming its doctype, then filler. */
function webmBytes(size = 4096): Buffer {
  const head = Buffer.from([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84,
  ]);
  return Buffer.concat([head, Buffer.from('webm'), Buffer.alloc(size, 7)]);
}

/** The files module's own upload flow: ticket, PUT to the signed URL, finalize. */
async function upload(
  actor: RoleClient,
  body: Json,
  bytes: Buffer,
): Promise<{ status: number; fileId: string; body: string }> {
  const ticket = await actor.client.request('POST', '/v1/files', {
    body: { ...body, sizeBytes: bytes.byteLength },
  });
  if (ticket.statusCode !== 201)
    return { status: ticket.statusCode, fileId: '', body: ticket.body };
  const parsed = JSON.parse(ticket.body) as {
    fileId: string;
    url: string;
    headers: Record<string, string>;
  };
  const target = new URL(parsed.url);
  const put = await harness.server.inject({
    method: 'PUT',
    url: `${target.pathname}${target.search}`,
    headers: { ...parsed.headers, host: target.host },
    payload: bytes,
  });
  expect(put.statusCode, put.body).toBe(200);
  const finalized = await actor.client.request('POST', `/v1/files/${parsed.fileId}/finalize`);
  return { status: finalized.statusCode, fileId: parsed.fileId, body: finalized.body };
}

/** One recorded part, uploaded and attached to a session. */
async function recordVideo(
  actor: RoleClient,
  sessionId: string,
): Promise<{ videoId: string; fileId: string }> {
  const videoId = randomUUID();
  const started = await call(actor, 'POST', `/v1/packing/sessions/${sessionId}/videos`, {
    videoId,
    startedAt: new Date().toISOString(),
    mime: 'video/webm',
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const uploaded = await upload(
    actor,
    { purpose: 'packing-video', contentType: 'video/webm', originalName: 'pack.webm' },
    webmBytes(),
  );
  expect(uploaded.status, uploaded.body).toBe(201);
  const attached = await call(
    actor,
    'POST',
    `/v1/packing/sessions/${sessionId}/videos/${videoId}/file`,
    { fileId: uploaded.fileId, durationMs: 42_000 },
  );
  expect(attached.status, JSON.stringify(attached.body)).toBe(200);
  expect(attached.body).toMatchObject({ state: 'uploaded', durationMs: 42_000 });
  return { videoId, fileId: uploaded.fileId };
}

/** A one-piece order, opened, scanned, recorded and finished: packed, with its video. */
async function packedWithVideo(): Promise<{
  orderId: string;
  sessionId: string;
  videoId: string;
  fileId: string;
}> {
  const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
  const opened = await open(packer, { orderId: order.id });
  const sessionId = sessionIdOf(opened.body);
  const video = await recordVideo(packer, sessionId);
  expect((await scan(packer, sessionId, cap.barcode)).body.outcome).toBe('accepted');
  expect((await complete(packer, sessionId)).status).toBe(200);
  return { orderId: order.id, sessionId, ...video };
}

/** The words a refused statement failed with, from the driver's error under Drizzle's. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    const words: string[] = [];
    for (let current: unknown = error; current instanceof Error; current = current.cause) {
      words.push(current.message);
    }
    return words.join(' | ');
  }
  return 'not refused';
}

/** Every stored object of a file under the local driver's root (the bytes and their note). */
async function bytesOf(fileId: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.startsWith(fileId)) found.push(full);
    }
  };
  await walk(storageRoot);
  return found;
}

/** Walk an order on through §9's own pairs as the system, its arrival at the last at `at`. */
async function moveOrder(orderId: string, statuses: readonly string[], at: Date): Promise<void> {
  await withSystem(
    async (tx) => {
      let from = (
        await tx.execute<{ status: string }>(
          sql`select status::text as status from sales.orders where id = ${orderId}`,
        )
      )[0]?.status;
      for (const status of statuses) {
        const when = at.toISOString();
        if (status === 'returned') {
          // A return says why (D-234), or the database refuses it at commit.
          await tx.execute(sql`
            insert into sales.order_returns
              (org_id, order_id, kind, reason_code, business_date, recorded_by)
            values (${ORG_A}, ${orderId}, 'return', 'customer_refused',
                    (${when}::timestamptz at time zone 'Asia/Dhaka')::date, 'usr_pack_test')
          `);
        }
        await tx.execute(sql`
          update sales.orders set status = ${status}::sales.order_status,
            delivered_at = case when ${status} in ('delivered', 'partially_delivered')
                                then ${when}::timestamptz else delivered_at end,
            returned_at = case when ${status} = 'returned' then ${when}::timestamptz else returned_at end,
            cancelled_at = case when ${status} = 'cancelled' then ${when}::timestamptz else cancelled_at end,
            cancel_reason = case when ${status} = 'cancelled' then 'test' else cancel_reason end
          where id = ${orderId}
        `);
        await tx.execute(sql`
          insert into sales.order_events
            (org_id, order_id, from_status, to_status, trigger, actor_user_id, business_date, occurred_at)
          values (${ORG_A}, ${orderId}, ${from ?? null}::sales.order_status,
                  ${status}::sales.order_status, 'test', null,
                  (${when}::timestamptz at time zone 'Asia/Dhaka')::date, ${when}::timestamptz)
        `);
        from = status;
      }
    },
    { orgId: ORG_A },
  );
}

beforeAll(async () => {
  process.env.STORAGE_DRIVER = 'local';
  storageRoot = await mkdtemp(path.join(tmpdir(), 'elysium-pack-'));
  process.env.STORAGE_LOCAL_ROOT = storageRoot;
  resetFilesEnv();

  harness = await startHttpHarness('pack-station');
  await applyOrderMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [...FILES_QUEUE_DEFINITIONS, ...PACKING_QUEUE_DEFINITIONS],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  await registerFilesJobs({
    jobs,
    files: harness.app.get(FilesService, { strict: false }),
    report: () => Promise.resolve(),
  });

  admin = await harness.asRole('org_admin', ORG_A);
  packer = await harness.asRole('warehouse', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  accounts = await harness.asRole('accounts', ORG_A);
  marketing = await harness.asRole('marketing', ORG_A);

  const shirt = await seedProductWithSkus(ORG_A, `ps${suffix}`, 2);
  [shirtM, shirtL] = (await withBarcodes(shirt.skus)) as [Sku, Sku];
  const caps = await seedProductWithSkus(ORG_A, `pc${suffix}`, 1);
  [cap] = (await withBarcodes(caps.skus)) as [Sku];
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711000333', name: 'Karim Ali' });
}, 300_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

describe('the packing station (M38b check 1, M38 check 5)', () => {
  it('takes the right pieces by barcode or SKU code and refuses a wrong size, a wrong product, a stranger and one too many', async () => {
    const order = await confirmedOrder([{ sku: shirtM, qty: 2 }]);
    // The slip carries the order number.
    const opened = await open(packer, { code: order.orderNo });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const sessionId = sessionIdOf(opened.body);
    expect(opened.body).toMatchObject({
      session: { status: 'open', orderNo: order.orderNo },
      order: { orderNumber: order.orderNo, status: 'confirmed' },
      lines: [{ skuId: shirtM.id, required: 2, packed: 0, state: 'todo', barcode: shirtM.barcode }],
      progress: { unitsRequired: 2, unitsPacked: 0, complete: false },
    });

    const byBarcode = await scan(packer, sessionId, shirtM.barcode);
    expect(byBarcode.body).toMatchObject({ outcome: 'accepted', accepted: true });
    const byCode = await scan(packer, sessionId, shirtM.code.toLowerCase());
    expect(byCode.body).toMatchObject({
      outcome: 'accepted',
      view: { progress: { unitsPacked: 2, complete: true } },
    });

    const tooMany = await scan(packer, sessionId, shirtM.barcode);
    expect(tooMany.status).toBe(200);
    expect(tooMany.body).toMatchObject({ outcome: 'over', accepted: false });
    expect(String(tooMany.body.message)).toMatch(/one too many/i);
    expect((await scan(packer, sessionId, shirtL.barcode)).body.outcome).toBe('wrong_variant');
    expect((await scan(packer, sessionId, cap.barcode)).body.outcome).toBe('wrong_item');
    expect((await scan(packer, sessionId, 'NO-SUCH-STICKER')).body.outcome).toBe('unknown_code');

    // Every scan is on the record, refusals included, newest first.
    const view = (await call(packer, 'GET', `/v1/packing/sessions/${sessionId}`)).body;
    const outcomes = (view.scans as { outcome: string }[]).map((entry) => entry.outcome);
    expect(outcomes).toEqual([
      'unknown_code',
      'wrong_item',
      'wrong_variant',
      'over',
      'accepted',
      'accepted',
    ]);
    expect(view.progress).toMatchObject({ unitsPacked: 2, complete: true });
    expect(JSON.stringify(view)).not.toMatch(/cost|wac/i);
  });

  it('counts a retried scan once, takes a piece back out, and refuses to finish an incomplete box', async () => {
    const order = await confirmedOrder([{ sku: cap, qty: 2 }]);
    const sessionId = sessionIdOf((await open(packer, { orderId: order.id })).body);
    const scanId = randomUUID();
    await scan(packer, sessionId, cap.barcode, scanId);
    const retried = await scan(packer, sessionId, cap.barcode, scanId);
    expect(retried.body).toMatchObject({ outcome: 'accepted', repeated: true });
    expect(retried.body.view).toMatchObject({ progress: { unitsPacked: 1 } });

    const early = await complete(packer, sessionId);
    expect(early.status).toBe(409);
    expect(early.body.code).toBe('PACKING_INCOMPLETE');
    expect(await orderStatus(order.id)).toBe('confirmed');

    const removed = await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/removals`, {
      scanId: randomUUID(),
      skuId: cap.id,
    });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ progress: { unitsPacked: 0 } });
    const nothing = await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/removals`, {
      scanId: randomUUID(),
      skuId: cap.id,
    });
    expect(nothing.status).toBe(409);
    expect(nothing.body.code).toBe('PACKING_NOTHING_TO_REMOVE');
  });

  it('moves a complete order to packed through the state machine exactly once, however often it is finished', async () => {
    const order = await confirmedOrder([
      { sku: shirtM, qty: 1 },
      { sku: cap, qty: 1 },
    ]);
    const sessionId = sessionIdOf((await open(packer, { orderId: order.id })).body);
    await scan(packer, sessionId, shirtM.barcode);
    await scan(packer, sessionId, cap.code);

    // Two finishes at once: one moves the order, the other finds it done.
    const [first, second] = await Promise.all([
      complete(packer, sessionId),
      complete(packer, sessionId),
    ]);
    expect([first.status, second.status]).toEqual([200, 200]);
    expect(
      [first.body.alreadyCompleted, second.body.alreadyCompleted].sort((a, b) =>
        String(a).localeCompare(String(b)),
      ),
    ).toEqual([false, true]);
    expect(await orderStatus(order.id)).toBe('packed');
    expect(await packEvents(order.id)).toBe(1);

    const again = await complete(packer, sessionId);
    expect(again.body).toMatchObject({
      alreadyCompleted: true,
      session: { status: 'completed', completedBy: { id: packer.userId } },
    });
    expect(await packEvents(order.id)).toBe(1);

    // A finished session takes no more pieces, and the order is not opened afresh.
    const late = await scan(packer, sessionId, cap.barcode);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('PACKING_NOT_PACKABLE');
    const reopened = await open(packer, { orderId: order.id });
    expect(sessionIdOf(reopened.body)).toBe(sessionId);

    // Who packed, when, and the order's history says `pack` once, by the packer.
    const audit = await withSystem(
      async (tx) =>
        tx.execute<{ action: string; actor_user_id: string }>(sql`
          select action, actor_user_id from audit.audit_log
          where org_id = ${ORG_A} and entity_id = ${order.id} and action = 'order.pack'
        `),
      { orgId: ORG_A },
    );
    expect(audit.map((row) => row.actor_user_id)).toEqual([packer.userId]);
  });

  it('opens only a confirmed order', async () => {
    const pending = await seedOrder(ORG_A, {
      status: 'pending',
      customerId,
      createdBy: admin.userId,
      lines: [
        { skuId: cap.id, skuCode: cap.code, productName: 'Cap', qty: 1, unitPricePoisha: 1n },
      ],
    });
    const refused = await open(packer, { code: pending.orderNo });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PACKING_NOT_PACKABLE');
    expect(String(refused.body.detail)).toMatch(/not confirmed yet/);
    const unknown = await open(packer, { code: 'NO-SUCH-ORDER' });
    expect(unknown.status).toBe(404);
  });

  it('keeps to the order’s scope and to the brand', async () => {
    const someoneElses = await confirmedOrder([{ sku: cap, qty: 1 }]);
    // Sales packs only orders of their own.
    const refused = await open(sales, { orderId: someoneElses.id });
    expect(refused.status).toBe(404);
    const theirs = await confirmedOrder([{ sku: cap, qty: 1 }], sales.userId);
    expect((await open(sales, { orderId: theirs.id })).status).toBe(200);

    const sessionId = sessionIdOf((await open(packer, { orderId: someoneElses.id })).body);
    expect((await call(sales, 'GET', `/v1/packing/sessions/${sessionId}`)).status).toBe(404);
    expect((await scan(sales, sessionId, cap.barcode)).status).toBe(404);
    const listed = (await call(sales, 'GET', '/v1/packing/sessions')).body.items as {
      orderId: string;
    }[];
    expect(listed.map((item) => item.orderId)).not.toContain(someoneElses.id);

    // Another brand's admin cannot see the session at all.
    const other = await harness.asRole('org_admin', ORG_B);
    expect((await call(other, 'GET', `/v1/packing/sessions/${sessionId}`)).status).toBe(404);
    const rls = await withSystem(
      async (tx) => tx.execute<{ n: number }>(sql`select count(*)::int as n from packing.sessions`),
      { orgId: ORG_B },
    );
    expect(rls[0]?.n).toBe(0);
  });

  it('lists recent sessions with the packer, the pieces, the mismatches and the video', async () => {
    const listed = await call(admin, 'GET', '/v1/packing/sessions?limit=50');
    expect(listed.status).toBe(200);
    const items = listed.body.items as {
      mismatches: number;
      pieces: number;
      startedBy: { id: string; name: string | null };
      video: string;
    }[];
    expect(items.length).toBeGreaterThan(3);
    expect(items.some((item) => item.mismatches === 4 && item.pieces === 2)).toBe(true);
    expect(items.every((item) => item.startedBy.id !== '')).toBe(true);
    expect(
      items.every((item) => ['pending', 'missing', 'uploaded', 'off'].includes(item.video)),
    ).toBe(true);
  });

  it('records with the brand’s setting, which only an org admin changes', async () => {
    expect((await call(packer, 'GET', '/v1/packing/settings')).body).toMatchObject({
      videoEnabled: true,
      canEdit: false,
    });
    expect(
      (await call(packer, 'PUT', '/v1/packing/settings', { videoEnabled: false })).status,
    ).toBe(403);
    expect(
      (await call(admin, 'PUT', '/v1/packing/settings', { videoEnabled: false })).body,
    ).toMatchObject({ videoEnabled: false });
    const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
    const opened = await open(packer, { orderId: order.id });
    expect(opened.body).toMatchObject({ session: { videoRequired: false }, video: 'off' });
    await call(admin, 'PUT', '/v1/packing/settings', { videoEnabled: true });
  });
});

describe('the packing station after the ledger audit (M38b)', () => {
  it('shows a sales agent their own newest sessions, however many colleagues packed since', async () => {
    const theirs = await confirmedOrder([{ sku: cap, qty: 1 }], sales.userId);
    expect((await open(sales, { orderId: theirs.id })).status).toBe(200);
    for (let n = 0; n < 3; n += 1) {
      const others = await confirmedOrder([{ sku: cap, qty: 1 }]);
      expect((await open(packer, { orderId: others.id })).status).toBe(200);
    }
    // The newest sessions are the packer's; the agent's own still fills their list.
    const listed = await call(sales, 'GET', '/v1/packing/sessions?limit=1');
    expect(listed.status).toBe(200);
    const items = listed.body.items as { orderId: string }[];
    expect(items.map((item) => item.orderId)).toEqual([theirs.id]);
    const everyone = await call(admin, 'GET', '/v1/packing/sessions?limit=2');
    expect(
      (everyone.body.items as { orderId: string }[]).map((item) => item.orderId),
    ).not.toContain(theirs.id);
  });

  it('refuses a reseller the packing record, even of an order of their own (D-665)', async () => {
    const reseller = await harness.asRole('reseller', ORG_A);
    const order = await confirmedOrder([{ sku: cap, qty: 1 }], reseller.userId);
    const sessionId = sessionIdOf((await open(packer, { orderId: order.id })).body);
    for (const url of [
      '/v1/packing/sessions',
      `/v1/packing/sessions/${sessionId}`,
      `/v1/packing/orders/${order.id}`,
    ]) {
      const refused = await call(reseller, 'GET', url);
      expect(refused.status, url).toBe(403);
      expect(refused.body.code).toBe('FORBIDDEN');
    }
    // Staff still read it.
    expect((await call(accounts, 'GET', `/v1/packing/orders/${order.id}`)).status).toBe(200);
  });

  it('keeps every scan as it was written, for every role', async () => {
    const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
    const sessionId = sessionIdOf((await open(packer, { orderId: order.id })).body);
    expect((await scan(packer, sessionId, cap.barcode)).body.outcome).toBe('accepted');
    // The table's owner is held by the trigger, not only by the grants.
    expect(
      await refusal(
        withSystem(
          (tx) =>
            tx.execute(sql`update packing.scans set code = 'X' where session_id = ${sessionId}`),
          { orgId: ORG_A },
        ),
      ),
    ).toMatch(/a packing scan is never changed or removed/);
    expect(
      await refusal(
        withSystem(
          (tx) => tx.execute(sql`delete from packing.scans where session_id = ${sessionId}`),
          { orgId: ORG_A },
        ),
      ),
    ).toMatch(/a packing scan is never changed or removed/);
    // And the application's role has neither grant.
    expect(
      await refusal(
        withOrg({ orgId: ORG_A }, (tx) =>
          tx.execute(sql`delete from packing.scans where session_id = ${sessionId}`),
        ),
      ),
    ).toMatch(/permission denied/);
    const view = (await call(packer, 'GET', `/v1/packing/sessions/${sessionId}`)).body;
    expect((view.scans as unknown[]).length).toBe(1);
  });
});

describe('the packing video (M38b check 2)', () => {
  it('uploads as a private packing video, attaches once, plays for the right roles only', async () => {
    const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
    const sessionId = sessionIdOf((await open(packer, { orderId: order.id })).body);
    const { videoId, fileId } = await recordVideo(packer, sessionId);

    // Attached once; another file for the same part is refused.
    const other = await upload(
      packer,
      { purpose: 'packing-video', contentType: 'video/webm' },
      webmBytes(512),
    );
    const twice = await call(
      packer,
      'POST',
      `/v1/packing/sessions/${sessionId}/videos/${videoId}/file`,
      {
        fileId: other.fileId,
        durationMs: 1,
      },
    );
    expect(twice.status).toBe(409);

    // The warehouse and the org admin play it; the URL works.
    for (const actor of [packer, admin]) {
      const played = await call(actor, 'GET', `/v1/packing/videos/${videoId}/url`);
      expect(played.status, JSON.stringify(played.body)).toBe(200);
      expect(played.body).toMatchObject({ mime: 'video/webm', durationMs: 42_000 });
      const target = new URL(String(played.body.url));
      const bytes = await harness.server.inject({
        method: 'GET',
        url: `${target.pathname}${target.search}`,
      });
      expect(bytes.statusCode).toBe(200);
      expect(bytes.headers['content-type']).toBe('video/webm');
    }

    // Sales may watch only for an order in their own scope; this one is not.
    expect((await call(sales, 'GET', `/v1/packing/videos/${videoId}/url`)).status).toBe(404);
    // Roles without `read PackingVideo` are refused at the door, here and through files.
    for (const actor of [accounts, marketing]) {
      expect((await call(actor, 'GET', `/v1/packing/videos/${videoId}/url`)).status).toBe(403);
      expect((await call(actor, 'GET', `/v1/files/${fileId}/download`)).status).toBe(403);
    }
    expect((await call(sales, 'GET', `/v1/files/${fileId}/download`)).status).toBe(403);
    expect((await call(packer, 'GET', `/v1/files/${fileId}/download`)).status).toBe(200);

    // The order page shows the scan log and the part, and who may play it.
    const page = await call(accounts, 'GET', `/v1/packing/orders/${order.id}`);
    expect(page.body).toMatchObject({
      canPlay: false,
      videos: [{ id: videoId, part: 1, state: 'uploaded' }],
    });
    expect((await call(packer, 'GET', `/v1/packing/orders/${order.id}`)).body.canPlay).toBe(true);
  });

  it('is never public, is the only purpose that takes a video, and takes only the uploader’s file', async () => {
    const asPublic = await packer.client.request('POST', '/v1/files', {
      body: {
        purpose: 'packing-video',
        contentType: 'video/webm',
        sizeBytes: 100,
        visibility: 'public',
      },
    });
    expect(asPublic.statusCode).toBe(400);
    const notVideo = await packer.client.request('POST', '/v1/files', {
      body: { purpose: 'packing-video', contentType: 'image/png', sizeBytes: 100 },
    });
    expect(notVideo.statusCode).toBe(400);
    const videoAsProof = await packer.client.request('POST', '/v1/files', {
      body: { purpose: 'courier-proof', contentType: 'video/webm', sizeBytes: 100 },
    });
    expect(videoAsProof.statusCode).toBe(400);
    // A role that cannot pack cannot upload one.
    const byAccounts = await accounts.client.request('POST', '/v1/files', {
      body: { purpose: 'packing-video', contentType: 'video/webm', sizeBytes: 100 },
    });
    expect(byAccounts.statusCode).toBe(403);

    // Somebody else's upload is not attached to the packer's part.
    const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
    const sessionId = sessionIdOf((await open(packer, { orderId: order.id })).body);
    const videoId = randomUUID();
    await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/videos`, {
      videoId,
      startedAt: new Date().toISOString(),
      mime: 'video/webm',
    });
    const adminsFile = await upload(
      admin,
      { purpose: 'packing-video', contentType: 'video/webm' },
      webmBytes(256),
    );
    const refused = await call(
      packer,
      'POST',
      `/v1/packing/sessions/${sessionId}/videos/${videoId}/file`,
      {
        fileId: adminsFile.fileId,
        durationMs: 5,
      },
    );
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PACKING_VIDEO_INVALID');
  });
});

describe('the packing video after the ledger audit (M38b)', () => {
  async function register(actor: RoleClient, sessionId: string, startedAt: Date) {
    return call(actor, 'POST', `/v1/packing/sessions/${sessionId}/videos`, {
      videoId: randomUUID(),
      startedAt: startedAt.toISOString(),
      mime: 'video/webm',
    });
  }

  it('refuses the same file for a second part with a 409, not a server error', async () => {
    const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
    const sessionId = sessionIdOf((await open(packer, { orderId: order.id })).body);
    const first = await recordVideo(packer, sessionId);
    const second = await register(packer, sessionId, new Date());
    expect(second.status).toBe(200);
    const reused = await call(
      packer,
      'POST',
      `/v1/packing/sessions/${sessionId}/videos/${String(second.body.id)}/file`,
      { fileId: first.fileId, durationMs: 1_000 },
    );
    expect(reused.status, JSON.stringify(reused.body)).toBe(409);
    expect(reused.body.code).toBe('PACKING_VIDEO_INVALID');
  });

  it('attaches a part’s file only for the person who recorded it, or an org admin', async () => {
    const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
    const sessionId = sessionIdOf((await open(packer, { orderId: order.id })).body);
    const part = await register(packer, sessionId, new Date());
    const videoId = String(part.body.id);
    const colleague = await harness.asRole('warehouse', ORG_A);
    const theirs = await upload(
      colleague,
      { purpose: 'packing-video', contentType: 'video/webm' },
      webmBytes(300),
    );
    const refused = await call(
      colleague,
      'POST',
      `/v1/packing/sessions/${sessionId}/videos/${videoId}/file`,
      { fileId: theirs.fileId, durationMs: 5 },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe('FORBIDDEN');

    const adminsFile = await upload(
      admin,
      { purpose: 'packing-video', contentType: 'video/webm' },
      webmBytes(300),
    );
    const byAdmin = await call(
      admin,
      'POST',
      `/v1/packing/sessions/${sessionId}/videos/${videoId}/file`,
      { fileId: adminsFile.fileId, durationMs: 5 },
    );
    expect(byAdmin.status, JSON.stringify(byAdmin.body)).toBe(200);
    expect(byAdmin.body).toMatchObject({ state: 'uploaded' });
  });

  it('takes a part on a finished packing only if it started before the box was closed', async () => {
    const packed = await packedWithVideo();
    const view = (await call(packer, 'GET', `/v1/packing/sessions/${packed.sessionId}`)).body;
    const session = view.session as { startedAt: string; completedAt: string };
    const completedAt = new Date(session.completedAt);

    const late = await register(packer, packed.sessionId, new Date(completedAt.getTime() + 60_000));
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('PACKING_VIDEO_INVALID');
    expect(String(late.body.detail)).toMatch(/finished before that recording started/);

    const filmedWhileOpen = await register(packer, packed.sessionId, new Date(session.startedAt));
    expect(filmedWhileOpen.status, JSON.stringify(filmedWhileOpen.body)).toBe(200);
    expect(filmedWhileOpen.body).toMatchObject({ part: 2, state: 'waiting' });
  });
});

describe('the packing video’s retention (M38b check 2, M38 check 6)', () => {
  it('deletes exactly the videos seven Dhaka days past delivery, return or cancel, audits each, and removes the bytes after', async () => {
    const service = harness.app.get(PackingVideoService, { strict: false });
    // Delivered at 15:00 in Dhaka on 1 October 2026.
    const deliveredAt = new Date('2026-10-01T09:00:00Z');
    const delivered = await packedWithVideo();
    await moveOrder(delivered.orderId, ['shipped', 'delivered'], deliveredAt);
    const returned = await packedWithVideo();
    await moveOrder(returned.orderId, ['shipped', 'return_in_transit', 'returned'], deliveredAt);
    const cancelledLater = await packedWithVideo();
    await moveOrder(cancelledLater.orderId, ['cancelled'], new Date('2026-10-05T09:00:00Z'));
    const inFlight = await packedWithVideo();
    await moveOrder(inFlight.orderId, ['shipped'], new Date('2026-09-01T09:00:00Z'));

    // The object and the local driver's note of its type beside it.
    expect((await bytesOf(delivered.fileId)).length).toBeGreaterThan(0);

    // 23:59 on 8 October in Dhaka: the seventh day after delivery. Nothing goes.
    expect(await service.purgeOrg(ORG_A, new Date('2026-10-08T17:59:00Z'))).toEqual({
      deleted: 0,
      failed: 0,
    });
    // 00:01 on 9 October in Dhaka: the delivered and returned videos go; the order cancelled
    // on the 5th and the one still on the road keep theirs.
    expect(await service.purgeOrg(ORG_A, new Date('2026-10-08T18:01:00Z'))).toEqual({
      deleted: 2,
      failed: 0,
    });

    const state = await withSystem(
      async (tx) =>
        tx.execute<{
          id: string;
          file_id: string | null;
          deleted_file_id: string | null;
          deleted_reason: string | null;
        }>(sql`select id, file_id, deleted_file_id, deleted_reason from packing.videos`),
      { orgId: ORG_A },
    );
    const byId = new Map(state.map((row) => [row.id, row]));
    expect(byId.get(delivered.videoId)).toMatchObject({
      file_id: null,
      deleted_file_id: delivered.fileId,
      deleted_reason: 'delivered',
    });
    expect(byId.get(returned.videoId)).toMatchObject({ file_id: null, deleted_reason: 'returned' });
    expect(byId.get(cancelledLater.videoId)?.file_id).toBe(cancelledLater.fileId);
    expect(byId.get(inFlight.videoId)?.file_id).toBe(inFlight.fileId);

    // The file rows are gone with them, each deletion audited with the file and the order.
    const files = await withSystem(
      async (tx) =>
        tx.execute<{ id: string }>(sql`
          select id from files.objects
          where id in (${delivered.fileId}, ${returned.fileId}, ${cancelledLater.fileId})
        `),
      { orgId: ORG_A },
    );
    expect(files.map((row) => row.id)).toEqual([cancelledLater.fileId]);
    const audits = await withSystem(
      async (tx) =>
        tx.execute<{ entity_id: string; before: { fileId: string; orderId: string } }>(sql`
          select entity_id, before from audit.audit_log
          where org_id = ${ORG_A} and action = 'packing.video_deleted'
        `),
      { orgId: ORG_A },
    );
    expect(audits.map((row) => row.entity_id).sort()).toEqual(
      [delivered.videoId, returned.videoId].sort(),
    );
    expect(audits.find((row) => row.entity_id === delivered.videoId)?.before).toMatchObject({
      fileId: delivered.fileId,
      orderId: delivered.orderId,
    });

    // The bytes go after the commit, through `files.remove_object`.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (
        (await bytesOf(delivered.fileId)).length === 0 &&
        (await bytesOf(returned.fileId)).length === 0
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(await bytesOf(delivered.fileId)).toEqual([]);
    expect(await bytesOf(returned.fileId)).toEqual([]);
    expect((await bytesOf(cancelledLater.fileId)).length).toBeGreaterThan(0);

    // A deleted video is gone for everyone, and says so; a second run deletes nothing more.
    const gone = await call(admin, 'GET', `/v1/packing/videos/${delivered.videoId}/url`);
    expect(gone.status).toBe(410);
    expect(gone.body.code).toBe('PACKING_VIDEO_GONE');
    expect(await service.purgeOrg(ORG_A, new Date('2026-10-08T18:02:00Z'))).toEqual({
      deleted: 0,
      failed: 0,
    });
    const page = await call(admin, 'GET', `/v1/packing/orders/${delivered.orderId}`);
    expect(page.body).toMatchObject({ video: 'deleted', videos: [{ state: 'deleted' }] });

    // Seven days after the cancel, that one goes too; the order on the road never does.
    expect(await service.purgeOrg(ORG_A, new Date('2026-10-13T18:01:00Z'))).toEqual({
      deleted: 1,
      failed: 0,
    });
    expect(await service.purgeOrg(ORG_A, new Date('2027-10-13T18:01:00Z'))).toEqual({
      deleted: 0,
      failed: 0,
    });
    expect(existsSync(storageRoot)).toBe(true);
  });

  it('deletes every other video when one fails, and says how many failed (ledger audit)', async () => {
    const service = harness.app.get(PackingVideoService, { strict: false });
    const files = harness.app.get<FilesApi>(FILES_API, { strict: false });
    const deliveredAt = new Date('2026-10-01T09:00:00Z');
    const first = await packedWithVideo();
    await moveOrder(first.orderId, ['shipped', 'delivered'], deliveredAt);
    const second = await packedWithVideo();
    await moveOrder(second.orderId, ['shipped', 'delivered'], deliveredAt);

    const forget = vi
      .spyOn(files, 'forget')
      .mockRejectedValueOnce(new Error('the object store is down'));
    try {
      const after = new Date('2026-10-08T18:01:00Z');
      expect(await service.purgeOrg(ORG_A, after)).toEqual({ deleted: 1, failed: 1 });
      // The failed one is still attached, and the next run takes it.
      expect(await service.purgeOrg(ORG_A, after)).toEqual({ deleted: 1, failed: 0 });
    } finally {
      forget.mockRestore();
    }
    const rows = await withSystem(
      async (tx) =>
        tx.execute<{ file_id: string | null }>(sql`
          select file_id from packing.videos where id in (${first.videoId}, ${second.videoId})
        `),
      { orgId: ORG_A },
    );
    expect(rows.map((row) => row.file_id)).toEqual([null, null]);

    // A brand that fails does not stop the others, and the run reports it.
    const orgs = await withSystem(async (tx) =>
      tx.execute<{ n: number }>(sql`select count(*)::int as n from org.organizations`),
    );
    const purgeOrg = vi
      .spyOn(service, 'purgeOrg')
      .mockRejectedValueOnce(new Error('this brand could not be read'));
    try {
      expect(await service.purgeAll(new Date('2020-01-01T00:00:00Z'))).toEqual({
        deleted: 0,
        swept: 0,
        failed: 1,
      });
      expect(purgeOrg).toHaveBeenCalledTimes(orgs[0]?.n ?? 0);
    } finally {
      purgeOrg.mockRestore();
    }
  });

  it('forgets a day-old upload no part took, audited, its bytes removed after, and keeps attached ones', async () => {
    const service = harness.app.get(PackingVideoService, { strict: false });
    const attached = await packedWithVideo();
    // Finalized, and its attach never came.
    const orphan = await upload(
      packer,
      { purpose: 'packing-video', contentType: 'video/webm' },
      webmBytes(700),
    );
    expect(orphan.status).toBe(201);
    // A ticket whose bytes never arrived.
    const ticket = await packer.client.request('POST', '/v1/files', {
      body: { purpose: 'packing-video', contentType: 'video/webm', sizeBytes: 900 },
    });
    expect(ticket.statusCode).toBe(201);
    const pendingId = (JSON.parse(ticket.body) as { fileId: string }).fileId;
    expect((await bytesOf(orphan.fileId)).length).toBeGreaterThan(0);

    const stillThere = async () =>
      (
        await withSystem(
          async (tx) =>
            tx.execute<{ id: string }>(sql`
              select id from files.objects
              where id in (${orphan.fileId}, ${pendingId}, ${attached.fileId})
            `),
          { orgId: ORG_A },
        )
      )
        .map((row) => row.id)
        .sort();

    // Younger than a day: none of these goes.
    const early = await service.sweepOrphans(
      ORG_A,
      new Date(Date.now() + ORPHAN_AFTER_MS - 60_000),
    );
    expect(early.failed).toBe(0);
    expect(await stillThere()).toEqual([orphan.fileId, pendingId, attached.fileId].sort());

    const swept = await service.sweepOrphans(
      ORG_A,
      new Date(Date.now() + ORPHAN_AFTER_MS + 60_000),
    );
    expect(swept.failed).toBe(0);
    expect(swept.deleted).toBeGreaterThanOrEqual(2);
    expect(await stillThere()).toEqual([attached.fileId]);

    const audits = await withSystem(
      async (tx) =>
        tx.execute<{ entity_id: string; before: { ownerUserId: string; status: string } }>(sql`
          select entity_id, before from audit.audit_log
          where org_id = ${ORG_A} and action = 'packing.video_upload_swept'
            and entity_id in (${orphan.fileId}, ${pendingId})
        `),
      { orgId: ORG_A },
    );
    expect(audits.map((row) => row.entity_id).sort()).toEqual([orphan.fileId, pendingId].sort());
    expect(audits.find((row) => row.entity_id === orphan.fileId)?.before).toMatchObject({
      ownerUserId: packer.userId,
      status: 'stored',
    });

    // The bytes go after the commit, through `files.remove_object`; the attached video stays.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if ((await bytesOf(orphan.fileId)).length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    expect(await bytesOf(orphan.fileId)).toEqual([]);
    expect((await bytesOf(attached.fileId)).length).toBeGreaterThan(0);
    const played = await call(admin, 'GET', `/v1/packing/videos/${attached.videoId}/url`);
    expect(played.status).toBe(200);
  });
});
