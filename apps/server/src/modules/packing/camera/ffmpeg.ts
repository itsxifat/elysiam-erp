/**
 * How the camera process talks to ffmpeg (M38c, D-672, D-673): the stream's address with its
 * credentials, the arguments that record it into wall-clock segments without re-encoding, the
 * arguments that join segments into an MP4, what ffmpeg's complaints mean, and the masking
 * that keeps a camera's password out of every log line.
 *
 * No framework here and no database: plain functions the recorder, the cutter and their tests
 * share.
 */

/** A camera's stream as ffmpeg opens it. */
export interface CameraStream {
  /** `rtsp://host[:port]/path`, without credentials (the settings refuse them, D-668). */
  readonly rtspUrl: string;
  readonly username: string;
  /** The opened password, or null for a stream that needs none. Never logged. */
  readonly password: string | null;
}

/**
 * The address with the user name and password percent-encoded into it (ffmpeg's RTSP client
 * decodes them for Basic and Digest authentication). Never on ffmpeg's command line (ledger
 * audit W1): it goes into the private ffconcat list `ffconcatInput` writes, never logged,
 * never stored beyond that list's first seconds.
 */
export function streamAddress(stream: CameraStream): string {
  const url = new URL(stream.rtspUrl);
  if (stream.username === '' && stream.password === null) return url.toString();
  const user = encodeURIComponent(stream.username);
  const pass = stream.password === null ? '' : `:${encodeURIComponent(stream.password)}`;
  return `rtsp://${user}${pass}@${url.host}${url.pathname}${url.search}`;
}

/**
 * A text with every trace of a camera's credentials replaced: any `user:password@` in an
 * address, the password as typed and as encoded, the address with its credentials. For
 * ffmpeg's own error lines, which quote the input address in full.
 */
export function maskSecrets(text: string, stream: CameraStream | null): string {
  let masked = text.replace(/(rtsps?:\/\/)[^\s/@]*@/gi, '$1***@');
  if (stream !== null) {
    const secrets = [
      streamAddress(stream),
      stream.password,
      stream.password === null ? null : encodeURIComponent(stream.password),
    ].filter((value): value is string => value !== null && value.length >= 1);
    // Longest first, so the address goes before the password inside it.
    for (const secret of secrets.sort((a, b) => b.length - a.length)) {
      masked = masked.split(secret).join('***');
    }
  }
  return masked;
}

/** The camera's host, for a log line that must say which camera without saying how to log in. */
export function streamHost(rtspUrl: string): string {
  try {
    return new URL(rtspUrl).host;
  } catch {
    return 'camera';
  }
}

/** How long ffmpeg waits on a silent camera before it gives up (microseconds, ffmpeg ≥ 5). */
export const RTSP_SOCKET_TIMEOUT_US = 10_000_000;

/**
 * The private list ffmpeg reads the camera's address from (ledger audit W1): an ffconcat file
 * with the one stream and its RTSP options (TCP, the socket timeout). A command line is
 * readable by anyone on the host (`ps`, `/proc/<pid>/cmdline`, `docker top`); this file is
 * written 0600 in the camera's own buffer directory and removed seconds after ffmpeg read it,
 * so the password is on no command line. ffmpeg 5.1 (the image's) records an authenticated
 * RTSP stream this way (verified, `docs/review/M38c/`).
 */
export function ffconcatInput(address: string): string {
  return [
    'ffconcat version 1.0',
    `file '${address.replace(/'/g, "'\\''")}'`,
    'option rtsp_transport tcp',
    `option timeout ${String(RTSP_SOCKET_TIMEOUT_US)}`,
    '',
  ].join('\n');
}

/**
 * The input side of recording a camera: its private list (`ffconcatInput`) read by the concat
 * demuxer, and only the protocols that needs (ledger audit W3): `file` for the list, `rtsp`
 * and `tcp` for the stream, so no address can make ffmpeg read a local file, speak HTTP or
 * open UDP.
 */
export function rtspInputArgs(listFile: string): string[] {
  return ['-protocol_whitelist', 'file,rtsp,tcp', '-f', 'concat', '-safe', '0', '-i', listFile];
}

/**
 * The environment ffmpeg runs with (ledger audit W5): the path to find its libraries and the
 * clock's zone, nothing else, so none of the server's secrets reach it. Windows needs its
 * system root for a process to start at all (the tests' stand-in ffmpeg runs there).
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

/**
 * The whole recording command: the input, the first video stream only (no sound, D-611),
 * copied as it comes (no re-encoding), cut into roughly one-second MPEG-TS segments at the
 * stream's keyframes, numbered within this run. `codecArgs` is `-c copy` for a camera; a test
 * feeding raw frames passes an encoder instead.
 */
export function recordArgs(input: {
  readonly inputArgs: readonly string[];
  readonly outputPattern: string;
  readonly codecArgs?: readonly string[];
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
    ...(input.codecArgs ?? ['-c', 'copy']),
    '-f',
    'segment',
    '-segment_time',
    '1',
    '-segment_format',
    'mpegts',
    '-reset_timestamps',
    '1',
    input.outputPattern,
  ];
}

/**
 * Join segments listed in a concat file into one MP4 without re-encoding, its index at the
 * front so a browser plays it before it has all of it.
 */
export function concatArgs(input: {
  readonly listFile: string;
  readonly output: string;
}): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    // Only local files: the list and the buffered segments (ledger audit W3).
    '-protocol_whitelist',
    'file',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    input.listFile,
    '-map',
    '0:v:0',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    '-y',
    input.output,
  ];
}

/** A concat demuxer list: one `file '<path>'` line per segment, quotes escaped. */
export function concatList(paths: readonly string[]): string {
  return paths.map((path) => `file '${path.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

/** Why a camera's stream stopped, in a word the settings screen explains (D-673). */
export type CameraErrorCode =
  | 'auth_failed'
  | 'not_found'
  | 'unreachable'
  | 'timeout'
  | 'stream_ended'
  | 'stalled'
  | 'ffmpeg_missing'
  | 'credentials_unreadable'
  | 'address_refused'
  | 'disk_low'
  | 'stream_error';

/** What ffmpeg's last words mean. */
export function classifyFfmpegError(stderr: string, exitCode: number | null): CameraErrorCode {
  const text = stderr.toLowerCase();
  if (/401|unauthori[sz]ed|authorization failed|403|forbidden/.test(text)) return 'auth_failed';
  if (/404|not found|method describe failed/.test(text)) return 'not_found';
  if (
    /connection refused|no route to host|network is unreachable|host is down|failed to resolve hostname|name or service not known/.test(
      text,
    )
  ) {
    return 'unreachable';
  }
  if (/timed out|timeout/.test(text)) return 'timeout';
  if (exitCode === 0) return 'stream_ended';
  return 'stream_error';
}
