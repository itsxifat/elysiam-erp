import { eq } from 'drizzle-orm';

import { withGlobal } from '../client.js';
import { organizations } from '../schema/org/index.js';

/**
 * Branded login (D-035).
 *
 * The client asked for a separate login per sister org. One identity with
 * several memberships is the right model underneath — a person works for three
 * of the five brands — so we meet the intent at the surface instead: the route
 * or hostname names an org, that org is preselected, and the screen carries its
 * branding.
 *
 * An unknown host falls back to the generic login rather than erroring. A
 * misconfigured DNS record should not mean nobody can sign in.
 */

export interface LoginBranding {
  readonly orgId: string | null;
  readonly slug: string | null;
  readonly displayName: string | null;
  /** The `brand` block from D-034: accent, logo, legal name, footer. */
  readonly brand: Record<string, unknown> | null;
  /** True when the host matched nothing and the generic login should render. */
  readonly generic: boolean;
}

export const GENERIC_LOGIN: LoginBranding = {
  orgId: null,
  slug: null,
  displayName: null,
  brand: null,
  generic: true,
};

/**
 * The org slug a hostname points at, if any.
 *
 * `oura.erp.example.com` -> `oura`. The bare apex and `www` resolve to nothing,
 * because they are the generic login. Case is normalised and a port is ignored,
 * since both vary between development and production.
 */
export function slugFromHost(host: string, appDomain: string): string | null {
  const hostname = host.toLowerCase().split(':')[0] ?? '';
  const domain = appDomain.toLowerCase();

  if (hostname === '' || hostname === domain) return null;
  if (!hostname.endsWith(`.${domain}`)) return null;

  const label = hostname.slice(0, -(domain.length + 1));
  // Only a single label. `a.b.erp.example.com` is not an org, it is a mistake.
  if (label === '' || label.includes('.') || label === 'www') return null;

  return label;
}

/** Resolve branding for a login screen, from a hostname or an explicit slug. */
export async function resolveLoginBranding(input: {
  readonly host?: string | undefined;
  readonly slug?: string | undefined;
  readonly appDomain: string;
}): Promise<LoginBranding> {
  const slug =
    input.slug ?? (input.host === undefined ? null : slugFromHost(input.host, input.appDomain));
  if (slug === null || slug === undefined || slug === '') return GENERIC_LOGIN;

  // `organizations` is global (§5 exception 5), so this needs no org context —
  // which is just as well, since it runs before anyone has chosen one.
  // `org.organizations` is global (§5 exception 5), so this needs no org
  // context — and no owner role either: erp_app holds the read grant.
  const [org] = await withGlobal(async (tx) =>
    tx
      .select({
        id: organizations.id,
        slug: organizations.slug,
        displayName: organizations.displayName,
        brand: organizations.brand,
        isActive: organizations.isActive,
      })
      .from(organizations)
      .where(eq(organizations.slug, slug)),
  );

  if (!org?.isActive) return GENERIC_LOGIN;

  return {
    orgId: org.id,
    slug: org.slug,
    displayName: org.displayName,
    brand: org.brand as Record<string, unknown>,
    generic: false,
  };
}

/**
 * The slugs of every active org, for the trusted-origin list (D-035, D-054).
 *
 * Branded login gives each brand its own hostname, and each hostname is an
 * origin CORS, CSRF and Better Auth must all trust. They are enumerated from
 * here at boot rather than matched with a wildcard — see
 * `apps/server/src/platform/http/origins.ts` for why a wildcard was wrong.
 */
export async function activeOrgSlugs(): Promise<string[]> {
  const rows = await withGlobal(async (tx) =>
    tx
      .select({ slug: organizations.slug })
      .from(organizations)
      .where(eq(organizations.isActive, true)),
  );

  return rows.map((row) => row.slug);
}
