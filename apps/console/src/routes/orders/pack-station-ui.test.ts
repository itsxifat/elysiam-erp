import { describe, expect, it } from 'vitest';

import {
  RECORDING_LIMIT_MS,
  RECORDING_MAX_BYTES,
  VIDEO_BITS_PER_SECOND,
  chooseRecorderMime,
  containerOf,
  formatElapsed,
  formatMegabytes,
  isOrderSlip,
  outcomeTone,
  retryDelayMs,
  uploadDue,
  videoCaption,
} from './pack-logic.js';
import type { VideoPartAnswer, VideoUploadTicket } from './pack-station-api.js';
import { recordedMs, runUploadQueue, type UploadApi } from './pack-uploader.js';
import { memoryVideoStore, type StoredRecording } from './pack-video-store.js';

/**
 * The packing station's pure parts and its upload queue (M38b, D-610, D-611): which format the
 * recorder asks for, the caption on the video, the slip that finishes the box, and recordings
 * that stay in the browser until the server has them.
 */

describe('the recorder’s format', () => {
  it('asks for VP8 WebM first, then any WebM, then MP4, and gives up when there is none', () => {
    expect(chooseRecorderMime(() => true)).toBe('video/webm;codecs=vp8');
    expect(chooseRecorderMime((mime) => mime === 'video/webm')).toBe('video/webm');
    // Safari records MP4 only.
    expect(chooseRecorderMime((mime) => mime.startsWith('video/mp4'))).toBe(
      'video/mp4;codecs=avc1',
    );
    expect(chooseRecorderMime(() => false)).toBeNull();
    expect(
      chooseRecorderMime(() => {
        throw new Error('unsupported');
      }),
    ).toBeNull();
  });

  it('stores a recorder format as its container', () => {
    expect(containerOf('video/webm;codecs=vp8')).toBe('video/webm');
    expect(containerOf('video/mp4;codecs=avc1')).toBe('video/mp4');
    expect(containerOf('VIDEO/MP4')).toBe('video/mp4');
  });

  it('fits fifteen minutes at the bit rate under the upload ceiling and Cloudflare’s 100 MB', () => {
    const fifteenMinutes = (VIDEO_BITS_PER_SECOND / 8) * (RECORDING_LIMIT_MS / 1000);
    expect(fifteenMinutes).toBeLessThan(RECORDING_MAX_BYTES);
    expect(RECORDING_MAX_BYTES).toBeLessThan(90 * 1024 * 1024);
    expect(RECORDING_MAX_BYTES).toBeLessThan(100_000_000);
  });
});

describe('the caption on every frame', () => {
  it('names the order, the Dhaka date and time to the second, and the packer', () => {
    // 20:05:09 UTC is 02:05:09 the next day in Dhaka.
    const caption = videoCaption({
      orderNo: 'ELY-2610-00042',
      packer: 'Rahim',
      at: new Date('2026-10-06T20:05:09Z'),
    });
    expect(caption).toBe('ELY-2610-00042  ·  07 Oct 2026 02:05:09  ·  Rahim');
    expect(
      videoCaption({ orderNo: 'X-1', packer: null, at: new Date('2026-10-06T00:00:00Z') }),
    ).toBe('X-1  ·  06 Oct 2026 06:00:00');
  });

  it('shows a running time as minutes and seconds', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(65_400)).toBe('01:05');
    expect(formatElapsed(15 * 60_000)).toBe('15:00');
    expect(formatElapsed(3_725_000)).toBe('1:02:05');
    expect(formatMegabytes(12_345_678)).toBe('12.3 MB');
  });
});

describe('scanning at the table', () => {
  const order = {
    orderNumber: 'ELY-2610-00042',
    trackingCode: 'SF123456',
    consignmentId: '998877',
  };

  it('knows the order’s own slip by its number or the courier code its QR carries', () => {
    expect(isOrderSlip('ely-2610-00042', order)).toBe(true);
    expect(isOrderSlip(' SF123456 ', order)).toBe(true);
    expect(isOrderSlip('998877', order)).toBe(true);
    expect(isOrderSlip('2000000000015', order)).toBe(false);
    expect(isOrderSlip('', { ...order, trackingCode: '' })).toBe(false);
  });

  it('sounds and shows a taken piece apart from every refusal', () => {
    expect(outcomeTone('accepted')).toBe('success');
    expect(outcomeTone('removed')).toBe('neutral');
    for (const refusal of ['over', 'wrong_item', 'wrong_variant', 'unknown_code']) {
      expect(outcomeTone(refusal)).toBe('danger');
    }
  });
});

describe('the upload queue', () => {
  function recording(overrides: Partial<StoredRecording> = {}): StoredRecording {
    return {
      videoId: 'video-1',
      sessionId: 'session-1',
      orderNo: 'ELY-1',
      mime: 'video/webm;codecs=vp8',
      startedAt: 1_000,
      endedAt: 61_000,
      lastChunkAt: 60_000,
      chunks: 0,
      bytes: 0,
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      ...overrides,
    };
  }

  function fakeApi(options: { failPut?: boolean; state?: VideoPartAnswer['state'] } = {}) {
    const calls: string[] = [];
    const attached: { fileId: string; durationMs: number }[] = [];
    const api: UploadApi = {
      register: (_session, input) => {
        calls.push(`register ${input.mime}`);
        return Promise.resolve({ id: input.videoId, part: 1, state: options.state ?? 'waiting' });
      },
      ticket: (input) => {
        calls.push(`ticket ${input.contentType} ${String(input.sizeBytes)} ${input.originalName}`);
        const ticket: VideoUploadTicket = {
          fileId: 'file-1',
          url: 'https://storage.example/put',
          method: 'PUT',
          headers: { 'content-type': input.contentType },
          maxBytes: 90 * 1024 * 1024,
        };
        return Promise.resolve(ticket);
      },
      put: (_ticket, blob) => {
        calls.push(`put ${blob.type} ${String(blob.size)}`);
        return options.failPut === true ? Promise.reject(new Error('offline')) : Promise.resolve();
      },
      finalize: (fileId) => {
        calls.push(`finalize ${fileId}`);
        return Promise.resolve({});
      },
      attach: (_session, videoId, input) => {
        calls.push(`attach ${videoId}`);
        attached.push(input);
        return Promise.resolve({ id: videoId, part: 1, state: 'uploaded' });
      },
    };
    return { api, calls, attached };
  }

  it('sends a finished recording through ticket, PUT, finalize and attach, then lets it go', async () => {
    const store = memoryVideoStore();
    await store.begin(recording());
    await store.append('video-1', 2, new Blob(['b'.repeat(5)]), 30_000);
    await store.append('video-1', 1, new Blob(['a'.repeat(3)]), 10_000);
    const { api, calls, attached } = fakeApi();
    const summary = await runUploadQueue({ store, api, activeVideoId: null, now: () => 0 });
    expect(summary).toEqual({ uploaded: 1, failed: 0, waiting: 0 });
    expect(calls).toEqual([
      'register video/webm',
      'ticket video/webm 8 ELY-1-part-1.webm',
      'put video/webm 8',
      'finalize file-1',
      'attach video-1',
    ]);
    expect(attached).toEqual([{ fileId: 'file-1', durationMs: 60_000 }]);
  });

  it('keeps a recording whose upload failed, and tries again only when it is due', async () => {
    const store = memoryVideoStore();
    await store.begin(recording());
    await store.append('video-1', 1, new Blob(['x']), 2_000);
    const failing = fakeApi({ failPut: true });
    const first = await runUploadQueue({
      store,
      api: failing.api,
      activeVideoId: null,
      now: () => 100_000,
    });
    expect(first).toEqual({ uploaded: 0, failed: 1, waiting: 1 });
    const [kept] = await store.list();
    expect(kept).toMatchObject({ attempts: 1, lastAttemptAt: 100_000, lastError: 'offline' });

    const working = fakeApi();
    // Ten seconds later it is not due yet; thirty seconds later it is.
    expect(
      await runUploadQueue({ store, api: working.api, activeVideoId: null, now: () => 110_000 }),
    ).toEqual({ uploaded: 0, failed: 0, waiting: 1 });
    expect(
      await runUploadQueue({ store, api: working.api, activeVideoId: null, now: () => 130_000 }),
    ).toEqual({ uploaded: 1, failed: 0, waiting: 0 });
  });

  it('leaves the part being recorded alone, and finishes one an earlier page left recording', async () => {
    const store = memoryVideoStore();
    await store.begin(recording({ videoId: 'live', endedAt: null }));
    await store.begin(recording({ videoId: 'cut-short', endedAt: null, lastChunkAt: 41_000 }));
    await store.append('cut-short', 1, new Blob(['y']), 41_000);
    const { api, attached } = fakeApi();
    const summary = await runUploadQueue({ store, api, activeVideoId: 'live', now: () => 0 });
    expect(summary).toEqual({ uploaded: 1, failed: 0, waiting: 1 });
    // Its length runs to the last chunk that was kept.
    expect(attached).toEqual([{ fileId: 'file-1', durationMs: 40_000 }]);
    expect((await store.list()).map((entry) => entry.videoId)).toEqual(['live']);
  });

  it('drops the copy here when the server already has that part', async () => {
    const store = memoryVideoStore();
    await store.begin(recording());
    await store.append('video-1', 1, new Blob(['z']), 2_000);
    const { api, calls } = fakeApi({ state: 'uploaded' });
    await runUploadQueue({ store, api, activeVideoId: null, now: () => 0 });
    expect(calls).toEqual(['register video/webm']);
    expect(await store.list()).toEqual([]);
  });

  it('waits longer after each failure, up to ten minutes', () => {
    expect([1, 2, 3, 4, 5, 9].map(retryDelayMs)).toEqual([
      30_000, 60_000, 120_000, 300_000, 600_000, 600_000,
    ]);
    expect(uploadDue({ attempts: 0, lastAttemptAt: null }, 0)).toBe(true);
    expect(uploadDue({ attempts: 2, lastAttemptAt: 1_000 }, 60_999)).toBe(false);
    expect(uploadDue({ attempts: 2, lastAttemptAt: 1_000 }, 61_000)).toBe(true);
    expect(recordedMs(recording({ endedAt: null, lastChunkAt: null }))).toBe(0);
  });
});
