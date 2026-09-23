/**
 * Which origins are ours (architecture §6, §25 — D-035, D-053, D-054).
 *
 * Branded login means each brand gets its own hostname: `oura-lifestyle.<domain>`,
 * `orvo.<domain>`, and so on. Every one of those is a distinct browser origin, so
 * every one has to be trusted by CORS, by the CSRF origin check and by Better
 * Auth — three controls that must not be allowed to disagree.
 *
 * The obvious shortcut is to trust `*.<APP_DOMAIN>`. **That is wrong here, and
 * it was wrong in this file until an audit caught it.** The reasoning that looks
 * sound — "a subdomain can already read the CSRF cookie, so the wildcard grants
 * nothing new" — misses which control was doing the work. The cookie scope lets
 * a sibling subdomain *read* the token; CORS is what stops it *using* the token
 * against the API with `credentials: true`. Wildcarding removes that second
 * control, and the chain closes:
 *
 *   1. the CSRF cookie is deliberately script-readable and scoped to the parent
 *      domain, so any subdomain can read it;
 *   2. with the origin trusted, `fetch(api, { credentials: 'include' })` passes
 *      preflight;
 *   3. the session cookie is SameSite=Lax and the hosts are same-site, so it
 *      rides along;
 *   4. the double-submit check passes, because the token came from step 1.
 *
 * Full authenticated API access from any host under the domain. And the hosts
 * under this domain are not all ours to trust: D-026 puts landing sites on
 * Vercel with Puck-editable content, and §16 puts Chatwoot on the parent domain.
 * One dangling CNAME turns a subdomain takeover into an ERP takeover.
 *
 * So the list is **enumerated, never patterned**. The brands are known — they
 * are rows in `org.organizations` — so their origins are computed once at boot
 * and added explicitly. Adding a brand needs a restart, which is the right
 * trade for not having a wildcard in three security controls.
 */

export interface OriginPolicy {
  /** Exact origins. Nothing outside this set is ever trusted. */
  readonly trustedOrigins: readonly string[];
}

export function isTrustedOrigin(origin: string, policy: OriginPolicy): boolean {
  if (origin === '') return false;
  return policy.trustedOrigins.includes(origin);
}

/**
 * Expand the configured origins with one per brand hostname.
 *
 * For each listed origin, a sibling is produced for every brand slug on the same
 * scheme and port: `https://console.<domain>` plus slugs `oura-lifestyle`,
 * `orvo` yields `https://oura-lifestyle.<domain>` and `https://orvo.<domain>`.
 * Scheme and port are carried across rather than assumed, so a development list
 * on `http://localhost:5173` produces `http://oura-lifestyle.localhost:5173` and
 * nothing on any other port.
 *
 * The result is a plain list of exact origins. There is no pattern in it, which
 * means `isTrustedOrigin`, CORS and Better Auth all receive the same finite set
 * and cannot interpret it differently — Better Auth's `*` matches dots, so a
 * wildcard would have meant something wider there than here.
 */
export function withBrandOrigins(
  trustedOrigins: readonly string[],
  appDomain: string,
  slugs: readonly string[],
): string[] {
  const origins = new Set(trustedOrigins);

  for (const trusted of trustedOrigins) {
    let known: URL;
    try {
      known = new URL(trusted);
    } catch {
      // A malformed entry contributes nothing rather than failing boot; env
      // validation is where a bad value should be caught.
      continue;
    }

    const port = known.port === '' ? '' : `:${known.port}`;
    for (const slug of slugs) {
      // Slugs come from the database. Anything that is not a plain DNS label is
      // refused rather than concatenated into an origin.
      if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) continue;
      origins.add(`${known.protocol}//${slug}.${appDomain}${port}`);
    }
  }

  return [...origins];
}
