import { businessDate, isIsoDate, type IsoDate } from '@elysium/domain';
import { presetRange, type DateRange, type RangePreset } from '@elysium/mother-shared';

/**
 * The period every figure screen is scoped to, kept in the address bar (§24) so a link to
 * a view opens the same view. Asia/Dhaka calendar dates (invariant 8).
 */

export interface RangeSearch {
  readonly from?: string;
  readonly to?: string;
}

export function todayInDhaka(): IsoDate {
  return businessDate(new Date());
}

export function validateRangeSearch(search: Record<string, unknown>): RangeSearch {
  const from = typeof search.from === 'string' && isIsoDate(search.from) ? search.from : undefined;
  const to = typeof search.to === 'string' && isIsoDate(search.to) ? search.to : undefined;
  return from !== undefined && to !== undefined && from <= to ? { from, to } : {};
}

/** The period asked for, or this month to date. */
export function rangeOf(search: RangeSearch): DateRange {
  if (search.from !== undefined && search.to !== undefined) {
    return { from: search.from as IsoDate, to: search.to as IsoDate };
  }
  return presetRange('month', todayInDhaka());
}

export function presetOf(range: DateRange): RangePreset | null {
  const today = todayInDhaka();
  for (const preset of ['today', 'week', 'month'] as const) {
    const candidate = presetRange(preset, today);
    if (candidate.from === range.from && candidate.to === range.to) return preset;
  }
  return null;
}
