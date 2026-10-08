import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { segmentsForWindow } from '@elysium/domain/packing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { fakeFfmpeg } from '../../../testing/fake-ffmpeg.js';
import { CameraRecorder, type FfmpegCommand, type RecorderLog } from './camera-recorder.js';
import { cutSegments } from './cutter.js';
import {
  classifyFfmpegError,
  concatArgs,
  concatList,
  maskSecrets,
  recordArgs,
  rtspInputArgs,
  streamAddress,
  type CameraStream,
} from './ffmpeg.js';
import { livePattern, parseSegmentName, SegmentBuffer, segmentName } from './segment-buffer.js';

/**
 * The camera process's recorder, buffer and cutter (M38c, D-672, D-673), against a stand-in
 * ffmpeg: the password reaches ffmpeg and never the log, the stream is copied into wall-clock
 * segments, a silent or refused stream is restarted with the reason said, and a cut joins the
 * segments. `camera.ffmpeg.test.ts` does the same with a real ffmpeg where one is installed.
 */

const PASSWORD = 'S3cr3t!pa:ss w/rd';
const STREAM: CameraStream = {
  rtspUrl: 'rtsp://192.168.20.111:554/stream1',
  username: 'packing',
  password: PASSWORD,
};

let fake: Awaited<ReturnType<typeof fakeFfmpeg>>;

beforeAll(async () => {
  fake = await fakeFfmpeg();
});

/** A log that keeps every line as the logger would print it. */
function capture(): RecorderLog & { readonly lines: string[] } {
  const lines: string[] = [];
  const keep = (fields: Record<string, unknown>, message: string) => {
    lines.push(`${message} ${JSON.stringify(fields)}`);
  };
  return { lines, info: keep, warn: keep, error: keep };
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

const recorders: CameraRecorder[] = [];
afterEach(async () => {
  for (const recorder of recorders.splice(0)) await recorder.stop();
  delete process.env.FAKE_FFMPEG_ARGS;
});

async function recorder(
  ffmpeg: FfmpegCommand,
  options: { stallAfterMs?: number } = {},
): Promise<{ recorder: CameraRecorder; log: ReturnType<typeof capture>; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'erp-camera-buffer-'));
  const log = capture();
  const made = new CameraRecorder({
    cameraId: 'camera-1',
    stream: STREAM,
    buffer: new SegmentBuffer(dir),
    ffmpeg,
    log,
    tickMs: 100,
    ...options,
  });
  recorders.push(made);
  return { recorder: made, log, dir };
}

describe('ffmpeg’s arguments and words', () => {
  it('puts the user name and password into the address, percent-encoded, and nowhere else', () => {
    expect(streamAddress(STREAM)).toBe(
      'rtsp://packing:S3cr3t!pa%3Ass%20w%2Frd@192.168.20.111:554/stream1',
    );
    expect(streamAddress({ ...STREAM, username: '', password: null })).toBe(STREAM.rtspUrl);
    expect(streamAddress({ ...STREAM, password: null })).toBe(
      'rtsp://packing@192.168.20.111:554/stream1',
    );
  });

  it('masks every form of the credentials ffmpeg might print', () => {
    const address = streamAddress(STREAM);
    const said = [
      `${address}: Server returned 401 Unauthorized`,
      `password ${PASSWORD} and ${encodeURIComponent(PASSWORD)}`,
      'rtsp://someone:else@10.0.0.1/x failed',
    ].join('\n');
    const masked = maskSecrets(said, STREAM);
    expect(masked).not.toContain(PASSWORD);
    expect(masked).not.toContain(encodeURIComponent(PASSWORD));
    expect(masked).not.toContain('packing:');
    expect(masked).not.toContain('someone:else');
    expect(masked).toContain('401 Unauthorized');
  });

  it('copies the first video stream into one-second MPEG-TS segments, without sound or re-encoding', () => {
    const args = recordArgs({
      inputArgs: rtspInputArgs('rtsp://x/y'),
      outputPattern: '/b/%09d.ts',
    });
    expect(args.join(' ')).toContain('-rtsp_transport tcp');
    expect(args.join(' ')).toContain('-map 0:v:0 -an -c copy -f segment -segment_time 1');
    expect(args.join(' ')).toContain('-reset_timestamps 1');
    expect(args.at(-1)).toBe('/b/%09d.ts');
    const concat = concatArgs({ listFile: '/l.txt', output: '/o.mp4' }).join(' ');
    expect(concat).toContain('-f concat -safe 0 -i /l.txt');
    expect(concat).toContain('-c copy -movflags +faststart -f mp4 -y /o.mp4');
    expect(concatList(["/a/it's.ts", '/b.ts'])).toBe("file '/a/it'\\''s.ts'\nfile '/b.ts'\n");
  });

  it('says why a stream stopped', () => {
    expect(classifyFfmpegError('method DESCRIBE failed: 401 Unauthorized', 1)).toBe('auth_failed');
    expect(classifyFfmpegError('404 Not Found', 1)).toBe('not_found');
    expect(classifyFfmpegError('Connection refused', 1)).toBe('unreachable');
    expect(classifyFfmpegError('No route to host', 1)).toBe('unreachable');
    expect(classifyFfmpegError('Connection timed out', 1)).toBe('timeout');
    expect(classifyFfmpegError('', 0)).toBe('stream_ended');
    expect(classifyFfmpegError('Invalid data found', 1)).toBe('stream_error');
  });
});

describe('the camera’s buffer', () => {
  it('names a finished segment by the wall-clock span it arrived in, the next starting where it ended', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'erp-camera-settle-'));
    const buffer = new SegmentBuffer(dir);
    const run = 1_791_400_000_000;
    const pattern = livePattern(dir, run);
    const ends = [run + 1_500, run + 2_600, run + 3_700];
    for (const [index, end] of ends.entries()) {
      const file = pattern.replace('%09d', String(index).padStart(9, '0'));
      await writeFile(file, Buffer.alloc(100 + index, 1));
      await utimes(file, end / 1000, end / 1000);
    }
    // The run is still writing its last file: only the first two are complete.
    expect(await buffer.settle(run)).toBe(ends[1]);
    let segments = await buffer.segments();
    expect(segments.map((segment) => segment.endMs)).toEqual([ends[0], ends[1]]);
    expect(segments[0]?.startMs).toBeLessThan(ends[0] ?? 0);
    expect(segments[1]?.startMs).toBe(ends[0]);
    // The run ended: its last file is complete too, and starts where the second ended.
    expect(await buffer.settle(null)).toBe(ends[2]);
    segments = await buffer.segments();
    expect(segments).toHaveLength(3);
    expect(segments[2]?.startMs).toBe(ends[1]);
    expect(segments[2]?.sizeBytes).toBe(102);
    expect(parseSegmentName(segmentName(5, 9))).toEqual({ startMs: 5, endMs: 9 });
    expect(parseSegmentName('live-0000000000005-000000001.ts')).toBeNull();

    // Forgetting is the buffer's own decision, by name.
    await buffer.forget(segments.slice(0, 2));
    expect((await buffer.segments()).map((segment) => segment.endMs)).toEqual([ends[2]]);
  });
});

describe('the recorder', () => {
  it('records the stream into settled segments and gives the password to ffmpeg only', async () => {
    const argsFile = path.join(fake.dir, `args-${String(Date.now())}.jsonl`);
    process.env.FAKE_FFMPEG_ARGS = argsFile;
    const { recorder: made, log, dir } = await recorder(fake.command('segments'));
    await made.start();
    await until(async () => (await new SegmentBuffer(dir).segments()).length >= 3);
    await made.stop();

    const segments = await new SegmentBuffer(dir).segments();
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]?.startMs).toBe(segments[index - 1]?.endMs);
    }
    expect(made.status().lastSegmentAt).not.toBeNull();
    expect(made.status().errorCode).toBeNull();
    // Nothing left half-named.
    expect((await readdir(dir)).every((name) => name.startsWith('seg-'))).toBe(true);

    // ffmpeg got the credentials; the log never did.
    const given = (await readFile(argsFile, 'utf8')).trim().split('\n')[0] ?? '';
    expect(given).toContain(streamAddress(STREAM));
    const logged = log.lines.join('\n');
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(encodeURIComponent(PASSWORD));
    expect(logged).not.toContain('packing:');
  });

  it('says a refused password is a refused password, retries, and never logs the password', async () => {
    const { recorder: made, log } = await recorder(fake.command('auth'));
    await made.start();
    await until(() => made.status().errorCode === 'auth_failed');
    const logged = log.lines.join('\n');
    expect(logged).toContain('auth_failed');
    // The fake prints its whole command line and its input address, as ffmpeg does.
    expect(logged).toContain('401 Unauthorized');
    expect(logged).not.toContain(PASSWORD);
    expect(logged).not.toContain(encodeURIComponent(PASSWORD));
    expect(logged).not.toContain('packing:');
    expect(made.status().failures).toBeGreaterThanOrEqual(1);
  });

  it('restarts a stream that went silent', async () => {
    const { recorder: made } = await recorder(fake.command('silent'), { stallAfterMs: 300 });
    await made.start();
    await until(() => made.status().errorCode === 'stalled');
  });

  it('says so when there is no ffmpeg on the machine', async () => {
    const { recorder: made } = await recorder({ command: path.join(fake.dir, 'no-such-ffmpeg') });
    await made.start();
    await until(() => made.status().errorCode === 'ffmpeg_missing');
  });
});

describe('the cut', () => {
  it('joins the segments of a window into one file, starting with the segment its start falls in', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'erp-camera-cut-'));
    const buffer = new SegmentBuffer(dir);
    const t0 = 1_791_400_000_000;
    for (let index = 0; index < 6; index += 1) {
      await writeFile(
        path.join(dir, segmentName(t0 + index * 1000, t0 + (index + 1) * 1000)),
        Buffer.from(`segment-${String(index)};`),
      );
    }
    const chosen = segmentsForWindow(await buffer.segments(), {
      fromMs: t0 + 1_500,
      toMs: t0 + 3_200,
    });
    expect(chosen.map((segment) => segment.startMs - t0)).toEqual([1000, 2000, 3000]);
    const result = await cutSegments({
      ffmpeg: fake.command('concat'),
      segments: chosen,
      pathOf: (segment) => buffer.pathOf(segment),
      workDir: path.join(dir, '.cuts'),
    });
    expect(result.startedAt.getTime()).toBe(t0 + 1000);
    expect(result.durationMs).toBe(3000);
    const bytes = await readFile(result.file);
    expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(bytes.subarray(24).toString()).toBe('segment-1;segment-2;segment-3;');
    expect((await stat(result.file)).size).toBe(bytes.length);
  });
});
