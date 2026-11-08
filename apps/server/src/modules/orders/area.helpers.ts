import type { Tx } from '@elysium/db';

import * as repo from './orders.repository.js';
import { OrdersError } from './orders.errors.js';

/**
 * The district and thana an address names, checked against the reference data (D2: the thana
 * inside the district), or both null when it names neither (D-953). One without the other is
 * refused rather than half kept.
 */
export async function checkedArea(
  tx: Tx,
  address: {
    readonly districtId?: number | null | undefined;
    readonly thanaId?: number | null | undefined;
  },
): Promise<{ districtId: number | null; thanaId: number | null }> {
  const districtId = address.districtId ?? null;
  const thanaId = address.thanaId ?? null;
  if (districtId === null && thanaId === null) return { districtId: null, thanaId: null };
  if (
    districtId === null ||
    thanaId === null ||
    !(await repo.areaExists(tx, districtId, thanaId))
  ) {
    throw new OrdersError(
      'VALIDATION_FAILED',
      'That thana is not one of the district’s. Choose the district, then a thana in it, or leave both out.',
    );
  }
  return { districtId, thanaId };
}
