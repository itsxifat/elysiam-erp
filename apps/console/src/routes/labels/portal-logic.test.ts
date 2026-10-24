import { describe, expect, it } from 'vitest';

import {
  PORTAL_EMPTY,
  PORTAL_KEEP,
  portalReducer,
  shippedTotal,
  type PortalEntry,
} from './portal-logic.js';

/** The courier portal's list and counts (D-904): shipped parcels counted per courier, once. */

let key = 0;
function entry(patch: Partial<PortalEntry>): PortalEntry {
  key += 1;
  return {
    key,
    code: `ELY-2610-${String(key).padStart(5, '0')}`,
    outcome: 'shipped',
    orderNo: `ELY-2610-${String(key).padStart(5, '0')}`,
    courier: 'Steadfast',
    missing: [],
    lotCount: 1,
    message: null,
    ...patch,
  };
}

describe('the courier portal', () => {
  it('counts each courier’s shipped parcels, and nothing that did not ship', () => {
    let state = PORTAL_EMPTY;
    state = portalReducer(state, entry({}));
    state = portalReducer(state, entry({ courier: 'Pathao' }));
    state = portalReducer(state, entry({}));
    state = portalReducer(state, entry({ outcome: 'partial', missing: [2], lotCount: 2 }));
    state = portalReducer(state, entry({ outcome: 'refused', message: 'Not packed yet' }));
    state = portalReducer(state, entry({ outcome: 'already' }));
    state = portalReducer(state, entry({ courier: null }));

    expect(Object.fromEntries(state.shipped)).toEqual({ Steadfast: 2, Pathao: 1, '': 1 });
    expect(shippedTotal(state)).toBe(4);
    // Newest first.
    expect(state.entries[0]?.courier).toBeNull();
    expect(state.entries).toHaveLength(7);
  });

  it('keeps the newest scans on screen and the counts for the whole session', () => {
    let state = PORTAL_EMPTY;
    for (let index = 0; index < PORTAL_KEEP + 10; index += 1) {
      state = portalReducer(state, entry({}));
    }
    expect(state.entries).toHaveLength(PORTAL_KEEP);
    expect(shippedTotal(state)).toBe(PORTAL_KEEP + 10);
  });
});
