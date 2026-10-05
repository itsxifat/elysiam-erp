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
  // `org.organizations` is global (§5 exception 5): erp_app reads it with no org chosen.
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
  const result = checkBrandDeployment(
    rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      displayName: row.display_name,
      legalName: row.legal_name,
      isActive: row.is_active,
      isTraining: row.is_training,
    })),
    slug,
  );
  if (!result.ok) throw new BrandDeploymentError(result.message);
  return result.brand;
}
