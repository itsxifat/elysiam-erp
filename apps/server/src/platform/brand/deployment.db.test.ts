import { seedTrainingOrg } from '@elysium/db';
import { startTestDatabase, stopSharedContainer, type TestDatabase } from '@elysium/db/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { BrandDeploymentError, loadDeploymentBrand } from './deployment.js';

/**
 * One brand per deployment, against a real database (D-470, M31 check 1).
 *
 * The API and the worker call `loadDeploymentBrand` first thing in their boot and let its
 * error end the process (`main.api.ts`, `main.worker.ts`); the pure rule is tested in
 * `packages/domain/src/iam/brand-deployment.test.ts`.
 */

let database: TestDatabase | undefined;

afterAll(async () => {
  await database?.stop();
  await stopSharedContainer();
}, 60_000);

describe('loadDeploymentBrand', () => {
  it('is off without a slug', async () => {
    expect(await loadDeploymentBrand(undefined)).toBeNull();
  });

  it('refuses a database that holds a second real brand, naming the problem', async () => {
    database = await startTestDatabase('brandguard_many');
    const refusal = await loadDeploymentBrand('oura-lifestyle').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(BrandDeploymentError);
    expect((refusal as Error).message).toContain('ERP_BRAND_SLUG is "oura-lifestyle"');
    expect((refusal as Error).message).toContain('4 other brands');
    expect((refusal as Error).message).toContain('database of its own');
    await database.stop();
    database = undefined;
  }, 300_000);

  it('accepts a database seeded with that brand alone, beside the training org', async () => {
    database = await startTestDatabase('brandguard_one', { brands: ['oura-lifestyle'] });
    await seedTrainingOrg();
    const brand = await loadDeploymentBrand('oura-lifestyle');
    expect(brand).toMatchObject({ slug: 'oura-lifestyle', isTraining: false, isActive: true });
    await expect(loadDeploymentBrand('orvo')).rejects.toThrow(/no organization with that slug/);
    await expect(loadDeploymentBrand('training')).rejects.toThrow(/training organization/);
  }, 300_000);
});
