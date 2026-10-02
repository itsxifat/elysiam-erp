import { z } from 'zod';

/**
 * The public intake's configuration (architecture §23; M11).
 *
 * Parsed once, when the module is built, and it distinguishes two kinds of wrong:
 *
 * * **Missing** secrets switch the intake *off*. A brand that has not set up a landing page
 *   has no `INTAKE_KEY_SECRET` or `TURNSTILE_SECRET_KEY`, and refusing to boot the API over
 *   that would take the order desk down for a landing-page setting. So the public endpoint
 *   answers 503 — fail closed, logged — and the rest of the API is untouched.
 * * **Unsafe** values refuse to start the process. A Turnstile bypass, a siteverify URL
 *   that is not Cloudflare's, or per-process rate limits in production are not a degraded
 *   mode: each one is the feature running with its protection removed, and nobody would
 *   notice from the outside. The only safe response is not to start.
 */

/** Cloudflare's documented siteverify endpoint. The only one production may use. */
export const TURNSTILE_SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

const flag = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((value) => value === 'true' || value === '1');

const schema = z.object({
  NODE_ENV: z.string().optional(),

  /**
   * The master key every site's signing secret is derived from (see
   * `packages/db/src/schema/intake`). 32 characters minimum, the same floor as
   * `AUTH_SECRET`: HMAC accepts any key, and a short one is the failure that looks fine.
   */
  INTAKE_KEY_SECRET: z
    .string()
    .min(32, 'INTAKE_KEY_SECRET must be at least 32 characters.')
    .optional(),

  /** Cloudflare Turnstile's secret key for this deployment's widgets. */
  TURNSTILE_SECRET_KEY: z.string().min(1).optional(),

  /**
   * Skip Turnstile entirely. For local development and tests only — refused outright when
   * `NODE_ENV=production` (see the refinement below).
   */
  INTAKE_TURNSTILE_BYPASS: flag,

  /**
   * Where siteverify is. Overridable so a test can point it at a local stub and exercise
   * the real client over real HTTP; production must use Cloudflare's own URL, for the
   * same reason the bypass is refused there.
   */
  INTAKE_TURNSTILE_VERIFY_URL: z.string().url().default(TURNSTILE_SITEVERIFY_URL),
  INTAKE_TURNSTILE_TIMEOUT_MS: z.coerce.number().int().min(200).max(15_000).default(3_000),

  /** §23: "an HMAC signature over body + timestamp, with a 5-minute window". */
  INTAKE_SIGNATURE_WINDOW_SECONDS: z.coerce.number().int().min(30).max(900).default(300),

  /*
   * §23: "rate limits per IP and per phone". Four buckets, because "per IP" means two
   * things here. The *source* address is the landing page's server, shared by every
   * visitor of that page, so its limit is generous and exists to stop a flood before any
   * signature is checked. The *visitor* address is the browser's, forwarded by the site
   * inside the signed body, and that is the one a bot filling the form is limited by.
   */
  INTAKE_RATE_SOURCE_IP_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(120),
  INTAKE_RATE_VISITOR_IP_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
  INTAKE_RATE_PHONE_PER_HOUR: z.coerce.number().int().min(1).max(10_000).default(5),
  INTAKE_RATE_SITE_PER_MINUTE: z.coerce.number().int().min(1).max(100_000).default(300),

  /** Where the counters live. Valkey in every real deployment (D-056's store). */
  INTAKE_RATE_LIMIT_STORE: z.enum(['valkey', 'memory']).default('valkey'),
});

export type IntakeConfig = z.infer<typeof schema>;

/** Thrown for a configuration production must never run with. */
export class UnsafeIntakeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeIntakeConfigError';
  }
}

export function intakeConfig(source: NodeJS.ProcessEnv = process.env): IntakeConfig {
  // `KEY=` in a dotenv file is an empty string, not an absent key, and `.env.example`
  // ships both secrets that way. Read as given, an empty secret failed its length check
  // and stopped the API — the opposite of "missing secrets switch the intake off".
  const present = Object.fromEntries(Object.entries(source).filter(([, value]) => value !== ''));
  const parsed = schema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .sort()
      .join('\n');
    throw new Error(`Invalid intake configuration:\n${problems}`);
  }
  const config = parsed.data;

  if (config.NODE_ENV === 'production') {
    if (config.INTAKE_TURNSTILE_BYPASS) {
      throw new UnsafeIntakeConfigError(
        'INTAKE_TURNSTILE_BYPASS is set in production. It removes the bot check from every ' +
          'public order form, so this process will not start with it. Unset it.',
      );
    }
    if (config.INTAKE_TURNSTILE_VERIFY_URL !== TURNSTILE_SITEVERIFY_URL) {
      throw new UnsafeIntakeConfigError(
        'INTAKE_TURNSTILE_VERIFY_URL points somewhere other than Cloudflare in production. ' +
          'Whatever answers there decides which bots may place orders; unset it.',
      );
    }
    if (config.INTAKE_RATE_LIMIT_STORE === 'memory') {
      throw new UnsafeIntakeConfigError(
        'INTAKE_RATE_LIMIT_STORE=memory in production makes every limit per process, so N ' +
          'replicas allow N times the published rate. Use valkey.',
      );
    }
  }
  return config;
}

/** The DI token, so a test can hand the module a config without touching the environment. */
export const INTAKE_CONFIG = Symbol('INTAKE_CONFIG');
