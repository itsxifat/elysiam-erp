import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { withSystem } from '@elysium/db';
import { internalEan13 } from '@elysium/domain/barcode';
import { PACKING_CAMERA_MAX_MS, PACKING_CAMERA_PREROLL_MS } from '@elysium/domain/packing';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { AuditService } from '../../platform/audit/audit.service.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { fakeFfmpeg } from '../../testing/fake-ffmpeg.js';
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
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { applyOrderMigrations, seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { CameraProcessService } from './camera/camera-process.service.js';
import type { RecorderLog } from './camera/camera-recorder.js';
import { segmentName } from './camera/segment-buffer.js';
import { PACKING_QUEUE_DEFINITIONS } from './packing.queues.js';

/**
 * The packing table's IP camera on real Postgres (M38c, D-668 to D-676).
 *
 * The camera's password is sealed and never returned, and only an org admin sets it; the
 * station chooses a camera when it opens an order; **only the first accepted scan** starts the
 * recording, two seconds before it, and no refused scan ever does; the finish ends it and
 * enqueues the cut in the same transaction; a recording left open is closed at fifteen
 * minutes; the camera process records with the opened password and never logs it, and cuts
 * the window into a private packing video filed as the session's camera part, which plays
 * and is kept and deleted like any other.
 */

const PASSWORD = 'Tapo!pa:ss w0rd';

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let admin: RoleClient;
let packer: RoleClient;
let sales: RoleClient;
let adminB: RoleClient;
let customerId = '';
let fake: Awaited<ReturnType<typeof fakeFfmpeg>>;
const suffix = randomUUID().slice(0, 6);
let barcodeSeq = 72_000_000_000 + Math.floor(Math.random() * 1_000_000_000);

interface Sku {
  readonly id: string;
  readonly code: string;
  readonly barcode: string;
}
let shirtM: Sku;
let shirtL: Sku;
let cap: Sku;

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

async function confirmedOrder(lines: readonly { sku: Sku; qty: number }[]) {
  return seedOrder(ORG_A, {
    status: 'confirmed',
    customerId,
    createdBy: admin.userId,
    lines: lines.map((line) => ({
      skuId: line.sku.id,
      skuCode: line.sku.code,
      productName: `Product ${line.sku.code}`,
      qty: line.qty,
      unitPricePoisha: 150_000n,
    })),
  });
}

const scan = (actor: RoleClient, sessionId: string, code: string) =>
  call(actor, 'POST', `/v1/packing/sessions/${sessionId}/scans`, { scanId: randomUUID(), code });

async function addCamera(name: string, password: string | null = PASSWORD): Promise<string> {
  const added = await call(admin, 'POST', '/v1/packing/cameras', {
    name,
    rtspUrl: 'rtsp://192.168.20.111:554/stream1',
    username: 'packing',
    ...(password === null ? {} : { password }),
  });
  expect(added.status, JSON.stringify(added.body)).toBe(201);
  return String(added.body.id);
}

interface SessionWindow {
  camera_id: string | null;
  recording_from: Date | null;
  recording_to: Date | null;
  recording_by: string | null;
  completed_at: Date | null;
}

async function windowOf(sessionId: string): Promise<SessionWindow> {
  return withSystem(
    async (tx) => {
      const [row] = await tx.execute<SessionWindow & Record<string, unknown>>(sql`
        select camera_id, recording_from, recording_to, recording_by, completed_at
        from packing.sessions where id = ${sessionId}
      `);
      if (row === undefined) throw new Error('no session');
      return row;
    },
    { orgId: ORG_A },
  );
}

async function cutJobs(sessionId: string): Promise<number> {
  return withSystem(async (tx) => {
    const [row] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from pgboss.job
      where name = 'packing.camera_cut' and data -> 'payload' ->> 'sessionId' = ${sessionId}
    `);
    return row?.n ?? 0;
  });
}

async function firstAcceptedAt(sessionId: string): Promise<Date> {
  return withSystem(
    async (tx) => {
      const [row] = await tx.execute<{ at: Date }>(sql`
        select scanned_at as at from packing.scans
        where session_id = ${sessionId} and outcome = 'accepted' order by scanned_at limit 1
      `);
      if (row === undefined) throw new Error('no accepted scan');
      return new Date(row.at);
    },
    { orgId: ORG_A },
  );
}

/** A camera process of the test's own, its ffmpeg the stand-in. */
function cameraProcess(
  options: { bufferRoot: string; mode?: 'segments' | 'auth' | 'concat'; now?: () => number },
  log: RecorderLog = { info: () => undefined, warn: () => undefined, error: () => undefined },
): CameraProcessService {
  const service = new CameraProcessService(
    harness.app.get<FilesApi>(FILES_API, { strict: false }),
    new AuditService(),
  );
  service.configure({
    bufferRoot: options.bufferRoot,
    ffmpeg: fake.command(options.mode ?? 'concat'),
    log,
    cutPollMs: 100,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return service;
}

/** Footage in a camera's buffer: one-second segments covering [from, to]. */
async function footage(
  service: CameraProcessService,
  cameraId: string,
  fromMs: number,
  toMs: number,
): Promise<void> {
  const buffer = service.bufferFor(ORG_A, cameraId);
  await buffer.ensure();
  for (let start = fromMs; start < toMs; start += 1000) {
    await writeFile(path.join(buffer.dir, segmentName(start, start + 1000)), Buffer.alloc(2048, 9));
  }
}

const processes: CameraProcessService[] = [];
afterEach(async () => {
  for (const service of processes.splice(0)) await service.stopAll();
  delete process.env.FAKE_FFMPEG_ARGS;
});

beforeAll(async () => {
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_ROOT = await mkdtemp(path.join(tmpdir(), 'elysium-camera-files-'));
  resetFilesEnv();
  fake = await fakeFfmpeg();

  harness = await startHttpHarness('pack-camera');
  await applyOrderMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [...FILES_QUEUE_DEFINITIONS, ...PACKING_QUEUE_DEFINITIONS],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });

  admin = await harness.asRole('org_admin', ORG_A);
  packer = await harness.asRole('warehouse', ORG_A);
  sales = await harness.asRole('sales', ORG_A);
  adminB = await harness.asRole('org_admin', ORG_B);

  const shirt = await seedProductWithSkus(ORG_A, `cs${suffix}`, 2);
  [shirtM, shirtL] = (await withBarcodes(shirt.skus)) as [Sku, Sku];
  const caps = await seedProductWithSkus(ORG_A, `cc${suffix}`, 1);
  [cap] = (await withBarcodes(caps.skus)) as [Sku];
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711000444', name: 'Rahim Uddin' });
}, 300_000);

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

describe('IP camera settings (D-668, D-669)', () => {
  it('seals the password, never returns it, and shows only that it is set', async () => {
    const id = await addCamera(`Table ${suffix}`);
    const listed = await call(admin, 'GET', '/v1/packing/cameras');
    expect(listed.status).toBe(200);
    const camera = (listed.body.cameras as Json[]).find((entry) => entry.id === id);
    expect(camera).toMatchObject({
      name: `Table ${suffix}`,
      rtspUrl: 'rtsp://192.168.20.111:554/stream1',
      username: 'packing',
      enabled: true,
      passwordSet: true,
      state: 'offline',
    });
    expect(String(camera?.passwordFingerprint)).toMatch(/^[0-9a-f]{12}$/);
    expect(JSON.stringify(listed.body)).not.toContain(PASSWORD);

    // At rest: ciphertext, not the password.
    const stored = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ sealed: Buffer; key_id: string }>(sql`
            select password_sealed as sealed, key_id from packing.cameras where id = ${id}
          `)
        )[0],
      { orgId: ORG_A },
    );
    expect(Buffer.from(stored?.sealed ?? []).includes(Buffer.from(PASSWORD))).toBe(false);
    expect(stored?.key_id).toBeTruthy();

    // The audit says a password was set; it never says which.
    const audit = await withSystem(
      async (tx) =>
        tx.execute<{ entry: string }>(sql`
          select row_to_json(a)::text as entry from audit.audit_log a
          where org_id = ${ORG_A} and entity_id = ${id}
        `),
      { orgId: ORG_A },
    );
    expect(audit.length).toBeGreaterThan(0);
    for (const row of audit) expect(row.entry).not.toContain(PASSWORD);

    // Keep, replace, remove.
    const kept = await call(admin, 'PUT', `/v1/packing/cameras/${id}`, {
      name: `Table ${suffix}`,
      rtspUrl: 'rtsp://192.168.20.111:554/stream2',
      username: 'packing',
      enabled: true,
    });
    expect(kept.body).toMatchObject({
      passwordSet: true,
      rtspUrl: 'rtsp://192.168.20.111:554/stream2',
    });
    expect(kept.body.passwordFingerprint).toBe(camera?.passwordFingerprint);
    const replaced = await call(admin, 'PUT', `/v1/packing/cameras/${id}`, {
      name: `Table ${suffix}`,
      rtspUrl: 'rtsp://192.168.20.111:554/stream1',
      username: 'packing',
      password: 'another one',
      enabled: true,
    });
    expect(replaced.body.passwordFingerprint).not.toBe(camera?.passwordFingerprint);
    const removed = await call(admin, 'PUT', `/v1/packing/cameras/${id}`, {
      name: `Table ${suffix}`,
      rtspUrl: 'rtsp://192.168.20.111:554/stream1',
      username: 'packing',
      password: null,
      enabled: false,
    });
    expect(removed.body).toMatchObject({
      passwordSet: false,
      passwordFingerprint: null,
      enabled: false,
    });
  });

  it('lets only an org admin change cameras, shows packers names and states only, and keeps brands apart', async () => {
    const id = await addCamera(`Desk ${suffix}`);
    const body = { name: 'X', rtspUrl: 'rtsp://10.0.0.9/stream1', enabled: true };
    expect((await call(packer, 'POST', '/v1/packing/cameras', body)).status).toBe(403);
    expect((await call(packer, 'PUT', `/v1/packing/cameras/${id}`, body)).status).toBe(403);
    expect((await call(sales, 'POST', '/v1/packing/cameras', body)).status).toBe(403);

    const seen = await call(packer, 'GET', '/v1/packing/cameras');
    expect(seen.status).toBe(200);
    const camera = (seen.body.cameras as Json[]).find((entry) => entry.id === id);
    expect(camera).toMatchObject({ id, name: `Desk ${suffix}`, state: 'offline' });
    expect(camera).not.toHaveProperty('rtspUrl');
    expect(camera).not.toHaveProperty('username');
    expect(camera).not.toHaveProperty('passwordFingerprint');
    expect(seen.body.canEdit).toBe(false);

    // Another brand neither sees nor changes it.
    const other = await call(adminB, 'GET', '/v1/packing/cameras');
    expect((other.body.cameras as Json[]).some((entry) => entry.id === id)).toBe(false);
    expect((await call(adminB, 'PUT', `/v1/packing/cameras/${id}`, body)).status).toBe(404);
  });

  it('refuses credentials inside the address and a name already used', async () => {
    const inside = await call(admin, 'POST', '/v1/packing/cameras', {
      name: `Leak ${suffix}`,
      rtspUrl: 'rtsp://admin:secret@192.168.20.111:554/stream1',
    });
    expect(inside.status).toBe(400);
    expect(JSON.stringify(inside.body)).toMatch(/own fields/);
    await addCamera(`Twin ${suffix}`, null);
    const twin = await call(admin, 'POST', '/v1/packing/cameras', {
      name: `Twin ${suffix}`,
      rtspUrl: 'rtsp://192.168.20.112/stream1',
    });
    expect(twin.status).toBe(409);
  });
});

describe('the recording window (D-670, D-671): the owner’s catch', () => {
  it('starts only at the first accepted scan, two seconds before it, never at a refused one', async () => {
    const cameraId = await addCamera(`Window ${suffix}`);
    const order = await confirmedOrder([{ sku: shirtM, qty: 2 }]);
    const opened = await call(packer, 'POST', '/v1/packing/sessions', {
      code: order.orderNo,
      cameraId,
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    const sessionId = String((opened.body.session as Json).id);
    expect(opened.body.session).toMatchObject({ cameraId, recordingFrom: null });

    // Camera ready, nothing recording: a wrong size, a wrong product and a stranger.
    expect((await scan(packer, sessionId, shirtL.barcode)).body.outcome).toBe('wrong_variant');
    expect((await scan(packer, sessionId, cap.barcode)).body.outcome).toBe('wrong_item');
    expect((await scan(packer, sessionId, 'NO-SUCH-CODE')).body.outcome).toBe('unknown_code');
    expect((await windowOf(sessionId)).recording_from).toBeNull();

    // The first correct piece starts it, two seconds before the scan.
    const first = await scan(packer, sessionId, shirtM.barcode);
    expect(first.body.outcome).toBe('accepted');
    const started = await windowOf(sessionId);
    const acceptedAt = await firstAcceptedAt(sessionId);
    expect(new Date(started.recording_from ?? 0).getTime()).toBe(
      acceptedAt.getTime() - PACKING_CAMERA_PREROLL_MS,
    );
    expect(started.recording_by).toBe(packer.userId);
    expect((first.body.view as Json).session).toMatchObject({
      recordingFrom: new Date(started.recording_from ?? 0).toISOString(),
    });

    // Later scans, accepted or refused, never move it; the camera is fixed now.
    expect((await scan(packer, sessionId, shirtM.barcode)).body.outcome).toBe('accepted');
    expect((await scan(packer, sessionId, shirtM.barcode)).body.outcome).toBe('over');
    expect((await windowOf(sessionId)).recording_from).toEqual(started.recording_from);
    const other = await addCamera(`Other ${suffix}`);
    const reopened = await call(packer, 'POST', '/v1/packing/sessions', {
      orderId: order.id,
      cameraId: other,
    });
    expect(reopened.body.session).toMatchObject({ cameraId });

    // The finish ends it and enqueues the cut, in the same transaction.
    expect(await cutJobs(sessionId)).toBe(0);
    const done = await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/complete`);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const ended = await windowOf(sessionId);
    expect(new Date(ended.recording_to ?? 0).getTime()).toBe(
      new Date(ended.completed_at ?? 0).getTime(),
    );
    expect(await cutJobs(sessionId)).toBe(1);
  });

  it('never records a packing whose only scans were refused, and enqueues nothing for it', async () => {
    const cameraId = await addCamera(`Refused ${suffix}`);
    const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
    const sessionId = String(
      (
        (await call(packer, 'POST', '/v1/packing/sessions', { orderId: order.id, cameraId })).body
          .session as Json
      ).id,
    );
    for (const code of [shirtM.barcode, shirtL.barcode, 'NOPE'])
      await scan(packer, sessionId, code);
    expect((await windowOf(sessionId)).recording_from).toBeNull();
    expect(await cutJobs(sessionId)).toBe(0);
  });

  it('records with the desk’s own camera when none is chosen, and refuses a camera that is off', async () => {
    const off = await addCamera(`Off ${suffix}`);
    await call(admin, 'PUT', `/v1/packing/cameras/${off}`, {
      name: `Off ${suffix}`,
      rtspUrl: 'rtsp://192.168.20.111:554/stream1',
      username: 'packing',
      enabled: false,
    });
    const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
    const refused = await call(packer, 'POST', '/v1/packing/sessions', {
      orderId: order.id,
      cameraId: off,
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('PACKING_CAMERA_INVALID');
    const own = await call(packer, 'POST', '/v1/packing/sessions', {
      orderId: order.id,
      cameraId: null,
    });
    const sessionId = String((own.body.session as Json).id);
    await scan(packer, sessionId, cap.barcode);
    expect((await windowOf(sessionId)).recording_from).toBeNull();
    expect((await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/complete`)).status).toBe(
      200,
    );
    expect(await cutJobs(sessionId)).toBe(0);
  });

  it('holds the window in the database: set once, inside fifteen minutes, never by hand afterwards', async () => {
    const cameraId = await addCamera(`Triggers ${suffix}`);
    const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
    const sessionId = String(
      (
        (await call(packer, 'POST', '/v1/packing/sessions', { orderId: order.id, cameraId })).body
          .session as Json
      ).id,
    );
    await scan(packer, sessionId, cap.barcode);
    const refusal = async (statement: ReturnType<typeof sql>) => {
      try {
        await withSystem((tx) => tx.execute(statement), { orgId: ORG_A });
      } catch (error) {
        const words: string[] = [];
        for (let current: unknown = error; current instanceof Error; current = current.cause) {
          words.push(current.message);
        }
        return words.join(' | ');
      }
      return 'not refused';
    };
    expect(
      await refusal(
        sql`update packing.sessions set recording_from = now() where id = ${sessionId}`,
      ),
    ).toMatch(/set once/);
    expect(
      await refusal(sql`update packing.sessions set camera_id = null where id = ${sessionId}`),
    ).toMatch(/fixed once it records|recording_camera/);
    expect(
      await refusal(
        sql`update packing.sessions set recording_to = recording_from + interval '20 minutes' where id = ${sessionId}`,
      ),
    ).toMatch(/recording_window/);
  });
});

describe('the camera process (D-672, D-673)', () => {
  it('closes a recording left open at fifteen minutes and enqueues its cut', async () => {
    const cameraId = await addCamera(`Timeout ${suffix}`);
    const order = await confirmedOrder([{ sku: shirtM, qty: 2 }]);
    const sessionId = String(
      (
        (await call(packer, 'POST', '/v1/packing/sessions', { orderId: order.id, cameraId })).body
          .session as Json
      ).id,
    );
    await scan(packer, sessionId, shirtM.barcode);
    const from = new Date((await windowOf(sessionId)).recording_from ?? 0).getTime();

    const early = cameraProcess({
      bufferRoot: await mkdtemp(path.join(tmpdir(), 'erp-cam-')),
      now: () => from + PACKING_CAMERA_MAX_MS - 1_000,
    });
    await early.closeTimedOut();
    expect((await windowOf(sessionId)).recording_to).toBeNull();

    const late = cameraProcess({
      bufferRoot: await mkdtemp(path.join(tmpdir(), 'erp-cam-')),
      now: () => from + PACKING_CAMERA_MAX_MS + 60_000,
    });
    expect(await late.closeTimedOut()).toBeGreaterThanOrEqual(1);
    expect(new Date((await windowOf(sessionId)).recording_to ?? 0).getTime()).toBe(
      from + PACKING_CAMERA_MAX_MS,
    );
    expect(await cutJobs(sessionId)).toBe(1);
    // Finishing afterwards keeps the fifteen minutes and enqueues nothing more.
    await scan(packer, sessionId, shirtM.barcode);
    expect((await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/complete`)).status).toBe(
      200,
    );
    expect(new Date((await windowOf(sessionId)).recording_to ?? 0).getTime()).toBe(
      from + PACKING_CAMERA_MAX_MS,
    );
    expect(await cutJobs(sessionId)).toBe(1);
  });

  it('cuts the window into a private packing video, filed under the packer, that plays like any other', async () => {
    const cameraId = await addCamera(`Cut ${suffix}`);
    const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
    const sessionId = String(
      (
        (await call(packer, 'POST', '/v1/packing/sessions', { orderId: order.id, cameraId })).body
          .session as Json
      ).id,
    );
    await scan(packer, sessionId, cap.barcode);
    await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/complete`);
    const window = await windowOf(sessionId);
    const from = new Date(window.recording_from ?? 0).getTime();
    const to = new Date(window.recording_to ?? 0).getTime();

    const bufferRoot = await mkdtemp(path.join(tmpdir(), 'erp-cam-'));
    const service = cameraProcess({ bufferRoot });
    processes.push(service);
    // The buffer holds from ten seconds before the window to five after it.
    await footage(service, cameraId, from - 10_000, to + 5_000);
    expect(await service.cut(ORG_A, sessionId)).toBe('cut');
    // Done once: a retried job changes nothing.
    expect(await service.cut(ORG_A, sessionId)).toBe('already');

    const record = await call(admin, 'GET', `/v1/packing/orders/${order.id}`);
    expect(record.status).toBe(200);
    const videos = record.body.videos as Json[];
    expect(videos).toHaveLength(1);
    expect(videos[0]).toMatchObject({
      state: 'uploaded',
      mime: 'video/mp4',
      source: 'camera',
      cameraId,
      recordedBy: { id: packer.userId },
    });
    expect(new Date(String(videos[0]?.startedAt)).getTime()).toBeLessThanOrEqual(from);
    expect(record.body.video).toBe('uploaded');

    // The file is a private packing video, owned by the packer, played through a signed URL.
    const fileRow = await withSystem(
      async (tx) =>
        (
          await tx.execute<{ purpose: string; visibility: string; status: string; owner: string }>(
            sql`
              select f.purpose, f.visibility::text as visibility, f.status::text as status,
                     f.owner_user_id as owner
              from packing.videos v join files.objects f on f.org_id = v.org_id and f.id = v.file_id
              where v.session_id = ${sessionId}
            `,
          )
        )[0],
      { orgId: ORG_A },
    );
    expect(fileRow).toEqual({
      purpose: 'packing-video',
      visibility: 'private',
      status: 'stored',
      owner: packer.userId,
    });
    const played = await call(admin, 'GET', `/v1/packing/videos/${String(videos[0]?.id)}/url`);
    expect(played.status, JSON.stringify(played.body)).toBe(200);
    expect(played.body.mime).toBe('video/mp4');
    expect(
      (await call(sales, 'GET', `/v1/packing/videos/${String(videos[0]?.id)}/url`)).status,
    ).toBe(404);

    // The cut is audited, and the window's footage is free to go now.
    const audits = await withSystem(
      async (tx) =>
        tx.execute<{ action: string }>(sql`
          select action from audit.audit_log where entity_id = ${sessionId}
            and action = 'packing.camera_video_cut'
        `),
      { orgId: ORG_A },
    );
    expect(audits).toHaveLength(1);
    // Cut and filed, the window waits for nothing: five minutes on, its footage is gone.
    const later = cameraProcess({ bufferRoot, now: () => to + 5 * 60_000 });
    later.bufferFor(ORG_A, cameraId);
    expect(await later.prune()).toBeGreaterThan(0);
    expect(await later.bufferFor(ORG_A, cameraId).segments()).toEqual([]);
  });

  it('keeps a waiting window’s footage when it prunes, and says so when there is none to cut', async () => {
    const cameraId = await addCamera(`Prune ${suffix}`);
    const order = await confirmedOrder([{ sku: cap, qty: 1 }]);
    const sessionId = String(
      (
        (await call(packer, 'POST', '/v1/packing/sessions', { orderId: order.id, cameraId })).body
          .session as Json
      ).id,
    );
    await scan(packer, sessionId, cap.barcode);
    const from = new Date((await windowOf(sessionId)).recording_from ?? 0).getTime();

    // Ten minutes on, the window still open: the buffer keeps it from its start.
    const service = cameraProcess({
      bufferRoot: await mkdtemp(path.join(tmpdir(), 'erp-cam-')),
      now: () => from + 10 * 60_000,
    });
    processes.push(service);
    await footage(service, cameraId, from - 120_000, from + 10 * 60_000);
    await service.prune();
    const kept = await service.bufferFor(ORG_A, cameraId).segments();
    expect(kept.some((segment) => segment.startMs <= from && segment.endMs > from)).toBe(true);
    expect(kept.every((segment) => segment.endMs >= from)).toBe(true);
    expect(kept.length).toBeLessThan(700);

    // A finished packing whose camera filmed nothing: the cut says so and files nothing.
    await call(packer, 'POST', `/v1/packing/sessions/${sessionId}/complete`);
    // The cut waits for footage a few seconds; a clock that runs fast keeps the test short.
    let skew = 0;
    const empty = cameraProcess({
      bufferRoot: await mkdtemp(path.join(tmpdir(), 'erp-cam-')),
      now: () => Date.now() + (skew += 2_000),
    });
    processes.push(empty);
    const waited = Date.now();
    expect(await empty.cut(ORG_A, sessionId)).toBe('no_footage');
    expect(Date.now() - waited).toBeLessThan(10_000);
    const record = await call(admin, 'GET', `/v1/packing/orders/${order.id}`);
    expect(record.body.videos).toEqual([]);
  });

  it('records each enabled camera with its opened password, reports it ready, and never logs the password', async () => {
    const cameraId = await addCamera(`Live ${suffix}`);
    const argsFile = path.join(fake.dir, `args-live-${suffix}.jsonl`);
    process.env.FAKE_FFMPEG_ARGS = argsFile;
    const lines: string[] = [];
    const keep = (fields: Record<string, unknown>, message: string) => {
      lines.push(`${message} ${JSON.stringify(fields)}`);
    };
    const service = cameraProcess(
      { bufferRoot: await mkdtemp(path.join(tmpdir(), 'erp-cam-')), mode: 'segments' },
      { info: keep, warn: keep, error: keep },
    );
    processes.push(service);
    await service.reload();
    expect(service.recording()).toContain(cameraId);
    const deadline = Date.now() + 10_000;
    for (;;) {
      await service.reportAll();
      const listed = await call(packer, 'GET', '/v1/packing/cameras');
      const state = (listed.body.cameras as Json[]).find((entry) => entry.id === cameraId)?.state;
      if (state === 'ready') break;
      if (Date.now() > deadline) throw new Error(`camera never became ready (${String(state)})`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const given = (await readFile(argsFile, 'utf8'))
      .split('\n')
      .filter((line) => line.includes('192.168.20.111'));
    expect(given.join('\n')).toContain(`packing:${encodeURIComponent(PASSWORD)}@192.168.20.111`);
    expect(lines.join('\n')).not.toContain(PASSWORD);
    expect(lines.join('\n')).not.toContain(encodeURIComponent(PASSWORD));

    // Switched off in the settings: the next reload stops it.
    await call(admin, 'PUT', `/v1/packing/cameras/${cameraId}`, {
      name: `Live ${suffix}`,
      rtspUrl: 'rtsp://192.168.20.111:554/stream1',
      username: 'packing',
      enabled: false,
    });
    await service.reload();
    expect(service.recording()).not.toContain(cameraId);
  });
});
