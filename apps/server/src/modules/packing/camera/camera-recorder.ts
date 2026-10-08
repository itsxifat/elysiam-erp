import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';

import { cameraReconnectDelayMs } from '@elysium/domain/packing';

import {
  classifyFfmpegError,
  maskSecrets,
  recordArgs,
  rtspInputArgs,
  streamAddress,
  streamHost,
  type CameraErrorCode,
  type CameraStream,
} from './ffmpeg.js';
import { livePattern, type SegmentBuffer } from './segment-buffer.js';

/** What the recorder says, with nothing in it that could carry a password (D-673). */
export interface RecorderLog {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

/** How a process is started: Node's own, or a test's stand-in. */
export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

/** Which ffmpeg runs: a path, and arguments to put first (a test's script runner). */
export interface FfmpegCommand {
  readonly command: string;
  readonly prefix?: readonly string[];
}

export interface CameraRecorderOptions {
  readonly cameraId: string;
  readonly stream: CameraStream;
  readonly buffer: SegmentBuffer;
  readonly ffmpeg: FfmpegCommand;
  readonly log: RecorderLog;
  /** The input side of the command: the camera's RTSP stream unless a test feeds another. */
  readonly inputArgs?: readonly string[];
  readonly codecArgs?: readonly string[];
  readonly spawn?: SpawnFn;
  readonly now?: () => number;
  /** A running ffmpeg that has written nothing new for this long is restarted. */
  readonly stallAfterMs?: number;
  /** How often the buffer is settled while recording. */
  readonly tickMs?: number;
}

/** What the recorder knows about its camera, for the status the station and settings read. */
export interface RecorderStatus {
  readonly running: boolean;
  /** The end of the newest segment stored, if any this process has seen. */
  readonly lastSegmentAt: Date | null;
  /** Why the stream last stopped, until footage flows again. */
  readonly errorCode: CameraErrorCode | null;
  readonly failures: number;
}

/** The most of ffmpeg's error output kept to judge why it stopped. */
const STDERR_KEEP = 4_096;

/**
 * One camera, recorded for as long as it is enabled (M38c, D-672, D-673): ffmpeg copies its
 * RTSP stream into the camera's buffer as one-second segments; when ffmpeg stops (the camera
 * rebooted, the network dropped, the password changed) it is started again after a backoff
 * (1, 2, 5, 10, 30 s, then every minute), and a stream that goes silent while ffmpeg still
 * runs is restarted too. Every line it logs is masked: ffmpeg quotes its input address, and
 * that address carries the camera's password.
 */
export class CameraRecorder {
  private child: ChildProcess | null = null;
  private run: number | null = null;
  private stderr = '';
  private failures = 0;
  private errorCode: CameraErrorCode | null = null;
  private lastSegmentAt: number | null = null;
  private lastProgressAt = 0;
  private stopped = false;
  private restartTimer: NodeJS.Timeout | null = null;
  private tickTimer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> = Promise.resolve();
  private readonly spawnFn: SpawnFn;
  private readonly now: () => number;
  private readonly stallAfterMs: number;
  private readonly tickMs: number;

  constructor(private readonly options: CameraRecorderOptions) {
    this.spawnFn =
      options.spawn ??
      ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions));
    this.now = options.now ?? Date.now;
    this.stallAfterMs = options.stallAfterMs ?? 20_000;
    this.tickMs = options.tickMs ?? 1_000;
  }

  get cameraId(): string {
    return this.options.cameraId;
  }

  get buffer(): SegmentBuffer {
    return this.options.buffer;
  }

  status(): RecorderStatus {
    return {
      running: this.child !== null,
      lastSegmentAt: this.lastSegmentAt === null ? null : new Date(this.lastSegmentAt),
      errorCode: this.errorCode,
      failures: this.failures,
    };
  }

  async start(): Promise<void> {
    this.stopped = false;
    await this.options.buffer.ensure();
    // What an earlier process left: settle it before this run starts writing beside it.
    await this.options.buffer.settle(null);
    this.launch();
    this.tickTimer = setInterval(() => {
      this.ticking = this.ticking.then(() => this.tick()).catch(() => undefined);
    }, this.tickMs);
    this.tickTimer.unref();
  }

  /** Stop recording: ffmpeg asked to finish, then killed if it will not. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    if (this.tickTimer !== null) clearInterval(this.tickTimer);
    const child = this.child;
    if (child !== null) {
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => child.kill('SIGKILL'), 5_000);
        child.once('exit', () => {
          clearTimeout(killer);
          resolve();
        });
        // `q` on stdin is ffmpeg's own "finish the file"; SIGTERM does the same on Linux.
        child.kill('SIGTERM');
      });
    }
    await this.ticking;
    await this.options.buffer.settle(null);
  }

  /** Settle the buffer now (the cut asks before it chooses segments). */
  async settleNow(): Promise<void> {
    this.ticking = this.ticking.then(() => this.tick()).catch(() => undefined);
    await this.ticking;
  }

  private async tick(): Promise<void> {
    const newest = await this.options.buffer.settle(this.child === null ? null : this.run);
    const at = this.now();
    if (newest !== null) {
      this.lastSegmentAt = Math.max(this.lastSegmentAt ?? 0, newest);
      this.lastProgressAt = at;
      if (this.errorCode !== null || this.failures > 0) {
        this.options.log.info({ cameraId: this.cameraId }, 'camera stream flowing again');
      }
      this.errorCode = null;
      this.failures = 0;
    } else if (this.child !== null && at - this.lastProgressAt > this.stallAfterMs) {
      this.options.log.warn(
        { cameraId: this.cameraId, host: streamHost(this.options.stream.rtspUrl) },
        'camera stream stalled; restarting ffmpeg',
      );
      this.errorCode = 'stalled';
      this.child.kill('SIGKILL');
    }
  }

  private launch(): void {
    if (this.stopped) return;
    const run = this.now();
    this.run = run;
    this.stderr = '';
    this.lastProgressAt = run;
    const args = recordArgs({
      inputArgs: this.options.inputArgs ?? rtspInputArgs(streamAddress(this.options.stream)),
      outputPattern: livePattern(this.options.buffer.dir, run),
      ...(this.options.codecArgs === undefined ? {} : { codecArgs: this.options.codecArgs }),
    });
    let child: ChildProcess;
    try {
      child = this.spawnFn(
        this.options.ffmpeg.command,
        [...(this.options.ffmpeg.prefix ?? []), ...args],
        {
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
    } catch (error) {
      this.exited(null, error);
      return;
    }
    this.child = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_KEEP);
    });
    child.once('error', (error) => {
      // Spawning failed (no ffmpeg on this machine): `exit` may never come.
      if (this.child === child) this.exited(null, error);
    });
    child.once('exit', (code) => {
      if (this.child === child) this.exited(code, null);
    });
    this.options.log.info(
      { cameraId: this.cameraId, host: streamHost(this.options.stream.rtspUrl) },
      'camera recording started',
    );
  }

  private exited(code: number | null, error: unknown): void {
    this.child = null;
    const run = this.run;
    // Its last segment is complete now; settled in turn with the ticks, never beside one.
    this.ticking = this.ticking
      .then(async () => {
        const newest = await this.options.buffer.settle(null);
        if (newest !== null) this.lastSegmentAt = Math.max(this.lastSegmentAt ?? 0, newest);
      })
      .catch(() => undefined);
    if (run !== null) this.run = null;
    if (this.stopped) return;
    const missing = (error as { code?: unknown } | null)?.code === 'ENOENT';
    const reason: CameraErrorCode = missing
      ? 'ffmpeg_missing'
      : this.errorCode === 'stalled'
        ? 'stalled'
        : classifyFfmpegError(this.stderr, code);
    this.errorCode = reason;
    this.failures += 1;
    const delay = cameraReconnectDelayMs(this.failures);
    // ffmpeg's last words, masked: it names its input, and its input has the password in it.
    const said = maskSecrets(
      this.stderr.trim().split('\n').slice(-3).join(' | '),
      this.options.stream,
    );
    this.options.log.warn(
      {
        cameraId: this.cameraId,
        host: streamHost(this.options.stream.rtspUrl),
        reason,
        exitCode: code,
        retryInMs: delay,
        ffmpeg: said === '' ? undefined : said,
      },
      'camera recording stopped',
    );
    this.restartTimer = setTimeout(() => this.launch(), delay);
    this.restartTimer.unref();
  }
}
