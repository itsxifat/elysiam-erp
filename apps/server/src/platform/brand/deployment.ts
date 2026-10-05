import { withGlobal } from '@elysium/db';
import { checkBrandDeployment, type DeploymentOrgRow } from '@elysium/domain/iam';
import { sql } from 'drizzle-orm';

/**
 * The deployment's brand, checked at boot (D-470, M31 check 1).
 *
 * Every brand's ERP is a deployment of its own with a database of its own. When
 * `ERP_BRAND_SLUG` is set, the API and the worker read every org row before they start and
 * refuse unless the database holds that brand and no other real one; the training org is
 * allowed beside it. A database that holds a second brand is a database someone pointed
 * at the wrong deployment, and serving it would show one brand's staff another's data.
 *
 * Unset returns `null`: the many-brand mode of the tests and local development.
 */

export class BrandDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrandDeploymentError';
  }
}

export type DeploymentBrand = DeploymentOrgRow;

export async function loadDeploymentBrand(
  slug: string | undefined,
): Promise<DeploymentBrand | null> {
  if (slug === undefined) return null;
  const result = checkBrandDeployment(await organizations(), slug);
  if (!result.ok) throw new BrandDeploymentError(result.message);
  return result.brand;
}

/**
 * The brand an operator's command on the server acts for (`main.admin.ts`'s website
 * commands, D-582). With `ERP_BRAND_SLUG` set, that brand, checked exactly as the API checks
 * it at boot. Unset, the database's one brand beside the training org. Anything else is
 * refused rather than guessed: a website key issued for the wrong brand would read that
 * brand's shop.
 */
export async function commandBrand(slug: string | undefined): Promise<DeploymentBrand> {
  const named = slug?.trim();
  if (named !== undefined && named !== '') {
    const brand = await loadDeploymentBrand(named);
    if (brand === null) throw new BrandDeploymentError('No brand named.');
    return brand;
  }
  const brands = (await organizations()).filter((org) => !org.isTraining);
  const [only] = brands;
  if (only === undefined) {
    throw new BrandDeploymentError(
      'This database holds no brand yet. Seed it first: pnpm db:seed --brand <slug>.',
    );
  }
  if (brands.length > 1) {
    const names = brands
      .map((org) => org.slug)
      .sort()
      .join(', ');
    throw new BrandDeploymentError(
      `This database holds ${String(brands.length)} brands (${names}). Set ERP_BRAND_SLUG to the brand this is for.`,
    );
  }
  if (!only.isActive) {
    throw new BrandDeploymentError(`This database's brand, "${only.slug}", is switched off.`);
  }
  return only;
}

/** Every org row, active or not. `org.organizations` is global (§5 exception 5). */
async function organizations(): Promise<DeploymentOrgRow[]> {
  const rows = await withGlobal(async (tx) =>
    tx.execute<{
      id: string;
      slug: string;
      display_name: string;
      legal_name: string;
      is_active: boolean;
      is_training: boolean;
    }>(sql`
      select id, slug, display_name, legal_name, is_active, is_training
      from org.organizations
    `),
  );
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    legalName: row.legal_name,
    isActive: row.is_active,
    isTraining: row.is_training,
  }));
}
