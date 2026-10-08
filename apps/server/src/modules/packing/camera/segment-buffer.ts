import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import type { CameraSegment } from '@elysium/domain/packing';

/**
 * One camera's rolling buffer on the brand server's disk (M38c, D-672).
 *
 * ffmpeg writes the stream as numbered MPEG-TS segments of one run
 * (`live-<run>-<n>.ts`, the run being when that ffmpeg was started). A segment is complete once
 * the next one of its run exists, or once its run has ended. A complete segment is renamed
 * `seg-<startMs>-<endMs>.ts`: the wall-clock span it arrived in, so the buffer's index is the
 * directory itself and survives a restart of the process.
 *
 * The span: a segment ends when its last bytes were written (its modification time, which is
 * the moment ffmpeg closed it and opened the next), and starts where the previous segment of
 * its run ended. The first segment of a run starts when its file was created (its birth time
 * where the file system keeps one), else a second before it ended.
 */

const LIVE = /^live-(\d{13})-(\d{9})\.ts$/;
const DONE = /^seg-(\d{13})-(\d{13})\.ts$/;

/** The name ffmpeg is told to write a run's segments under. */
export function livePattern(dir: string, runMs: number): string {
  return path.join(dir, `live-${String(runMs).padStart(13, '0')}-%09d.ts`);
}

export function segmentName(startMs: number, endMs: number): string {
  return `seg-${String(startMs).padStart(13, '0')}-${String(endMs).padStart(13, '0')}.ts`;
}

/** A finished segment's span read back from its name, or null for any other file. */
export function parseSegmentName(name: string): { startMs: number; endMs: number } | null {
  const match = DONE.exec(name);
  if (match === null) return null;
  const startMs = Number(match[1]);
  const endMs = Number(match[2]);
  return endMs > startMs ? { startMs, endMs } : null;
}

/** A segment nobody can place: no birth time and no previous segment. */
const FALLBACK_SEGMENT_MS = 1_000;

export class SegmentBuffer {
  /** Per run: where its last renamed segment ended, so the next one starts there. */
  private readonly runEnds = new Map<number, number>();

  constructor(readonly dir: string) {}

  async ensure(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * Rename every complete live segment to its span. `activeRun` is the run ffmpeg is writing
   * now (its last segment is still open); every other run has ended, so all its files are
   * complete. Returns the newest end it saw, for the camera's status.
   */
  async settle(activeRun: number | null): Promise<number | null> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return null;
    }
    const runs = new Map<number, { index: number; name: string }[]>();
    for (const name of entries) {
      const match = LIVE.exec(name);
      if (match === null) continue;
      const run = Number(match[1]);
      const list = runs.get(run) ?? [];
      list.push({ index: Number(match[2]), name });
      runs.set(run, list);
    }
    let newest: number | null = null;
    for (const [run, files] of [...runs].sort((a, b) => a[0] - b[0])) {
      files.sort((a, b) => a.index - b.index);
      const complete = run === activeRun ? files.slice(0, -1) : files;
      for (const file of complete) {
        const full = path.join(this.dir, file.name);
        let info: Awaited<ReturnType<typeof stat>>;
        try {
          info = await stat(full);
        } catch {
          continue;
        }
        const endMs = Math.floor(info.mtimeMs);
        const birth = Math.floor(info.birthtimeMs);
        const previous = this.runEnds.get(run);
        let startMs =
          previous ?? (birth > 0 && birth < endMs ? birth : endMs - FALLBACK_SEGMENT_MS);
        if (startMs >= endMs) startMs = endMs - 1;
        if (info.size === 0) {
          // ffmpeg opened it and wrote nothing (the stream dropped): nothing to keep.
          await rm(full, { force: true });
          continue;
        }
        try {
          await rename(full, path.join(this.dir, segmentName(startMs, endMs)));
        } catch {
          continue;
        }
        this.runEnds.set(run, endMs);
        newest = newest === null ? endMs : Math.max(newest, endMs);
      }
      if (run !== activeRun && complete.length === files.length) this.runEnds.delete(run);
    }
    return newest;
  }

  /** Every finished segment, oldest first. */
  async segments(): Promise<CameraSegment[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const found: CameraSegment[] = [];
    for (const name of entries) {
      const span = parseSegmentName(name);
      if (span === null) continue;
      try {
        const info = await stat(path.join(this.dir, name));
        found.push({ name, ...span, sizeBytes: info.size });
      } catch {
        // Pruned between the listing and the look: gone.
      }
    }
    return found.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  }

  pathOf(segment: { readonly name: string }): string {
    return path.join(this.dir, segment.name);
  }

  /** Delete these segments (the buffer's own decision, `segmentsToForget`). */
  async forget(segments: readonly { readonly name: string }[]): Promise<number> {
    let removed = 0;
    for (const segment of segments) {
      await rm(this.pathOf(segment), { force: true });
      removed += 1;
    }
    return removed;
  }

  /**
   * Live files of runs that ended long ago and could not be settled (a file gone, a clock
   * gone wrong): removed once older than `beforeMs`, so the disk never fills with them.
   */
  async forgetStale(beforeMs: number, activeRun: number | null): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const match = LIVE.exec(name);
      if (match === null) continue;
      const run = Number(match[1]);
      if (run === activeRun) continue;
      const full = path.join(this.dir, name);
      try {
        const info = await stat(full);
        if (info.mtimeMs < beforeMs) await rm(full, { force: true });
      } catch {
        // Already gone.
      }
    }
  }
}
