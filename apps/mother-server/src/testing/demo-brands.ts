import { SEED_ORG_IDS } from '@elysium/db';
import { seedDemoSetUp, startTestDatabase, type TestDatabase } from '@elysium/db/testing';
import { businessDate } from '@elysium/domain';

import { seedBrandFixture } from './brand-fixture.js';

/**
 * Two throwaway brand databases with working data, for a browser run or a local look at
 * the owner console: each bootstrapped and migrated by `@elysium/db`, seeded by its own
 * seed, then given rollups, books, orders, stock and staff (`seedBrandFixture`). On the
 * server `TEST_DATABASE_URL` names, or a Testcontainer when it is unset. Never on a
 * database anyone uses: the names are generated.
 */

export interface DemoBrand {
  readonly slug: string;
  readonly displayName: string;
  readonly database: TestDatabase;
}

export async function startDemoBrands(): Promise<{
  readonly brands: readonly DemoBrand[];
  stop(): Promise<void>;
}> {
  const today = businessDate(new Date());
  const elysium = SEED_ORG_IDS['elysium-lifestyle-bd'] ?? '';
  const oura = SEED_ORG_IDS['oura-lifestyle'] ?? '';

  const first = await startTestDatabase('demo_brand_a');
  await seedDemoSetUp(elysium);
  const provided = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = first.adminUrl;
  let second: TestDatabase;
  try {
    second = await startTestDatabase('demo_brand_b');
  } finally {
    if (provided === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = provided;
  }
  await seedDemoSetUp(oura);
  await seedBrandFixture({
    ownerUrl: first.ownerUrl,
    orgId: elysium,
    scale: 2,
    today,
    orderSeries: 1,
  });
  await seedBrandFixture({
    ownerUrl: second.ownerUrl,
    orgId: oura,
    scale: 3,
    today,
    orderSeries: 2,
  });

  return {
    brands: [
      { slug: 'elysium-lifestyle-bd', displayName: 'Elysium Lifestyle BD', database: first },
      { slug: 'oura-lifestyle', displayName: 'Oura Lifestyle', database: second },
    ],
    async stop() {
      await second.stop();
      await first.stop();
    },
  };
}
