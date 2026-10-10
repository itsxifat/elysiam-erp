import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { fakeFfmpeg, type FakeFfmpegRun } from '../../../testing/fake-ffmpeg.js';
import type { AuditService } from '../../../platform/audit/audit.service.js';
import type { FilesApi } from '../../files/files.api.js';
import { freshFrame } from '../camera-settings.service.js';
import { CameraProcessService } from './camera-process.service.js';
import {
  CameraPreview,
  previewArgs,
  previewFile,
  removeCameraInputLists,
} from './camera-preview.js';
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

describe('nothing holding a camera password or picture is left behind (preview fixes)', () => {
  it('removes every private input list of a camera, recording and preview, and nothing else', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'erp-lists-'));
    for (const name of [
      'input-1791400000000.ffconcat',
      'preview-input-1791400000001.ffconcat',
      'seg-1791400000000-1791400001000.ts',
      'notes.txt',
    ]) {
      await writeFile(path.join(dir, name), 'x');
    }
    expect(await removeCameraInputLists(dir)).toBe(2);
    expect((await readdir(dir)).sort()).toEqual([
      'notes.txt',
      'seg-1791400000000-1791400001000.ts',
    ]);
    expect(await removeCameraInputLists(path.join(dir, 'missing'))).toBe(0);
  });

  it('removes its list at once when ffmpeg cannot be started (W3)', async () => {
    const workDir = await mkdtemp(path.join(tmpdir(), 'erp-preview-work-'));
    const preview = new CameraPreview({
      cameraId: 'cam',
      stream: STREAM,
      workDir,
      output: path.join(await mkdtemp(path.join(tmpdir(), 'erp-preview-')), 'cam.jpg'),
      ffmpeg: fake.command('frames'),
      log: quiet,
      checkHost: () => Promise.resolve(null),
      spawn: () => {
        throw new Error('cannot start');
      },
    });
    previews.push(preview);
    await preview.start();
    await until(async () => (await readdir(workDir)).every((name) => !name.endsWith('.ffconcat')));
    expect(preview.running).toBe(false);
  });

  it('starts nothing when stopped while the host is being checked, and says a refused host (N4)', async () => {
    let release: (value: string | null) => void = () => undefined;
    let spawned = 0;
    const lines: string[] = [];
    const preview = new CameraPreview({
      cameraId: 'cam',
      stream: STREAM,
      workDir: await mkdtemp(path.join(tmpdir(), 'erp-preview-work-')),
      output: path.join(await mkdtemp(path.join(tmpdir(), 'erp-preview-')), 'cam.jpg'),
      ffmpeg: fake.command('frames'),
      log: { ...quiet, warn: (fields) => lines.push(JSON.stringify(fields)) },
      checkHost: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
      spawn: () => {
        spawned += 1;
        throw new Error('must not start');
      },
    });
    await preview.start();
    const stopping = preview.stop();
    release(null);
    await stopping;
    expect(spawned).toBe(0);

    const refused = new CameraPreview({
      cameraId: 'cam',
      stream: STREAM,
      workDir: await mkdtemp(path.join(tmpdir(), 'erp-preview-work-')),
      output: path.join(await mkdtemp(path.join(tmpdir(), 'erp-preview-')), 'cam.jpg'),
      ffmpeg: fake.command('frames'),
      log: { ...quiet, warn: (fields) => lines.push(JSON.stringify(fields)) },
      checkHost: () => Promise.resolve('loopback'),
    });
    previews.push(refused);
    await refused.start();
    await until(() => lines.some((line) => line.includes('address_refused')));
  });

  it('clears an earlier process’s frames and lists when the camera process starts', async () => {
    const bufferRoot = await mkdtemp(path.join(tmpdir(), 'erp-cam-'));
    const previewRoot = await mkdtemp(path.join(tmpdir(), 'erp-cam-preview-'));
    const org = '6b0f3a0e-8f0e-4c55-9d0b-2b4a1f2b7c11';
    const camera = '7c1f4b1f-9f1f-4d66-8e1c-3c5b2a3c8d22';
    const cameraDir = path.join(bufferRoot, org, camera);
    await mkdir(cameraDir, { recursive: true });
    await writeFile(path.join(cameraDir, 'input-1.ffconcat'), 'rtsp://user:secret@host/x');
    await writeFile(path.join(cameraDir, 'preview-input-2.ffconcat'), 'rtsp://user:secret@host/x');
    await writeFile(path.join(cameraDir, 'seg-1791400000000-1791400001000.ts'), 'video');
    await mkdir(path.join(previewRoot, org), { recursive: true });
    await writeFile(previewFile(previewRoot, org, camera), 'old frame');
    const service = new CameraProcessService({} as FilesApi, {} as AuditService);
    service.configure({ bufferRoot, previewRoot, ffmpeg: fake.command('frames'), log: quiet });
    await service.adoptBuffers();
    expect(await readdir(cameraDir)).toEqual(['seg-1791400000000-1791400001000.ts']);
    expect(await readdir(previewRoot)).toEqual([]);
  });
});

describe('the frame the API serves (N1)', () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0xff, 0xd9]);

  it('serves a fresh, whole JPEG and nothing else', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'erp-frame-'));
    const file = path.join(dir, 'cam.jpg');
    await writeFile(file, jpeg);
    expect(await freshFrame(file)).toEqual(jpeg);
    expect(await freshFrame(file, new Date(Date.now() + 10_000))).toBeNull();
    await writeFile(file, jpeg.subarray(0, 5));
    expect(await freshFrame(file)).toBeNull();
    expect(await freshFrame(path.join(dir, 'none.jpg'))).toBeNull();
    await mkdir(path.join(dir, 'folder.jpg'));
    expect(await freshFrame(path.join(dir, 'folder.jpg'))).toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'never follows a symbolic link (skipped on Windows, where making one needs rights)',
    async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'erp-frame-'));
      await writeFile(path.join(dir, 'real.jpg'), jpeg);
      await symlink(path.join(dir, 'real.jpg'), path.join(dir, 'cam.jpg'));
      expect(await freshFrame(path.join(dir, 'cam.jpg'))).toBeNull();
    },
  );
});
