import os from 'node:os';
import path from 'node:path';

import { baseEnvShape } from '@elysium/config/env';
import { BRAND_SLUG_PATTERN } from '@elysium/domain/iam';
import { z } from 'zod';

const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (value === '' ? undefined : value), schema.optional());

/**
 * The camera process's whole configuration (M38c ledger audit, W5): what it needs and nothing
 * else, so its container is not handed the brand's other secrets (the auth secret, the HR,
 * courier and marketing keys, the owner URL). The database as the application role, the
 * brand, the sealing key for the cameras' passwords (`STOREFRONT_CREDENTIALS_KEY`, read by
 * the sealed box itself), the files storage (`filesEnv`), the error reporting
 * (`instrument.ts`), and its own buffer settings. It never calls `serverEnv()`.
 */
const schema = z.object({
  ...baseEnvShape,
  LOG_DESTINATION: z.enum(['stdout', 'stderr']).default('stdout'),
  DATABASE_URL: z.string().url().startsWith('postgres'),
  /** The deployment's brand: only its cameras are recorded (ledger audit N3). */
  ERP_BRAND_SLUG: optional(
    z.string().regex(BRAND_SLUG_PATTERN, 'A brand slug: a-z, 0-9 and dashes.'),
  ),
  /**
   * Where the camera process keeps each camera's rolling buffer (D-672): a named volume of its
   * own on the brand server (`/data/camera` in the brand compose file).
   */
  CAMERA_BUFFER_DIR: optional(z.string().min(1)),
  /** The ffmpeg the camera process runs: the one the server image installs (D-675). */
  FFMPEG_PATH: optional(z.string().min(1)),
  /** Each camera's buffer at most, in bytes (W6): 2 GiB unless set. */
  CAMERA_BUFFER_MAX_BYTES: optional(
    z.coerce
      .number()
      .int()
      .min(64 * 1024 * 1024),
  ),
  /** Below this much free disk no camera buffers (W6): 5 GiB unless set. */
  CAMERA_MIN_FREE_BYTES: optional(z.coerce.number().int().min(0)),
});

export type CameraProcessEnv = z.infer<typeof schema>;

export function cameraProcessEnv(env: NodeJS.ProcessEnv = process.env): CameraProcessEnv {
  return schema.parse(env);
}

export interface CameraEnv {
  readonly bufferDir: string;
  readonly ffmpegPath: string;
}

export function cameraEnv(env: NodeJS.ProcessEnv = process.env): CameraEnv {
  const parsed = cameraProcessEnv(env);
  return {
    bufferDir: parsed.CAMERA_BUFFER_DIR ?? path.join(os.tmpdir(), 'erp-camera'),
    ffmpegPath: parsed.FFMPEG_PATH ?? 'ffmpeg',
  };
}

/**
 * The variables the brand compose file gives the camera service (W5): a test checks the
 * compose file lists exactly these, and that none is another module's secret.
 */
export const CAMERA_SERVICE_ENV = [
  'NODE_ENV',
  'LOG_LEVEL',
  'ERP_BRAND_SLUG',
  'DATABASE_URL',
  'STOREFRONT_CREDENTIALS_KEY',
  'STOREFRONT_CREDENTIALS_KEY_ID',
  'STORAGE_DRIVER',
  'STORAGE_LOCAL_ROOT',
  'R2_ACCOUNT_ID',
  'R2_BUCKET',
  'R2_ACCESS_KEY_ID',
  'R2_SECRET_ACCESS_KEY',
  'SENTRY_DSN',
  'SENTRY_ENVIRONMENT',
  'CAMERA_BUFFER_DIR',
] as const;
