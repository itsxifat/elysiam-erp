import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { cutSpan, segmentsForWindow, windowCoverage } from '@elysium/domain/packing';
import { sniffMime } from '@elysium/integrations';
import { describe, expect, it } from 'vitest';

import { CameraRecorder, type RecorderLog } from './camera-recorder.js';
import { cutSegments } from './cutter.js';
import { SegmentBuffer } from './segment-buffer.js';

/**
 * The recorder and the cut with a real ffmpeg (M38c, D-672): a synthetic stream (ffmpeg's own
 * test picture, encoded to H.264 the way a camera sends it) recorded into one-second
 * segments, a window cut from them without re-encoding, and the MP4's length checked with
 * ffprobe. Runs where ffmpeg is installed (`FFMPEG_PATH`, else `ffmpeg` on the path), as in
 * the server image; skipped where it is not, because the buffer, the masking and the cut's
 * logic are already proven against a stand-in by `camera-recorder.test.ts`.
 */

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH ?? 'ffprobe';
const available =
  spawnSync(FFMPEG, ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0 &&
  spawnSync(FFPROBE, ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;

const quiet: RecorderLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

function durationOf(file: string): number {
  const probe = spawnSync(
    FFPROBE,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  );
  return Number(probe.stdout.trim());
}

describe.skipIf(!available)('a real ffmpeg (skipped: no ffmpeg on this machine)', () => {
  it('records a stream into segments and cuts a window from them, never starting late', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'erp-camera-real-'));
    const buffer = new SegmentBuffer(dir);
    const recorder = new CameraRecorder({
      cameraId: 'camera-real',
      stream: { rtspUrl: 'rtsp://127.0.0.1:554/test', username: '', password: null },
      buffer,
      ffmpeg: { command: FFMPEG },
      log: quiet,
      tickMs: 200,
      inputArgs: ['-re', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25'],
      codecArgs: ['-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-pix_fmt', 'yuv420p'],
    });
    const started = Date.now();
    await recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 9_000));
    await recorder.stop();

    const segments = await buffer.segments();
    expect(segments.length).toBeGreaterThanOrEqual(5);
    expect(segments[0]?.startMs).toBeGreaterThanOrEqual(started - 2_000);
    // A packing from 3 s to 6 s into the stream, as the station would set it.
    const window = {
      fromMs: (segments[2]?.startMs ?? 0) + 400,
      toMs: (segments[2]?.startMs ?? 0) + 3_400,
    };
    const span = cutSpan(window);
    const chosen = segmentsForWindow(segments, span);
    expect(windowCoverage(chosen, span).startCovered).toBe(true);

    const result = await cutSegments({
      ffmpeg: { command: FFMPEG },
      segments: chosen,
      pathOf: (segment) => buffer.pathOf(segment),
      workDir: path.join(dir, '.cuts'),
    });
    expect(result.startedAt.getTime()).toBeLessThanOrEqual(window.fromMs);
    const bytes = await readFile(result.file);
    expect(sniffMime(bytes)).toBe('video/mp4');
    const seconds = durationOf(result.file);
    // The window and its tail (4.4 s from its first keyframe), give or take a segment.
    expect(seconds).toBeGreaterThanOrEqual((window.toMs - window.fromMs) / 1000);
    expect(seconds).toBeLessThanOrEqual((span.toMs - span.fromMs) / 1000 + 2.5);
    expect(Math.abs(seconds * 1000 - result.durationMs)).toBeLessThan(1_500);
  }, 60_000);
});
