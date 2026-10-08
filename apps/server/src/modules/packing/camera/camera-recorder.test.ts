import { mkdtemp, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { segmentsForWindow } from '@elysium/domain/packing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { spawn, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';

import { fakeFfmpeg, type FakeFfmpegRun } from '../../../testing/fake-ffmpeg.js';
import {
  CameraRecorder,
  hostRefusal,
  type CameraRecorderOptions,
  type FfmpegCommand,
  type RecorderLog,
} from './camera-recorder.js';
import { cutSegments } from './cutter.js';
import {
  classifyFfmpegError,
  concatArgs,
  concatList,
  ffconcatInput,
  ffmpegEnv,
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
});

/** What each fake ffmpeg run was given, from its record file. */
async function runs(record: string): Promise<FakeFfmpegRun[]> {
  if (!existsSync(record)) return [];
  return (await readFile(record, 'utf8'))
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as FakeFfmpegRun);
}

/** Environment names that would carry a secret into ffmpeg. */
const SECRET_NAME = /SECRET|KEY|PASSWORD|TOKEN|DATABASE|AUTH|DSN|R2_|VALKEY/i;

async function recorder(
  ffmpeg: FfmpegCommand,
  options: Partial<
    Pick<CameraRecorderOptions, 'stallAfterMs' | 'stream' | 'inputListKeepMs' | 'spawn'>
  > = {},
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
      inputArgs: rtspInputArgs('/buffer/input-1.ffconcat'),
      outputPattern: '/b/%09d.ts',
    });
    expect(args.join(' ')).toContain('-map 0:v:0 -an -c copy -f segment -segment_time 1');
    expect(args.join(' ')).toContain('-reset_timestamps 1');
    expect(args.at(-1)).toBe('/b/%09d.ts');
    const concat = concatArgs({ listFile: '/l.txt', output: '/o.mp4' }).join(' ');
    expect(concat).toContain('-f concat -safe 0 -i /l.txt');
    expect(concat).toContain('-c copy -movflags +faststart -f mp4 -y /o.mp4');
    expect(concatList(["/a/it's.ts", '/b.ts'])).toBe("file '/a/it'\\''s.ts'\nfile '/b.ts'\n");
  });

  it('allows ffmpeg only the protocols it needs, before its input (ledger audit W3)', () => {
    const record = recordArgs({
      inputArgs: rtspInputArgs('/buffer/input-1.ffconcat'),
      outputPattern: '/b/%09d.ts',
    });
    const whitelist = record.indexOf('-protocol_whitelist');
    expect(record[whitelist + 1]).toBe('file,rtsp,tcp');
    expect(whitelist).toBeLessThan(record.indexOf('-i'));
    const concat = concatArgs({ listFile: '/l.txt', output: '/o.mp4' });
    expect(concat[concat.indexOf('-protocol_whitelist') + 1]).toBe('file');
    expect(concat.indexOf('-protocol_whitelist')).toBeLessThan(concat.indexOf('-i'));
  });

  it('keeps the credentials off the command line, in a private list ffmpeg reads (W1)', () => {
    const args = recordArgs({
      inputArgs: rtspInputArgs('/buffer/input-1.ffconcat'),
      outputPattern: '/b/%09d.ts',
    }).join(' ');
    expect(args).not.toContain('rtsp://');
    expect(args).not.toContain(PASSWORD);
    const list = ffconcatInput(streamAddress(STREAM));
    expect(list.split('\n')).toEqual([
      'ffconcat version 1.0',
      `file '${streamAddress(STREAM)}'`,
      'option rtsp_transport tcp',
      'option timeout 10000000',
      '',
    ]);
    // A quote in the address cannot end the line early.
    expect(ffconcatInput("rtsp://h.example/a'b")).toContain("file 'rtsp://h.example/a'\\''b'");
  });

  it('gives ffmpeg none of the server’s environment, only its path and clock (W5)', () => {
    const env = ffmpegEnv({
      PATH: '/usr/bin',
      TZ: 'Asia/Dhaka',
      AUTH_SECRET: 'x',
      DATABASE_URL: 'postgres://erp_app:pw@postgres/erp',
      STOREFRONT_CREDENTIALS_KEY: 'k',
      HR_FIELD_KEY: 'h',
    });
    expect(Object.keys(env).filter((name) => name !== 'SystemRoot')).toEqual(['PATH', 'TZ']);
  });

  it('says why a stream stopped', () => {
    expect(classifyFfmpegError('method DESCRIBE failed: 401 Unauthorized', 1)).toBe('auth_failed');
    expect(classifyFfmpegError('404 Not Found', 1)).toBe('not_found');
    expect(classifyFfmpegError('Connection refused', 1)).toBe('unreachable');
    expect(classifyFfmpegError('No route to host', 1)).toBe('unreachable');
    expect(
      classifyFfmpegError('Failed to resolve hostname camera: Name or service not known', 1),
    ).toBe('unreachable');
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
    const record = path.join(fake.dir, `run-${String(Date.now())}.jsonl`);
    process.env.AUTH_SECRET_FOR_THIS_TEST = 'must-not-reach-ffmpeg';
    const {
      recorder: made,
      log,
      dir,
    } = await recorder(fake.command('segments', record), {
      inputListKeepMs: 300,
    });
    await made.start();
    await until(async () => (await new SegmentBuffer(dir).segments()).length >= 3);
    // The private list is gone once ffmpeg read it.
    await until(async () => !(await readdir(dir)).some((name) => name.endsWith('.ffconcat')));
    await made.stop();
    delete process.env.AUTH_SECRET_FOR_THIS_TEST;

    const segments = await new SegmentBuffer(dir).segments();
    for (let index = 1; index < segments.length; index += 1) {
      expect(segments[index]?.startMs).toBe(segments[index - 1]?.endMs);
    }
    expect(made.status().lastSegmentAt).not.toBeNull();
    expect(made.status().errorCode).toBeNull();
    // Nothing left half-named.
    expect((await readdir(dir)).every((name) => name.startsWith('seg-'))).toBe(true);

    // ffmpeg got the credentials through its list, not its command line or its environment;
    // the log never did.
    const [given] = await runs(record);
    expect(given?.address).toBe(streamAddress(STREAM));
    expect(given?.args.join(' ')).not.toContain(PASSWORD);
    expect(given?.args.join(' ')).not.toContain(encodeURIComponent(PASSWORD));
    expect(given?.args.join(' ')).not.toContain('packing');
    expect(given?.env.filter((name) => SECRET_NAME.test(name))).toEqual([]);
    expect(given?.env).toContain('PATH');
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

  it('never connects to the server’s own services, whatever a name resolves to (W4)', async () => {
    let spawned = 0;
    const counting = (command: string, args: readonly string[], options: SpawnOptions) => {
      spawned += 1;
      return spawn(command, [...args], options);
    };
    const { recorder: made } = await recorder(fake.command('segments'), {
      stream: { rtspUrl: 'rtsp://valkey:6379/', username: '', password: null },
      spawn: counting,
    });
    await made.start();
    await until(() => made.status().errorCode === 'address_refused');
    expect(spawned).toBe(0);
    expect(await hostRefusal('valkey')).toMatch(/one-word name/);
    expect(await hostRefusal('localhost')).not.toBeNull();
    expect(await hostRefusal('127.0.0.1')).toMatch(/loopback/);
    expect(await hostRefusal('192.168.20.111')).toBeNull();
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
    const record = path.join(fake.dir, `cut-${String(Date.now())}.jsonl`);
    const result = await cutSegments({
      ffmpeg: fake.command('concat', record),
      segments: chosen,
      pathOf: (segment) => buffer.pathOf(segment),
      workDir: path.join(dir, '.cuts'),
    });
    // The cut, too, runs with nothing of the server's environment (W5).
    const [cut] = await runs(record);
    expect(cut?.env.filter((name) => SECRET_NAME.test(name))).toEqual([]);
    expect(result.startedAt.getTime()).toBe(t0 + 1000);
    expect(result.durationMs).toBe(3000);
    const bytes = await readFile(result.file);
    expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
    expect(bytes.subarray(24).toString()).toBe('segment-1;segment-2;segment-3;');
    expect((await stat(result.file)).size).toBe(bytes.length);
  });
});
