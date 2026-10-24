/**
 * The courier portal's bookkeeping (D-904): what each scan came to, newest first, and how many
 * parcels went to each courier this session. Pure, so the counting is tested without a browser.
 */

export type PortalOutcome =
  /** The order's last lot: it went to the courier, and is shipped. */
  | 'shipped'
  /** A lot of several, scanned; the others are still to come. */
  | 'partial'
  /** Scanned before, or the order is already with the courier. */
  | 'already'
  /** Refused: not packed, unknown code, a lot of another count. */
  | 'refused';

export interface PortalEntry {
  readonly key: number;
  readonly code: string;
  readonly outcome: PortalOutcome;
  readonly orderNo: string | null;
  readonly courier: string | null;
  /** For `partial`: the lots still to scan. */
  readonly missing: readonly number[];
  readonly lotCount: number;
  /** For `refused`: the server's sentence. */
  readonly message: string | null;
}

export interface PortalState {
  readonly entries: readonly PortalEntry[];
  /** Parcels shipped this session, per courier name (`''` for an order with none). */
  readonly shipped: ReadonlyMap<string, number>;
}

export const PORTAL_EMPTY: PortalState = { entries: [], shipped: new Map() };

/** The most scans the list keeps on screen. */
export const PORTAL_KEEP = 30;

export function portalReducer(state: PortalState, entry: PortalEntry): PortalState {
  const entries = [entry, ...state.entries].slice(0, PORTAL_KEEP);
  if (entry.outcome !== 'shipped') return { entries, shipped: state.shipped };
  const shipped = new Map(state.shipped);
  const courier = entry.courier ?? '';
  shipped.set(courier, (shipped.get(courier) ?? 0) + 1);
  return { entries, shipped };
}

/** Every parcel shipped this session. */
export function shippedTotal(state: PortalState): number {
  let total = 0;
  for (const count of state.shipped.values()) total += count;
  return total;
}
