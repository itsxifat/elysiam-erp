import { createHmac } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalStorageDriver, R2StorageDriver, type StorageDriver } from '@elysium/integrations';
import { z } from 'zod';

/**
 * How the files module is configured (architecture §22, §28).
 *
 * Its own schema rather than more fields on `serverEnv()`, because every one of
 * these is optional in the deployment that does not use it: a developer needs
 * nothing at all, and the R2 keys are required only when the R2 driver is
 * selected. Folding them into the global schema would mean either marking them
 * optional there — which loses the "fail at boot, not at first query" property
 * for the deployment that *does* use them — or making every developer invent
 * four Cloudflare values.
 *
 * The conditional requirement is expressed with `superRefine` for that reason:
 * choosing `r2` without credentials stops the process at startup with a message
 * naming the missing variable, rather than at the first upload with a 500.
 */
const schema = z
  .object({
    STORAGE_DRIVER: z.enum(['local', 'r2']).default('local'),

    /**
     * Where the local driver keeps bytes.
     *
     * Under the OS temp directory by default, and deliberately not inside the
     * repository: a default that wrote into the working tree would put customer
     * uploads one `git add -A` away from being committed, which invariant 10
     * exists to prevent.
     */
    STORAGE_LOCAL_ROOT: z.string().min(1).default(path.join(tmpdir(), 'elysium-files')),

    R2_ACCOUNT_ID: z.string().min(1).optional(),
    R2_BUCKET: z.string().min(1).optional(),
    R2_ACCESS_KEY_ID: z.string().min(1).optional(),
    R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),
    /** The CDN hostname public objects are served from (§22). */
    R2_PUBLIC_BASE_URL: z.string().url().optional(),

    /**
     * How long a download URL lives.
     *
     * Five minutes: long enough for a browser to follow a redirect and for a
     * person on a slow connection to start the download, short enough that a
     * URL pasted into a chat has stopped working by the time anyone reads it.
     * Capped at an hour, because §22 says "short-lived" and a configurable
     * value with no ceiling is a configuration that will eventually say 30 days.
     */
    FILE_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(3600).default(300),

    /** How long an upload ticket lives. Longer: the client still has to send. */
    FILE_UPLOAD_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

    /** Gotenberg, from infra/docker-compose.dev.yml (§22). */
    GOTENBERG_URL: z.string().url().default('http://localhost:3030'),

    /**
     * Where the Bangla and Latin font files live.
     *
     * Defaulted by walking up to the workspace root, which works in the
     * repository and in `pnpm dev`. A container image that copies only
     * `apps/server/dist` has no `packages/ui`, so it sets this — and the error
     * when it is wrong names the variable rather than printing a missing-file
     * path nobody can act on.
     */
    PDF_FONT_DIR: z.string().min(1).optional(),
  })
  .superRefine((value, context) => {
    if (value.STORAGE_DRIVER !== 'r2') return;
    for (const key of [
      'R2_ACCOUNT_ID',
      'R2_BUCKET',
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ] as const) {
      if (value[key] === undefined) {
        context.addIssue({
          code: 'custom',
          path: [key],
          message: `${key} is required when STORAGE_DRIVER=r2.`,
        });
      }
    }
  });

export type FilesEnv = z.infer<typeof schema>;

let cached: FilesEnv | undefined;

export function filesEnv(): FilesEnv {
  cached ??= schema.parse(process.env);
  return cached;
}

/** Test-only: forget the parsed configuration so a suite can change it. */
export function resetFilesEnv(): void {
  cached = undefined;
}

/**
 * The key that signs local download URLs.
 *
 * Derived from `AUTH_SECRET` rather than being it. One secret used for two
 * purposes means a token minted for one is a token for the other if the payload
 * shapes ever coincide, and the cost of separating them is one HMAC at startup.
 * The label is versioned so the derivation can be rotated without rotating the
 * root secret.
 */
export function fileUrlSigningKey(authSecret: string): string {
  return createHmac('sha256', authSecret).update('elysium:file-url:v1').digest('hex');
}

/**
 * Build the driver this process will use.
 *
 * Chosen once, at module construction, so nothing downstream can pick a
 * different one per request — a service that could choose would eventually
 * choose wrong in a test and pass against the local driver while production ran
 * on R2.
 */
export function createStorageDriver(options: {
  readonly env: FilesEnv;
  readonly apiPublicUrl: string;
  readonly authSecret: string;
}): StorageDriver {
  const { env } = options;

  if (env.STORAGE_DRIVER === 'r2') {
    return new R2StorageDriver({
      // Non-null: `superRefine` above refuses to parse without them.
      accountId: env.R2_ACCOUNT_ID ?? '',
      bucket: env.R2_BUCKET ?? '',
      accessKeyId: env.R2_ACCESS_KEY_ID ?? '',
      secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '',
      publicBaseUrl: env.R2_PUBLIC_BASE_URL,
    });
  }

  return new LocalStorageDriver({
    root: env.STORAGE_LOCAL_ROOT,
    contentBaseUrl: `${options.apiPublicUrl.replace(/\/+$/, '')}/v1/files/content`,
    secret: fileUrlSigningKey(options.authSecret),
  });
}
