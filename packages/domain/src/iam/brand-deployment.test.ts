import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { checkBrandDeployment, type DeploymentOrgRow } from './index.js';

/** One brand per deployment (D-470, M31 check 1). */

const org = (slug: string, overrides: Partial<DeploymentOrgRow> = {}): DeploymentOrgRow => ({
  id: `id-${slug}`,
  slug,
  displayName: slug,
  legalName: slug,
  isActive: true,
  isTraining: false,
  ...overrides,
});

const training = org('training', { isTraining: true });

describe('checkBrandDeployment', () => {
  it('accepts the brand alone, and the brand beside the training org', () => {
    expect(checkBrandDeployment([org('acme')], 'acme')).toEqual({ ok: true, brand: org('acme') });
    expect(checkBrandDeployment([org('acme'), training], 'acme').ok).toBe(true);
  });

  it('refuses a database holding a second real brand, and names it for the operator', () => {
    const result = checkBrandDeployment([org('acme'), org('other-brand'), training], 'acme');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('other_brands');
    expect(result.message).toContain('other-brand');
    expect(result.message).toContain('database of its own');
  });

  it('counts a switched-off second brand as a second brand', () => {
    const result = checkBrandDeployment([org('acme'), org('old', { isActive: false })], 'acme');
    expect(result.ok).toBe(false);
  });

  it('refuses a missing, switched-off or training slug', () => {
    expect(checkBrandDeployment([], 'acme')).toMatchObject({ ok: false, reason: 'brand_missing' });
    expect(checkBrandDeployment([org('acme', { isActive: false })], 'acme')).toMatchObject({
      ok: false,
      reason: 'brand_inactive',
    });
    expect(checkBrandDeployment([training], 'training')).toMatchObject({
      ok: false,
      reason: 'brand_is_training',
    });
  });

  it('accepts exactly when the named brand is the only real one', () => {
    const slug = fc.stringMatching(/^[a-z]{1,8}$/);
    fc.assert(
      fc.property(
        fc.uniqueArray(slug, { maxLength: 6 }),
        fc.boolean(),
        slug,
        (slugs, withTraining, wanted) => {
          const rows = [
            ...slugs.filter((s) => s !== 'training').map((s) => org(s)),
            ...(withTraining ? [training] : []),
          ];
          const real = rows.filter((row) => !row.isTraining);
          const expected = real.length === 1 && real[0]?.slug === wanted;
          expect(checkBrandDeployment(rows, wanted).ok).toBe(expected);
        },
      ),
    );
  });
});
