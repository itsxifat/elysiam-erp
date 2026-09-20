import { createEnv } from '@elysium/config/env';
import { z } from 'zod';

/**
 * Landing-site configuration, validated at module load so a missing variable
 * fails the build rather than the first request. Only `NEXT_PUBLIC_` values
 * reach the browser.
 */
const schema = z.object({
  NEXT_PUBLIC_API_URL: z.string().url(),
});

export const env = createEnv('sites', schema);
