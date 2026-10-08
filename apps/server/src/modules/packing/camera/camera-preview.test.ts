import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { fakeFfmpeg, type FakeFfmpegRun } from '../../../testing/fake-ffmpeg.js';
import { CameraPreview, previewArgs, previewFile } from './camera-preview.js';
import { rtspInputArgs, streamAddress, type CameraStream } from './ffmpeg.js';

/**
 * The live preview's ffmpeg (M38c, D-683), against the stand-in: the arguments, the camera
 * opened the recording's safe way (a private list, the protocol whitelist, a bare environment,
 * the host checked), the frame written and taken away when the preview stops.
 */

const PASSWORD = 'Pr3view!p@ss';
const STREAM: CameraStream = {
  rtspUrl: 'rtsp://192.168.20.111:554/stream1',
  username: 'packing',
  password: PASSWORD,
};
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

let fake: Awaited<ReturnType<typeof fakeFfmpeg>>;
beforeAll(async () => {
  fake = await fakeFfmpeg();
});

const previews: CameraPreview[] = [];
afterEach(async () => {
  for (const preview of previews.splice(0)) await preview.stop();
});

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('the live preview’s ffmpeg', () => {
  it('writes three small frames a second over one JPEG, from the whitelisted input', () => {
    const args = previewArgs({
      inputArgs: rtspInputArgs('/buffer/preview-input-1.ffconcat'),
      output: '/preview/org/camera.jpg',
    });
    expect(args.join(' ')).toContain(
      '-map 0:v:0 -an -vf fps=3,scale=640:-2 -q:v 6 -update 1 -f image2 /preview/org/camera.jpg',
    );
    expect(args[args.indexOf('-protocol_whitelist') + 1]).toBe('file,rtsp,tcp');
    expect(args.indexOf('-protocol_whitelist')).toBeLessThan(args.indexOf('-i'));
    expect(args.join(' ')).not.toContain('rtsp://');
    expect(previewFile('/preview', 'org-1', 'cam-1')).toBe(
      path.join('/preview', 'org-1', 'cam-1.jpg'),
    );
  });

  it('opens the camera as the recording does and takes its frame away when it stops', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'erp-preview-work-'));
    const output = path.join(await mkdtemp(path.join(tmpdir(), 'erp-preview-')), 'org', 'cam.jpg');
    const record = path.join(fake.dir, `preview-${String(Date.now())}.jsonl`);
    const preview = new CameraPreview({
      cameraId: 'cam',
      stream: STREAM,
      workDir,
      output,
      ffmpeg: fake.command('frames', record),
      log: quiet,
    });
    previews.push(preview);
    await preview.start();
    await until(() => existsSync(output));
    const frame = await readFile(output);
    expect([frame[0], frame[1], frame.at(-2), frame.at(-1)]).toEqual([0xff, 0xd8, 0xff, 0xd9]);

    const [run] = (await readFile(record, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as FakeFfmpegRun);
    expect(run?.address).toBe(streamAddress(STREAM));
    expect(run?.args.join(' ')).not.toContain(PASSWORD);
    expect(run?.env.filter((name) => /SECRET|KEY|PASSWORD|DATABASE|AUTH/i.test(name))).toEqual([]);
    // The input list lives in the camera's private directory, never beside the frame.
    expect((await readdir(path.dirname(output))).every((name) => name.endsWith('.jpg'))).toBe(true);

    await preview.stop();
    expect(existsSync(output)).toBe(false);
    expect((await readdir(workDir)).filter((name) => name.endsWith('.ffconcat'))).toEqual([]);
  });

  it('never opens a host that is one of the server’s own', async () => {
    let spawned = 0;
    const preview = new CameraPreview({
      cameraId: 'cam',
      stream: { rtspUrl: 'rtsp://valkey:6379/', username: '', password: null },
      workDir: await mkdtemp(path.join(tmpdir(), 'erp-preview-work-')),
      output: path.join(await mkdtemp(path.join(tmpdir(), 'erp-preview-')), 'cam.jpg'),
      ffmpeg: fake.command('frames'),
      log: quiet,
      spawn: () => {
        spawned += 1;
        throw new Error('must not start');
      },
    });
    previews.push(preview);
    await preview.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(spawned).toBe(0);
    expect(preview.running).toBe(false);
  });
});
