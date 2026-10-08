import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { cameraReconnectDelayMs } from '@elysium/domain/packing';

import {
  hostRefusal,
  type FfmpegCommand,
  type RecorderLog,
  type SpawnFn,
} from './camera-recorder.js';
import {
  classifyFfmpegError,
  ffconcatInput,
  ffmpegEnv,
  maskSecrets,
  rtspInputArgs,
  streamAddress,
  streamHost,
  type CameraStream,
} from './ffmpeg.js';

/**
 * A camera's live preview (M38c, D-683): a second, light ffmpeg beside the recording, run only
 * while someone looks at the station, writing a small JPEG three times a second that the API
 * serves. It opens the camera exactly as the recording does (the address in a private 0600
 * list, `file,rtsp,tcp` only, a bare environment, the host checked first) and shares nothing
 * else with it: a preview that fails never touches the recording.
 */

/** Where the camera process writes a camera's preview frame: one file per camera. */
export function previewFile(root: string, orgId: string, cameraId: string): string {
  return path.join(root, orgId, `${cameraId}.jpg`);
}

/**
 * The preview's command: the camera's first video stream, three frames a second scaled to 640
 * wide, as one JPEG overwritten in place (`-update 1`). No sound, nothing kept.
 */
export function previewArgs(input: {
  readonly inputArgs: readonly string[];
  readonly output: string;
}): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    ...input.inputArgs,
    '-map',
    '0:v:0',
    '-an',
    '-vf',
    'fps=3,scale=640:-2',
    '-q:v',
    '6',
    '-update',
    '1',
    '-f',
    'image2',
    input.output,
  ];
}

export interface CameraPreviewOptions {
  readonly cameraId: string;
  readonly stream: CameraStream;
  /** The camera's private buffer directory, for the input list (never the shared preview one). */
  readonly workDir: string;
  /** The frame's path in the shared preview directory. */
  readonly output: string;
  readonly ffmpeg: FfmpegCommand;
  readonly log: RecorderLog;
  readonly spawn?: SpawnFn;
  readonly checkHost?: (hostname: string) => Promise<string | null>;
  /** A test's input instead of the camera's RTSP (its frames encoded already). */
  readonly inputArgs?: readonly string[];
}

/** How long the private input list stays after ffmpeg started (it reads it at once). */
const INPUT_LIST_KEEP_MS = 5_000;

export class CameraPreview {
  private child: ChildProcess | null = null;
  private stopped = false;
  private failures = 0;
  private stderr = '';
  private restartTimer: NodeJS.Timeout | null = null;
  private launching: Promise<void> = Promise.resolve();
  private readonly spawnFn: SpawnFn;

  constructor(private readonly options: CameraPreviewOptions) {
    this.spawnFn =
      options.spawn ??
      ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions));
  }

  get running(): boolean {
    return this.child !== null;
  }

  async start(): Promise<void> {
    this.stopped = false;
    await mkdir(path.dirname(this.options.output), { recursive: true });
    await this.removeInputLists();
    this.launch();
  }

  /** Stop it, and take its frame away so nobody is shown a picture that is no longer live. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    await this.launching;
    const child = this.child;
    if (child !== null) {
      await new Promise<void>((resolve) => {
        const killer = setTimeout(() => child.kill('SIGKILL'), 3_000);
        child.once('exit', () => {
          clearTimeout(killer);
          resolve();
        });
        child.kill('SIGTERM');
      });
    }
    await rm(this.options.output, { force: true });
    await this.removeInputLists();
  }

  private launch(): void {
    this.launching = this.launchNow().catch(() => {
      this.exited(null);
    });
  }

  private async launchNow(): Promise<void> {
    if (this.stopped) return;
    this.stderr = '';
    let inputArgs = this.options.inputArgs;
    let listFile: string | null = null;
    if (inputArgs === undefined) {
      const hostname = new URL(this.options.stream.rtspUrl).hostname;
      if ((await (this.options.checkHost ?? hostRefusal)(hostname)) !== null) {
        this.exited(null);
        return;
      }
      listFile = path.join(this.options.workDir, `preview-input-${String(Date.now())}.ffconcat`);
      await mkdir(this.options.workDir, { recursive: true });
      await writeFile(listFile, ffconcatInput(streamAddress(this.options.stream)), {
        mode: 0o600,
      });
      inputArgs = rtspInputArgs(listFile);
    }
    if (this.stopped) {
      if (listFile !== null) await rm(listFile, { force: true });
      return;
    }
    const removeList = () => {
      if (listFile !== null) void rm(listFile, { force: true }).catch(() => undefined);
    };
    const child = this.spawnFn(
      this.options.ffmpeg.command,
      [
        ...(this.options.ffmpeg.prefix ?? []),
        ...previewArgs({ inputArgs, output: this.options.output }),
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], env: ffmpegEnv() },
    );
    if (listFile !== null) setTimeout(removeList, INPUT_LIST_KEEP_MS).unref();
    child.once('exit', removeList);
    this.child = child;
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-2_048);
    });
    child.once('error', () => {
      if (this.child === child) this.exited(null);
    });
    child.once('exit', (code) => {
      if (this.child === child) this.exited(code);
    });
  }

  private async removeInputLists(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.options.workDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (/^preview-input-\d+\.ffconcat$/.test(name)) {
        await rm(path.join(this.options.workDir, name), { force: true });
      }
    }
  }

  private exited(code: number | null): void {
    this.child = null;
    if (this.stopped) return;
    this.failures += 1;
    const delay = cameraReconnectDelayMs(this.failures);
    this.options.log.warn(
      {
        cameraId: this.options.cameraId,
        host: streamHost(this.options.stream.rtspUrl),
        reason: classifyFfmpegError(this.stderr, code),
        retryInMs: delay,
        ffmpeg:
          maskSecrets(this.stderr.trim().split('\n').slice(-2).join(' | '), this.options.stream) ||
          undefined,
      },
      'camera preview stopped',
    );
    this.restartTimer = setTimeout(() => this.launch(), delay);
    this.restartTimer.unref();
  }
}
