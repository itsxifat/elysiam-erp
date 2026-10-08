import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { FfmpegCommand } from '../modules/packing/camera/camera-recorder.js';

/**
 * A stand-in for ffmpeg in the camera tests (M38c), for machines without it: a Node script run
 * as `node fake-ffmpeg.mjs <mode> <record file> <ffmpeg args…>`. It runs with whatever
 * environment the recorder gives it (a bare one, ledger audit W5), so it learns where to write
 * from its arguments, and writes there what it was given: its arguments, its environment's
 * names, and the camera address from an ffconcat input list (W1). Like ffmpeg, it quotes its
 * input in its errors, password and all, so a test can prove the recorder masks them.
 *
 * - `segments`: writes numbered segments into the output pattern every 200 ms;
 * - `auth`: says `401 Unauthorized` about its input and exits 1;
 * - `silent`: runs and writes nothing (a stalled stream);
 * - `concat`: joins the files of a concat list into the output, behind an MP4 `ftyp` box.
 */
const SCRIPT = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
const [mode, record, ...args] = process.argv.slice(2);
const output = args[args.length - 1];
const inputIndex = args.indexOf('-i');
const input = inputIndex >= 0 ? args[inputIndex + 1] : '';
let address = input;
if (input.endsWith('.ffconcat')) {
  const line = readFileSync(input, 'utf8').split('\n').find((entry) => entry.startsWith('file '));
  address = (line ?? '').replace(/^file '/, '').replace(/'$/, '');
}
if (record !== '-') {
  appendFileSync(record, JSON.stringify({ args, env: Object.keys(process.env), address }) + '\n');
}
process.stderr.write('ffmpeg called with: ' + args.join(' ') + '\n');
if (mode === 'auth') {
  process.stderr.write('[rtsp @ 0x55] method DESCRIBE failed: 401 Unauthorized\n');
  process.stderr.write("[concat @ 0x56] Impossible to open '" + address + "'\n");
  process.stderr.write(address + ': Server returned 401 Unauthorized (authorization failed)\n');
  process.exit(1);
}
if (mode === 'silent') {
  setInterval(() => {}, 1000);
}
if (mode === 'segments') {
  let index = 0;
  const write = () => {
    writeFileSync(output.replace('%09d', String(index).padStart(9, '0')), Buffer.alloc(1000 + index, 7));
    index += 1;
  };
  write();
  const timer = setInterval(write, 200);
  process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
}
if (mode === 'concat') {
  const list = readFileSync(input, 'utf8').trim().split('\n')
    .map((line) => line.replace(/^file '/, '').replace(/'$/, '').replace(/'\\''/g, "'"));
  const head = Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32]);
  writeFileSync(output, Buffer.concat([head, ...list.map((file) => readFileSync(file))]));
  process.exit(0);
}
`;

export type FakeFfmpegMode = 'segments' | 'auth' | 'silent' | 'concat';

/**
 * Write the fake ffmpeg into a fresh directory and say how to run it in a mode, recording what
 * it was given into `record` (one JSON line per run) when one is named.
 */
export async function fakeFfmpeg(): Promise<{
  readonly dir: string;
  readonly command: (mode: FakeFfmpegMode, record?: string) => FfmpegCommand;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'erp-fake-ffmpeg-'));
  const script = path.join(dir, 'fake-ffmpeg.mjs');
  await writeFile(script, SCRIPT);
  return {
    dir,
    command: (mode, record) => ({
      command: process.execPath,
      prefix: [script, mode, record ?? '-'],
    }),
  };
}

/** What a fake ffmpeg run was given. */
export interface FakeFfmpegRun {
  readonly args: readonly string[];
  readonly env: readonly string[];
  readonly address: string;
}
