import { BASIS_POINTS, divideRounded } from '../money/index.js';

/**
 * Leads and their segment reports (architecture §1 "Leads: segment reports by product,
 * size, age and profession", §11; M18).
 *
 * A lead is somebody who asked and has not bought, or not yet. The four dimensions are the
 * client's; how each is grouped is D-258:
 *
 * - **product**: the catalog product of the SKU the lead asked about;
 * - **size**: as written, trimmed and upper-cased (`m`, ` M ` and `M` are one size);
 * - **age band**: a closed list, so "25-34" and "25 to 34" cannot be two rows;
 * - **profession**: free text, grouped case- and space-insensitively.
 *
 * A lead with no value for a dimension is counted under "not stated", last.
 */

export const AGE_BANDS = ['under_18', '18_24', '25_34', '35_44', '45_54', '55_plus'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const LEAD_STATUSES = ['new', 'contacted', 'converted', 'lost'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_DIMENSIONS = ['product', 'size', 'age_band', 'profession'] as const;
export type LeadDimension = (typeof LEAD_DIMENSIONS)[number];

export interface LeadFact {
  readonly product: { readonly id: string; readonly name: string } | null;
  readonly size: string | null;
  readonly ageBand: AgeBand | null;
  readonly profession: string | null;
  readonly status: LeadStatus;
}

export interface SegmentRow {
  /** The grouping key; null is "not stated". */
  readonly key: string | null;
  /** What to show for it: a product's name, the size, the band, the profession as first written. */
  readonly label: string | null;
  readonly leads: number;
  readonly converted: number;
  /** converted / leads, in basis points. */
  readonly conversionBps: bigint;
}

export function normaliseSize(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toUpperCase();
}

export function normaliseProfession(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function keyOf(
  lead: LeadFact,
  dimension: LeadDimension,
): { key: string | null; label: string | null } {
  switch (dimension) {
    case 'product':
      return lead.product === null
        ? { key: null, label: null }
        : { key: lead.product.id, label: lead.product.name };
    case 'size': {
      const size = lead.size === null ? '' : normaliseSize(lead.size);
      return size === '' ? { key: null, label: null } : { key: size, label: size };
    }
    case 'age_band':
      return { key: lead.ageBand, label: lead.ageBand };
    case 'profession': {
      const raw = lead.profession?.trim().replace(/\s+/g, ' ') ?? '';
      return raw === ''
        ? { key: null, label: null }
        : { key: normaliseProfession(raw), label: raw };
    }
  }
}

export function segmentReport(leads: readonly LeadFact[], dimension: LeadDimension): SegmentRow[] {
  const groups = new Map<
    string | null,
    { label: string | null; leads: number; converted: number }
  >();
  for (const lead of leads) {
    const { key, label } = keyOf(lead, dimension);
    const group = groups.get(key) ?? { label, leads: 0, converted: 0 };
    group.leads += 1;
    if (lead.status === 'converted') group.converted += 1;
    groups.set(key, group);
  }
  const rows: SegmentRow[] = [...groups].map(([key, group]) => ({
    key,
    label: group.label,
    leads: group.leads,
    converted: group.converted,
    conversionBps: divideRounded(BigInt(group.converted) * BASIS_POINTS, BigInt(group.leads)),
  }));
  const bandOrder = (key: string | null) =>
    key === null ? AGE_BANDS.length : AGE_BANDS.indexOf(key as AgeBand);
  return rows.sort((a, b) => {
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    // Age bands read youngest first; everything else by size of segment, then by name.
    if (dimension === 'age_band') return bandOrder(a.key) - bandOrder(b.key);
    if (a.leads !== b.leads) return b.leads - a.leads;
    return (a.label ?? '').localeCompare(b.label ?? '');
  });
}
