import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';

import type { CameraSegment } from '@elysium/domain/packing';

import type { FfmpegCommand, SpawnFn } from './camera-recorder.js';
import { concatArgs, concatList } from './ffmpeg.js';

/** The longest one cut may take before it is abandoned (and the job retried). */
const CUT_TIMEOUT_MS = 180_000;

export interface CutResult {
  /** The MP4, in the work directory; the caller removes it. */
  readonly file: string;
  /** When its first segment began arriving. */
  readonly startedAt: Date;
  /** How long it runs, from the segments' spans. */
  readonly durationMs: number;
}

/**
 * Join buffered segments into one MP4 (M38c, D-672): ffmpeg's concat demuxer, the video
 * copied as recorded (`-c copy`, no re-encoding), the index moved to the front so a browser
 * plays it at once. It starts at the first segment's keyframe, which is at or before the
 * window's start. No database here and no transaction anywhere near it (invariant 6).
 */
export async function cutSegments(input: {
  readonly ffmpeg: FfmpegCommand;
  readonly segments: readonly CameraSegment[];
  readonly pathOf: (segment: CameraSegment) => string;
  readonly workDir: string;
  readonly spawn?: SpawnFn;
  readonly timeoutMs?: number;
}): Promise<CutResult> {
  const first = input.segments[0];
  if (first === undefined) throw new Error('a cut needs at least one segment');
  await mkdir(input.workDir, { recursive: true });
  const id = randomUUID();
  const listFile = path.join(input.workDir, `cut-${id}.txt`);
  const output = path.join(input.workDir, `cut-${id}.mp4`);
  await writeFile(listFile, concatList(input.segments.map((segment) => input.pathOf(segment))));
  const spawnFn: SpawnFn =
    input.spawn ?? ((command, args, options) => nodeSpawn(command, [...args], options));
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawnFn(
        input.ffmpeg.command,
        [...(input.ffmpeg.prefix ?? []), ...concatArgs({ listFile, output })],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-2_048);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), input.timeoutMs ?? CUT_TIMEOUT_MS);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(
          new Error(`ffmpeg could not start: ${(error as { code?: string }).code ?? 'error'}`),
        );
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else
          reject(
            new Error(
              `ffmpeg could not join the segments (${signal ?? String(code)}): ${stderr.trim().split('\n').slice(-2).join(' | ')}`,
            ),
          );
      });
    });
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  } finally {
    await rm(listFile, { force: true });
  }
  const durationMs = input.segments.reduce(
    (sum, segment) => sum + (segment.endMs - segment.startMs),
    0,
  );
  return { file: output, startedAt: new Date(first.startMs), durationMs };
}
