/**
 * Every environment variable the application needs before it will boot, in one place.
 *
 * Three suites build the Nest application: the HTTP harness, `app.module.test.ts` and
 * `http-surface.test.ts`. Each had its own copy of this list, and the copies were only
 * equal by coincidence — so the day a module added a *required*
 * variable, two of the three stopped booting. The
 * failure was not readable either: Nest calls `process.abort()` on an initialisation
 * error, so the suite died with exit code 134 and no message at all.
 *
 * One list means a new required variable breaks one file, and the fix is one line here
 * rather than a hunt through whichever suites happened to boot the app.
 *
 * `??=` throughout, so a suite that wants to test a *missing* or malformed value can set
 * it first and still be heard.
 */
/**
 * The secret the test application signs with.
 *
 * Exported rather than read back off `process.env` at the call site: the assignment now
 * happens inside a function, so TypeScript can no longer narrow `process.env.AUTH_SECRET`
 * to a `string` there, and `secret: process.env.AUTH_SECRET` stopped compiling. A named
 * constant is also the honest shape — the value is decided here, not discovered.
 */
export const TEST_AUTH_SECRET = 'test-secret-that-is-at-least-32-characters-long';

export interface TestEnvOverrides {
  readonly databaseUrl?: string;
  readonly origin?: string;
  readonly appDomain?: string;
}

export function setServerTestEnv(overrides: TestEnvOverrides = {}): void {
  const origin = overrides.origin ?? 'http://localhost:3000';

  process.env.DATABASE_URL ??=
    overrides.databaseUrl ?? 'postgres://erp_app:x@127.0.0.1:5432/unused';
  process.env.APP_DOMAIN ??= overrides.appDomain ?? 'localhost';
  process.env.API_PUBLIC_URL ??= origin;
  process.env.AUTH_SECRET ??= TEST_AUTH_SECRET;
  process.env.TRUSTED_ORIGINS ??= origin;
  /*
   * Optional for the application to *boot* — M12's config marks it so, because the `fake`
   * adapter needs no credentials — but required to store one, and the route-matrix suite
   * calls `POST /v1/courier/accounts` for real. Without it that mutation fails for every
   * role, which the suite reads as "no audit row" rather than as a missing key.
   *
   * A fixed 32 bytes of base64, so a value written by one suite is readable by the next.
   */
  // M11: without the first, issuing a site key answers 503; the second keeps rate-limit
  // buckets in the process so a suite needs no Valkey.
  process.env.INTAKE_KEY_SECRET ??= 'test-intake-key-secret-at-least-32-characters';
  process.env.INTAKE_RATE_LIMIT_STORE ??= 'memory';
  // M33: the website API's counters in the process too.
  process.env.STOREFRONT_RATE_LIMIT_STORE ??= 'memory';
  process.env.COURIER_CREDENTIALS_KEY ??= Buffer.alloc(32, 7).toString('base64');
  // M18: sealing a brand's Meta token, as the courier key seals courier credentials.
  process.env.MARKETING_CREDENTIALS_KEY ??= Buffer.alloc(32, 9).toString('base64');
  // M34: the website's SSLCommerz and email server credentials, and queued email bodies.
  process.env.STOREFRONT_CREDENTIALS_KEY ??= Buffer.alloc(32, 11).toString('base64');
  // M34: emails are recorded, never sent, in a test.
  process.env.NOTIFY_EMAIL_PROVIDER ??= 'fake';
  process.env.STOREFRONT_SSLCOMMERZ_PROVIDER ??= 'fake';
  // The tests pay through a sandbox store, as a staging server would (ledger audit C1).
  process.env.STOREFRONT_SSLCOMMERZ_ALLOW_SANDBOX ??= 'true';
  // M47: a test never rings a phone through the owner's SIP server unless it names a stand-in.
  process.env.TELEPHONY_ENVO_PROVIDER ??= 'fake';
}

/**
 * The same list, but taking a database URL that must win over whatever is already set.
 *
 * A suite that starts its own Testcontainers database has to point the application at
 * *that* database, not at a URL a previously-imported module left behind.
 */
export function setServerTestEnvWithDatabase(
  databaseUrl: string,
  origin: string,
  appDomain: string,
): void {
  process.env.DATABASE_URL = databaseUrl;
  process.env.APP_DOMAIN = appDomain;
  process.env.API_PUBLIC_URL = origin;
  process.env.TRUSTED_ORIGINS = origin;
  setServerTestEnv({ databaseUrl, origin, appDomain });
}
