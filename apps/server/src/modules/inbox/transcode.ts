import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { VoiceFormat } from '@elysium/domain/inbox';

/**
 * A recording turned into a channel's format with ffmpeg (M45, D-781): the server image's own
 * ffmpeg (Debian's, D-675), `FFMPEG_PATH` else `ffmpeg` on the path.
 *
 * - WhatsApp: Ogg with Opus, mono, 48 kHz, 24 kbit/s in VoIP mode. WhatsApp wants "OPUS codecs
 *   only … mono input only" for a voice note, and 24 kbit/s keeps two minutes under the 512 KB
 *   its play button needs.
 * - Messenger and Instagram: M4A (AAC-LC in an MP4 audio container, ffmpeg's `ipod` muxer),
 *   mono, 44.1 kHz, 64 kbit/s, its index at the front.
 *
 * Only local files are opened (`-protocol_whitelist file`), the input is decoded for its first
 * audio stream only (`-vn`, no metadata carried over), the environment holds only the path and
 * the clock (`ffmpegEnv`, M38c), and a run that takes longer than a minute is killed. Never
 * inside a transaction (invariant 6): the caller reads the bytes, transcodes, then writes.
 */

/**
 * The environment ffmpeg runs with: the path to find its libraries and the clock's zone, nothing
 * else, so none of the server's secrets reach it (the camera's rule, M38c's ledger audit W5;
 * repeated here rather than imported, as modules share only their APIs, invariant 12). Windows
 * needs its system root for a process to start at all.
 */
export function ffmpegEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    PATH: env.PATH ?? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    ...(env.TZ === undefined ? {} : { TZ: env.TZ }),
    ...(process.platform === 'win32' && env.SystemRoot !== undefined
      ? { SystemRoot: env.SystemRoot }
      : {}),
  };
}

/** ffmpeg's arguments for one conversion. */
export function voiceArgs(input: string, output: string, format: VoiceFormat): string[] {
  const codec =
    format.container === 'ogg'
      ? ['-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', '-ar', '48000']
      : ['-c:a', 'aac', '-b:a', '64k', '-ar', '44100', '-movflags', '+faststart'];
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-protocol_whitelist',
    'file',
    '-i',
    input,
    '-vn',
    '-map',
    '0:a:0',
    '-map_metadata',
    '-1',
    '-ac',
    '1',
    ...codec,
    '-f',
    format.container,
    '-y',
    output,
  ];
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: { readonly stdio: ['ignore', 'ignore', 'pipe']; readonly env: NodeJS.ProcessEnv },
) => ChildProcess;

export interface TranscodeOptions {
  readonly ffmpegPath: string;
  /** Where the input and output are written for the run; the system's temp directory else. */
  readonly workDir?: string;
  readonly timeoutMs?: number;
  /** Injected so the tests run a stand-in, never a real ffmpeg they may not have. */
  readonly spawn?: SpawnFn;
}

export class TranscodeFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscodeFailed';
  }
}

/** The largest output kept: a two-minute voice note is a few hundred kilobytes. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export async function transcodeVoice(
  bytes: Uint8Array,
  format: VoiceFormat,
  options: TranscodeOptions,
): Promise<Uint8Array> {
  const dir = path.join(options.workDir ?? tmpdir(), `erp-voice-${randomUUID()}`);
  await mkdir(dir, { recursive: true });
  const input = path.join(dir, 'input');
  const output = path.join(dir, `voice.${format.extension}`);
  const run: SpawnFn =
    options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, [...args], spawnOptions));
  try {
    await writeFile(input, bytes, { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = run(options.ffmpegPath, voiceArgs(input, output, format), {
        stdio: ['ignore', 'ignore', 'pipe'],
        env: ffmpegEnv(),
      });
      let stderr = '';
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        stderr = (stderr + chunk).slice(-1_024);
      });
      const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 60_000);
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(
          new TranscodeFailed(
            `ffmpeg could not start: ${(error as { code?: string }).code ?? 'error'}`,
          ),
        );
      });
      child.once('exit', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else
          reject(
            new TranscodeFailed(
              `ffmpeg could not convert the recording (${signal ?? String(code)}): ${stderr
                .trim()
                .split('\n')
                .slice(-2)
                .join(' | ')}`,
            ),
          );
      });
    });
    const converted = await readFile(output);
    if (converted.byteLength === 0 || converted.byteLength > MAX_OUTPUT_BYTES) {
      throw new TranscodeFailed('ffmpeg produced no usable audio.');
    }
    return new Uint8Array(converted);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
