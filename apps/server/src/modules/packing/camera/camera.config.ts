import os from 'node:os';
import path from 'node:path';

import { z } from 'zod';

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

const schema = z.object({
  /**
   * Where the camera process keeps each camera's rolling buffer (M38c, D-672): a named volume
   * of its own on the brand server (`/data/camera` in the brand compose file). Half an hour of
   * a camera's stream at most, per camera.
   */
  CAMERA_BUFFER_DIR: optional(z.string().min(1)),
  /** The ffmpeg the camera process runs: the one the server image installs (D-675). */
  FFMPEG_PATH: optional(z.string().min(1)),
});

export interface CameraEnv {
  readonly bufferDir: string;
  readonly ffmpegPath: string;
}

export function cameraEnv(env: NodeJS.ProcessEnv = process.env): CameraEnv {
  const parsed = schema.parse(env);
  return {
    bufferDir: parsed.CAMERA_BUFFER_DIR ?? path.join(os.tmpdir(), 'erp-camera'),
    ffmpegPath: parsed.FFMPEG_PATH ?? 'ffmpeg',
  };
}
