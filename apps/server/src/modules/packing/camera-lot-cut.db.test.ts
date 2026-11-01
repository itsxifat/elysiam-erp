import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { withGlobal, withSystem } from '@elysium/db';
import { PACKING_CAMERA_MAX_MS } from '@elysium/domain/packing';
import { sql } from 'drizzle-orm';
import pino from 'pino';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { AuditableRequest } from '../../platform/audit/audit.interceptor.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { attachScope } from '../../platform/auth/scope.js';
import type { ActiveContext } from '../../platform/http/context.js';
import { JobsRuntime } from '../../platform/jobs/jobs.runtime.js';
import { fakeFfmpeg } from '../../testing/fake-ffmpeg.js';
import { ORG_A, startHttpHarness, type HttpHarness } from '../../testing/http-harness.js';
import { FILES_API, type FilesApi } from '../files/files.api.js';
import { resetFilesEnv } from '../files/files.config.js';
import { FILES_QUEUE_DEFINITIONS } from '../files/files.queues.js';
import { seedProductWithSkus } from '../inventory/inventory.testing.js';
import { applyOrderMigrations, seedCustomer, seedOrder } from '../orders/orders.testing.js';
import { CameraProcessService } from './camera/camera-process.service.js';
import { segmentName } from './camera/segment-buffer.js';
import { PACKING_QUEUE_DEFINITIONS } from './packing.queues.js';
import { PackStationService } from './station.service.js';

/**
 * An IP camera's video of one lot, cut along its stretches, on real Postgres (M51, D-931, D-932).
 *
 * The pause on an IP camera is the cut: the camera never stops, so the video must hold only the
 * segments the scans mark. The buffer here is real files, one per second, and only the join is
 * the fake ffmpeg, so what is asserted is exactly which seconds of footage were picked:
 *
 * 1. A gap with no scan past the idle time is left out of the one video; the lead before each
 *    resume and the tail after each stretch are in it.
 * 2. Each lot has its own video, filed under its recording and lot; the terminal's other camera
 *    gets its own copy of each.
 * 3. A recording still running is not cut; a retry files nothing twice; the buffer keeps what an
 *    uncut recording needs and lets it go once it is cut.
 * 4. A recording an IP camera films stops at its fifteen minutes, with its cut queued.
 * 5. Through the station's own scans: the label stops the recording and queues the cut, for the
 *    recording and for the terminal's other camera.
 */

const PACKER = `usr_m51c_${randomUUID().slice(0, 8)}`;
/** The fake ffmpeg's join writes one MP4 header before the segments. */
const SEGMENT_BYTES = 2048;

let harness: HttpHarness;
let jobs: JobsRuntime | undefined;
let fake: Awaited<ReturnType<typeof fakeFfmpeg>>;
let customerId = '';
let sku = { id: '', code: '' };
const services: CameraProcessService[] = [];

function context(): ActiveContext {
  return {
    orgId: ORG_A,
    userId: PACKER,
    isSuperAdmin: false,
    roles: ['org_admin'],
    branchIds: [],
    branchIdsByRole: {},
    requestId: 'm51-camera-cut',
  };
}

function request(): AuditableRequest {
  const value = {} as AuditableRequest;
  attachScope(value, 'update', 'Order', { kind: 'all' });
  return value;
}

const system = <T>(work: Parameters<typeof withSystem<T>>[0]) => withSystem(work, { orgId: ORG_A });

async function cameraProcess(now?: () => number): Promise<CameraProcessService> {
  const service = new CameraProcessService(
    harness.app.get<FilesApi>(FILES_API, { strict: false }),
    new AuditService(),
  );
  service.configure({
    bufferRoot: await mkdtemp(path.join(tmpdir(), 'erp-m51-cam-')),
    ffmpeg: fake.command('concat'),
    log: { info: () => undefined, warn: () => undefined, error: () => undefined },
    cutPollMs: 100,
    freeBytes: () => Promise.resolve(Number.MAX_SAFE_INTEGER),
    ...(now === undefined ? {} : { now }),
  });
  services.push(service);
  return service;
}

/** Footage in a camera's buffer: one-second segments covering [from, to). */
async function footage(
  service: CameraProcessService,
  cameraId: string,
  fromMs: number,
  toMs: number,
): Promise<void> {
  const buffer = service.bufferFor(ORG_A, cameraId);
  await buffer.ensure();
  for (let start = fromMs; start < toMs; start += 1000) {
    await writeFile(
      path.join(buffer.dir, segmentName(start, start + 1000)),
      Buffer.alloc(SEGMENT_BYTES, 9),
    );
  }
}

async function addCamera(): Promise<string> {
  return system(async (tx) => {
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into packing.cameras (org_id, name, rtsp_url, username, enabled, created_by, updated_by)
      values (${ORG_A}, ${`M51 ${randomUUID().slice(0, 8)}`}, 'rtsp://192.168.20.111:554/stream1',
              'packing', true, ${PACKER}, ${PACKER})
      returning id
    `);
    return row?.id ?? '';
  });
}

/** A packing session filmed by `cameraId`, with `others` of the terminal beside it. */
async function filmedSession(cameraId: string, others: readonly string[] = [], lots = 1) {
  const order = await seedOrder(ORG_A, {
    status: 'confirmed',
    customerId,
    createdBy: PACKER,
    lines: [
      { skuId: sku.id, skuCode: sku.code, productName: 'A shirt', qty: 5, unitPricePoisha: 100n },
    ],
  });
  const sessionId = await system(async (tx) => {
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into packing.sessions
        (org_id, order_id, order_no, video_required, started_by, camera_id)
      values (${ORG_A}, ${order.id}, ${order.orderNo}, true, ${PACKER}, ${cameraId})
      returning id
    `);
    for (const other of others) {
      await tx.execute(sql`
        insert into packing.session_cameras (org_id, session_id, camera_id)
        values (${ORG_A}, ${row?.id ?? ''}, ${other})
      `);
    }
    if (lots > 1) {
      await tx.execute(sql`
        insert into packing.order_lots (org_id, order_id, lot_count, set_by)
        values (${ORG_A}, ${order.id}, ${lots}, ${PACKER})
      `);
    }
    return row?.id ?? '';
  });
  return { order, sessionId };
}

/** Each lot's label printed, as the station needs before a label starts a lot (D-928, D-942). */
async function labelsPrinted(order: { id: string; orderNo: string }, lots: number): Promise<void> {
  await system(async (tx) => {
    const [terminal] = await tx.execute<{ id: string }>(sql`
      insert into packing.terminals (org_id, kind, name, created_by, updated_by)
      values (${ORG_A}, 'label', ${`Cut ${randomUUID().slice(0, 8)}`}, ${PACKER}, ${PACKER})
      returning id
    `);
    const [printer] = await tx.execute<{ id: string }>(sql`
      insert into packing.printers
        (org_id, terminal_id, name, connection, language, medium, width_um, height_um,
         documents, created_by, updated_by)
      values (${ORG_A}, ${terminal?.id ?? ''}, ${`Cut ${randomUUID().slice(0, 8)}`}, 'browser', 'pdf',
              '4x6', 101600, 152400, array['label']::text[], ${PACKER}, ${PACKER})
      returning id
    `);
    for (let lot = 1; lot <= lots; lot += 1) {
      await tx.execute(sql`
        insert into packing.print_jobs
          (org_id, order_id, order_no, document, lot_no, lot_count, printer_id, terminal_id,
           source, requested_by, consignment_no, state, printed_at)
        values (${ORG_A}, ${order.id}, ${order.orderNo}, 'label', ${lot}, ${lots},
                ${printer?.id ?? ''}, ${terminal?.id ?? ''}, 'manual', ${PACKER},
                ${`CN-${order.orderNo}`}, 'printed', now())
      `);
    }
  });
}

/**
 * A lot's recording as a person would have made it at the given instants: the label at `startMs`,
 * a piece at each of `piecesMs`, and, when `stopMs` is given, the label again then.
 */
async function recorded(input: {
  readonly sessionId: string;
  readonly cameraId: string;
  readonly lot?: number;
  readonly startMs: number;
  readonly piecesMs: readonly number[];
  readonly stopMs: number | null;
}): Promise<string> {
  const lot = input.lot ?? 1;
  const iso = (ms: number) => new Date(ms).toISOString();
  return system(async (tx) => {
    const scan = async (atMs: number, outcome: 'label' | 'accepted') => {
      await tx.execute(sql`
        insert into packing.scans
          (org_id, session_id, scan_id, code, sku_id, outcome, scanned_by, scanned_at, lot_no)
        values (${ORG_A}, ${input.sessionId}, ${randomUUID()}, 'code',
                ${outcome === 'label' ? null : sku.id}::uuid, ${outcome}, ${PACKER},
                ${iso(atMs)}::timestamptz, ${lot})
      `);
    };
    await scan(input.startMs, 'label');
    const [row] = await tx.execute<{ id: string }>(sql`
      insert into packing.recordings
        (org_id, session_id, lot_no, video_required, camera_id, idle_ms, started_at, started_by)
      values (${ORG_A}, ${input.sessionId}, ${lot}, true, ${input.cameraId}, 10000,
              ${iso(input.startMs)}::timestamptz, ${PACKER})
      returning id
    `);
    for (const at of input.piecesMs) await scan(at, 'accepted');
    if (input.stopMs !== null) {
      await scan(input.stopMs, 'label');
      await tx.execute(sql`
        update packing.recordings
           set stopped_at = ${iso(input.stopMs)}::timestamptz, stopped_by = ${PACKER},
               stop_reason = 'label'
         where id = ${row?.id ?? ''}
      `);
    }
    return row?.id ?? '';
  });
}

const videosOf = (sessionId: string) =>
  system(async (tx) => [
    ...(await tx.execute<{
      part: number;
      lot_no: number;
      recording_id: string;
      camera_id: string;
      source: string;
      duration_ms: number;
      size_bytes: string;
      file_id: string | null;
    }>(sql`
      select part, lot_no, recording_id, camera_id, source, duration_ms,
             size_bytes::text as size_bytes, file_id
      from packing.videos where session_id = ${sessionId} order by part
    `)),
  ]);

const cutJobs = (sessionId: string) =>
  withSystem(async (tx) => [
    ...(await tx.execute<{ recording_id: string | null; camera_id: string | null }>(sql`
      select data -> 'payload' ->> 'recordingId' as recording_id,
             data -> 'payload' ->> 'cameraId' as camera_id
      from pgboss.job
      where name = 'packing.camera_cut' and data -> 'payload' ->> 'sessionId' = ${sessionId}
    `)),
  ]);

/** A whole second, some minutes back: what the buffer's one-second segments line up with. */
const aSecondAgo = (minutes: number) => Math.floor((Date.now() - minutes * 60_000) / 1000) * 1000;

beforeAll(async () => {
  process.env.STORAGE_DRIVER = 'local';
  process.env.STORAGE_LOCAL_ROOT = await mkdtemp(path.join(tmpdir(), 'elysium-m51-files-'));
  resetFilesEnv();
  fake = await fakeFfmpeg();
  harness = await startHttpHarness('m51-camera-cut');
  await applyOrderMigrations();
  jobs = await JobsRuntime.start({
    role: 'worker',
    connectionString: harness.database.ownerUrl,
    appRole: 'erp_app',
    queues: [...FILES_QUEUE_DEFINITIONS, ...PACKING_QUEUE_DEFINITIONS],
    logger: pino({ level: 'silent' }),
    pollingIntervalSeconds: 0.5,
  });
  await withGlobal(async (tx) => {
    await tx.execute(sql`
      insert into iam.users (id, email, name, email_verified)
      values (${PACKER}, ${`${PACKER}@example.invalid`}, 'M51 packer', true)
      on conflict (id) do nothing
    `);
  });
  const product = await seedProductWithSkus(ORG_A, `m51c${randomUUID().slice(0, 6)}`, 1);
  sku = product.skus[0] as { id: string; code: string };
  customerId = await seedCustomer(ORG_A, { phoneE164: '+8801711000953', name: 'M51 buyer' });
}, 420_000);

afterEach(async () => {
  for (const service of services.splice(0)) await service.stopAll();
});

afterAll(async () => {
  await jobs?.stop();
  await harness?.close();
}, 60_000);

describe('the pause, on an IP camera (D-931)', () => {
  it('leaves the gap out of the one video, keeping each resume’s lead and each stretch’s tail', async () => {
    const cameraId = await addCamera();
    const { sessionId } = await filmedSession(cameraId);
    const t0 = aSecondAgo(5);
    // The label, a piece 4 s on, then nothing for 26 s (past the ten of the idle time), a piece at
    // 30 s, and the label again at 36 s.
    const recordingId = await recorded({
      sessionId,
      cameraId,
      startMs: t0,
      piecesMs: [t0 + 4_000, t0 + 30_000],
      stopMs: t0 + 36_000,
    });
    const service = await cameraProcess();
    // The camera never stopped: the buffer holds all of it, and more on either side.
    await footage(service, cameraId, t0 - 10_000, t0 + 45_000);

    expect(await service.cut(ORG_A, sessionId, undefined, recordingId)).toBe('cut');

    const [video, ...others] = await videosOf(sessionId);
    expect(others).toEqual([]);
    expect(video).toMatchObject({ source: 'camera', camera_id: cameraId, lot_no: 1 });
    expect(video?.recording_id).toBe(recordingId);
    expect(video?.file_id).not.toBeNull();
    /*
     * The stretches: t0 - 2 s (the lead) to t0 + 14 s (the last piece's ten seconds), and t0 + 28 s
     * (the lead before the resume) to t0 + 36 s. Each with the one-second tail: 17 + 9 = 26 seconds
     * of footage out of the 39 from the first lead to the stop's tail. The 13 seconds in between,
     * with nobody scanning, are not in the video.
     */
    expect(video?.duration_ms).toBe(26_000);
    const bytes = Number(video?.size_bytes);
    expect(bytes).toBeGreaterThanOrEqual(26 * SEGMENT_BYTES);
    expect(bytes).toBeLessThan(27 * SEGMENT_BYTES);

    const audit = await system(async (tx) => {
      const [row] = await tx.execute<{ after: { stretches: number; gapMs: number } }>(sql`
        select after from audit.audit_log
         where entity_id = ${sessionId} and action = 'packing.camera_video_cut'
      `);
      return row?.after;
    });
    // Two stretches; and a pause is not reported as footage the camera failed to deliver.
    expect(audit).toMatchObject({ stretches: 2, gapMs: 0 });
  });

  it('keeps one unbroken stretch while every scan comes within the idle time', async () => {
    const cameraId = await addCamera();
    const { sessionId } = await filmedSession(cameraId);
    const t0 = aSecondAgo(5);
    const recordingId = await recorded({
      sessionId,
      cameraId,
      startMs: t0,
      piecesMs: [t0 + 8_000, t0 + 16_000],
      stopMs: t0 + 24_000,
    });
    const service = await cameraProcess();
    await footage(service, cameraId, t0 - 5_000, t0 + 30_000);
    expect(await service.cut(ORG_A, sessionId, undefined, recordingId)).toBe('cut');
    // From the lead to the stop's tail, every second: 2 + 24 + 1.
    expect((await videosOf(sessionId))[0]?.duration_ms).toBe(27_000);
  });
});

describe('one video per lot (D-932)', () => {
  it('files each lot under its own recording, for each of the terminal’s cameras', async () => {
    const first = await addCamera();
    const second = await addCamera();
    const { sessionId } = await filmedSession(first, [second], 2);
    const t0 = aSecondAgo(5);
    const lot1 = await recorded({
      sessionId,
      cameraId: first,
      lot: 1,
      startMs: t0,
      piecesMs: [t0 + 2_000],
      stopMs: t0 + 4_000,
    });
    const lot2 = await recorded({
      sessionId,
      cameraId: first,
      lot: 2,
      startMs: t0 + 60_000,
      piecesMs: [t0 + 62_000],
      stopMs: t0 + 66_000,
    });
    const service = await cameraProcess();
    await footage(service, first, t0 - 5_000, t0 + 70_000);
    await footage(service, second, t0 - 5_000, t0 + 70_000);

    expect(await service.cut(ORG_A, sessionId, undefined, lot1)).toBe('cut');
    expect(await service.cut(ORG_A, sessionId, second, lot1)).toBe('cut');
    expect(await service.cut(ORG_A, sessionId, undefined, lot2)).toBe('cut');
    expect(await service.cut(ORG_A, sessionId, second, lot2)).toBe('cut');

    const videos = await videosOf(sessionId);
    expect(videos.map((video) => [video.lot_no, video.recording_id, video.camera_id])).toEqual([
      [1, lot1, first],
      [1, lot1, second],
      [2, lot2, first],
      [2, lot2, second],
    ]);
    // Lot 1's video holds nothing of lot 2's minute: from its lead to its stop's tail, 7 seconds.
    expect(videos[0]?.duration_ms).toBe(7_000);
    expect(videos[2]?.duration_ms).toBe(9_000);
  });

  it('refuses a camera that does not film the session, and another lot’s recording', async () => {
    const cameraId = await addCamera();
    const stranger = await addCamera();
    const { sessionId } = await filmedSession(cameraId);
    const other = await filmedSession(cameraId);
    const t0 = aSecondAgo(5);
    const recordingId = await recorded({
      sessionId,
      cameraId,
      startMs: t0,
      piecesMs: [],
      stopMs: t0 + 3_000,
    });
    const service = await cameraProcess();
    expect(await service.cut(ORG_A, sessionId, stranger, recordingId)).toBe('nothing_to_cut');
    expect(await service.cut(ORG_A, other.sessionId, undefined, recordingId)).toBe(
      'nothing_to_cut',
    );
    expect(await videosOf(sessionId)).toEqual([]);
  });
});

describe('the cut and the buffer', () => {
  it('cuts nothing still running, files nothing twice, and keeps footage until it is cut', async () => {
    const cameraId = await addCamera();
    const { sessionId } = await filmedSession(cameraId);
    const t0 = aSecondAgo(10);
    const running = await recorded({
      sessionId,
      cameraId,
      startMs: t0,
      piecesMs: [t0 + 2_000],
      stopMs: null,
    });
    const service = await cameraProcess();
    await footage(service, cameraId, t0 - 10_000, t0 + 10_000);
    expect(await service.cut(ORG_A, sessionId, undefined, running)).toBe('nothing_to_cut');

    // Minutes old, past the one minute the buffer always keeps: it stays for the uncut recording,
    // from the lead before its start, and what came earlier goes.
    await service.prune();
    const kept = await service.bufferFor(ORG_A, cameraId).segments();
    expect(kept.some((segment) => segment.startMs === t0 - 2_000)).toBe(true);
    expect(kept.some((segment) => segment.endMs < t0 - 2_000)).toBe(false);

    await system((tx) =>
      tx.execute(sql`
        update packing.recordings
           set stopped_at = started_at + interval '4 seconds', stopped_by = ${PACKER},
               stop_reason = 'label'
         where id = ${running}
      `),
    );
    expect(await service.cut(ORG_A, sessionId, undefined, running)).toBe('cut');
    expect(await service.cut(ORG_A, sessionId, undefined, running)).toBe('already');
    expect(await videosOf(sessionId)).toHaveLength(1);

    // Cut and filed, nothing waits for it: the footage is free to go.
    await service.prune();
    expect(await service.bufferFor(ORG_A, cameraId).segments()).toEqual([]);
  });

  it('stops a recording at its fifteen minutes and queues its cut (D-933)', async () => {
    const cameraId = await addCamera();
    const { sessionId } = await filmedSession(cameraId);
    const t0 = aSecondAgo(16);
    const recordingId = await recorded({
      sessionId,
      cameraId,
      startMs: t0,
      piecesMs: [],
      stopMs: null,
    });
    const service = await cameraProcess();
    expect(await service.closeTimedOut()).toBeGreaterThanOrEqual(1);
    const row = await system(async (tx) => {
      const [found] = await tx.execute<{ stop_reason: string; stopped_ms: string }>(sql`
        select stop_reason, (extract(epoch from stopped_at) * 1000)::bigint::text as stopped_ms
        from packing.recordings where id = ${recordingId}
      `);
      return found;
    });
    expect(row?.stop_reason).toBe('timed_out');
    expect(Number(row?.stopped_ms)).toBe(t0 + PACKING_CAMERA_MAX_MS);
    expect(await cutJobs(sessionId)).toEqual([{ recording_id: recordingId, camera_id: null }]);
  });
});

describe('through the station’s own scans', () => {
  it('starts on the session’s camera at the label, and the label again queues its cuts', async () => {
    const first = await addCamera();
    const second = await addCamera();
    const { order, sessionId } = await filmedSession(first, [second], 2);
    await labelsPrinted(order, 2);
    const station = harness.app.get(PackStationService);
    const scan = (code: string) =>
      station.scan(context(), request(), sessionId, { scanId: randomUUID(), code });
    const barcode = `2${randomUUID().replace(/\D/g, '').padEnd(12, '0').slice(0, 12)}`;
    await system((tx) =>
      tx.execute(sql`update catalog.skus set barcode = ${barcode} where id = ${sku.id}`),
    );

    const started = await scan(order.orderNo);
    expect(started.label).toMatchObject({ action: 'started', lot: 1 });
    const recording = started.view.recordings[0];
    expect(recording).toMatchObject({ source: 'camera', cameraId: first, state: 'recording' });
    expect(await cutJobs(sessionId)).toEqual([]);

    expect((await scan(barcode)).outcome).toBe('accepted');
    // A different code from the first, so it is a person's scan however soon it comes.
    const closed = await scan(`${order.orderNo}-L1`);
    expect(closed.label).toMatchObject({ action: 'lot_closed', lot: 1 });

    const queued = await cutJobs(sessionId);
    expect(queued).toHaveLength(2);
    expect(queued).toEqual(
      expect.arrayContaining([
        { recording_id: recording?.id, camera_id: null },
        { recording_id: recording?.id, camera_id: second },
      ]),
    );
  });
});
