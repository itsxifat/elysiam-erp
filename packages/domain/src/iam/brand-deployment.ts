/**
 * One brand per deployment (D-470, M31).
 *
 * A brand's ERP runs on a database of its own. The deployment names its brand
 * (`ERP_BRAND_SLUG`), and the API and the worker refuse to start unless the database holds
 * that brand and no other real one. The training org (`is_training`) is allowed beside it:
 * it is practice data, never shown as a brand, and the importers' rehearsal needs it.
 *
 * Unset means the many-brand mode the tests and local development keep; this check is not
 * run then.
 */

export interface DeploymentOrgRow {
  readonly id: string;
  readonly slug: string;
  readonly displayName: string;
  readonly legalName: string;
  readonly isActive: boolean;
  readonly isTraining: boolean;
}

export type BrandDeploymentCheck =
  | { readonly ok: true; readonly brand: DeploymentOrgRow }
  | {
      readonly ok: false;
      readonly reason: 'brand_missing' | 'brand_inactive' | 'brand_is_training' | 'other_brands';
      /** For the operator's log only: what is wrong, in one sentence. */
      readonly message: string;
    };

/** The slug grammar the seed and `org.organizations` use. */
export const BRAND_SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/**
 * Does this database fit a deployment of `slug`? Every org row, active or not, is passed:
 * a switched-off second brand is still a second brand's data in this database.
 */
export function checkBrandDeployment(
  orgs: readonly DeploymentOrgRow[],
  slug: string,
): BrandDeploymentCheck {
  const brand = orgs.find((org) => org.slug === slug);
  if (brand === undefined) {
    return {
      ok: false,
      reason: 'brand_missing',
      message: `ERP_BRAND_SLUG is "${slug}", but this database has no organization with that slug. Seed it first: pnpm db:seed --brand ${slug}.`,
    };
  }
  if (brand.isTraining) {
    return {
      ok: false,
      reason: 'brand_is_training',
      message: `ERP_BRAND_SLUG is "${slug}", which is the training organization, not a brand.`,
    };
  }
  if (!brand.isActive) {
    return {
      ok: false,
      reason: 'brand_inactive',
      message: `ERP_BRAND_SLUG is "${slug}", but that organization is switched off in this database.`,
    };
  }
  const others = orgs.filter((org) => org.slug !== slug && !org.isTraining);
  if (others.length > 0) {
    const names = others
      .map((org) => org.slug)
      .sort()
      .join(', ');
    return {
      ok: false,
      reason: 'other_brands',
      message: `ERP_BRAND_SLUG is "${slug}", but this database also holds ${String(others.length)} other brand${others.length === 1 ? '' : 's'} (${names}). A brand's ERP runs on a database of its own (D-470): give this deployment a fresh database and seed only this brand.`,
    };
  }
  return { ok: true, brand };
}
