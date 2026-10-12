import { canonicalSize, type MeasurementPart } from './hints.js';
import { asciiDigitsIn } from './phones.js';

/**
 * A measurement turned into a size through the product's size chart (M44b, D-771).
 *
 * A size chart is the website's (M33, D-502): a heading per column and a grid of short strings,
 * as the brand typed them ("Size | Chest | Length", "L | 42 | 29", "XL | 44-46 | 30"). The rule:
 *
 * 1. Columns are read by their headings: one names the size ("Size", "সাইজ", else the first
 *    column), the others a body part (chest/bust/বুক, waist/কোমর, hip, length/long/ঝুল/লম্বা,
 *    shoulder/কাঁধ, sleeve/হাতা, height/উচ্চতা, weight/ওজন). A heading's unit ("(cm)", "inch",
 *    "kg") is the column's; with none, a length column whose values pass 80 is in centimetres,
 *    else inches, and a weight column is kilograms.
 * 2. A cell is one value ("42") or a range ("40-42", "40 to 42", `5'4"-5'6"`), Bangla digits
 *    allowed; a cell that is neither is skipped.
 * 3. For each measurement the chart has a column for, the size is the smallest whose value (the
 *    range's top) is at least the measurement, in the column's unit: the garment has to be at
 *    least as big as the body. No ease is added; the chart is read as written. Under the
 *    smallest, the smallest; over the largest, no size ("larger than the chart").
 * 4. Several measurements: the largest of their sizes, in the chart's own row order, because a
 *    garment that fits the biggest measurement fits the others. One over the chart means none.
 *
 * An agent always sees which measurement decided and may pick another size. Pure; never throws.
 */

export interface SizeChartTable {
  readonly columns: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export type ChartUnit = 'in' | 'cm' | 'kg';

export interface ChartColumn {
  readonly index: number;
  readonly part: MeasurementPart;
  readonly unit: ChartUnit;
}

export interface ChartLayout {
  readonly sizeIndex: number;
  readonly parts: readonly ChartColumn[];
}

/** A measurement as the recommender takes it: a length in inches, or a weight in kg. */
export interface BodyMeasurement {
  readonly part: MeasurementPart;
  readonly inches: number | null;
  readonly kg: number | null;
}

export type FitReason = 'fits' | 'between' | 'below_chart' | 'above_chart' | 'no_column';

export interface PartFit {
  readonly part: MeasurementPart;
  /** The chart's size label as written, or null. */
  readonly size: string | null;
  readonly reason: FitReason;
}

export interface SizeRecommendation {
  /** The chart's size label as written ("XL"), or null when none can be said. */
  readonly size: string | null;
  /** The same, canonical ("XL", "XXL" for "2XL"), to match against a product's sizes. */
  readonly canonical: string | null;
  /** The measurement that decided it. */
  readonly decidedBy: MeasurementPart | null;
  readonly fits: readonly PartFit[];
}

const CM_PER_INCH = 2.54;

const HEADINGS: readonly (readonly [MeasurementPart, RegExp])[] = [
  ['chest', /chest|bust|বুক|ছাতি/i],
  ['waist', /waist|কোমর/i],
  ['hip', /hip|হিপ/i],
  ['shoulder', /shoulder|কাঁধ|কাধ/i],
  ['sleeve', /sleeve|হাতা/i],
  ['height', /height|উচ্চতা|হাইট/i],
  ['weight', /weight|ওজন/i],
  ['length', /length|long|ঝুল|লম্বা|দৈর্ঘ্য/i],
];
const SIZE_HEADING = /size|সাইজ/i;

function headingUnit(heading: string): ChartUnit | null {
  if (/\bcm\b|centimet|সেমি/i.test(heading)) return 'cm';
  if (/\bkg\b|kilo|কেজি/i.test(heading)) return 'kg';
  if (/\binch|\bin\b|"|”|ইঞ্চি/i.test(heading)) return 'in';
  return null;
}

/**
 * A cell's value in the column's unit, as a range; a height written in feet and inches comes
 * back in inches. Null for a cell that is not a measurement.
 */
export function parseChartCell(
  cell: string,
  part: MeasurementPart,
): { readonly low: number; readonly high: number; readonly feet: boolean } | null {
  if (typeof cell !== 'string') return null;
  const text = asciiDigitsIn(cell).trim();
  if (text === '' || text.length > 40) return null;

  if (part === 'height' && /\d\s*(?:'|’|ft|feet|ফুট)/i.test(text)) {
    const heights = [
      ...text.matchAll(/(\d)\s*(?:'|’|ft|feet|ফুট)\s*(?:(\d{1,2})\s*(?:"|”|''|in|inch)?)?/gi),
    ].map((match) => Number(match[1]) * 12 + (match[2] === undefined ? 0 : Number(match[2])));
    const [first, second] = heights;
    if (first === undefined || heights.length > 2) return null;
    const low = Math.min(first, second ?? first);
    const high = Math.max(first, second ?? first);
    return { low, high, feet: true };
  }

  const numbers = [...text.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const [first, second] = numbers;
  if (first === undefined || numbers.length > 2 || !Number.isFinite(first)) return null;
  if (second !== undefined && !/\d\s*(?:-|–|—|~|to|থেকে)\s*\d/i.test(text)) return null;
  const low = Math.min(first, second ?? first);
  const high = Math.max(first, second ?? first);
  return low > 0 ? { low, high, feet: false } : null;
}

/** Which column is the size and which measure what, in which unit. */
export function chartLayout(chart: SizeChartTable): ChartLayout {
  const columns = chart.columns;
  const sizeAt = columns.findIndex((heading) => SIZE_HEADING.test(heading));
  const sizeIndex = sizeAt >= 0 ? sizeAt : 0;
  const parts: ChartColumn[] = [];
  const seen = new Set<MeasurementPart>();
  columns.forEach((heading, index) => {
    if (index === sizeIndex) return;
    const found = HEADINGS.find(([, pattern]) => pattern.test(heading));
    if (found === undefined) return;
    const [part] = found;
    if (seen.has(part)) return;
    seen.add(part);
    const stated = headingUnit(heading);
    let unit: ChartUnit;
    if (part === 'weight') unit = 'kg';
    else if (stated === 'cm' || stated === 'in') unit = stated;
    else {
      const values = chart.rows
        .map((row) => parseChartCell(row[index] ?? '', part))
        .filter((value): value is NonNullable<typeof value> => value !== null);
      const feet = values.some((value) => value.feet);
      unit =
        !feet && values.some((value) => value.high > (part === 'height' ? 100 : 80)) ? 'cm' : 'in';
    }
    parts.push({ index, part, unit });
  });
  return { sizeIndex, parts };
}

function inUnit(measurement: BodyMeasurement, unit: ChartUnit): number | null {
  if (unit === 'kg') return measurement.kg;
  if (measurement.inches === null) return null;
  return unit === 'cm' ? measurement.inches * CM_PER_INCH : measurement.inches;
}

/** The size the chart gives for these measurements (the rule is the module's note). */
export function recommendSize(
  chart: SizeChartTable,
  measurements: readonly BodyMeasurement[],
): SizeRecommendation {
  const none: SizeRecommendation = { size: null, canonical: null, decidedBy: null, fits: [] };
  if (chart.columns.length === 0 || chart.rows.length === 0) return none;
  const layout = chartLayout(chart);
  const fits: PartFit[] = [];
  let best: { row: number; part: MeasurementPart } | null = null;
  let over = false;

  for (const measurement of measurements) {
    const column = layout.parts.find((entry) => entry.part === measurement.part);
    const value = column === undefined ? null : inUnit(measurement, column.unit);
    if (column === undefined || value === null) {
      fits.push({ part: measurement.part, size: null, reason: 'no_column' });
      continue;
    }
    const rows = chart.rows
      .map((row, index) => {
        const label = (row[layout.sizeIndex] ?? '').trim();
        const cell = parseChartCell(row[column.index] ?? '', column.part);
        return cell === null || label === '' ? null : { index, label, ...cell };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null)
      .sort((a, b) => a.high - b.high || a.low - b.low || a.index - b.index);
    const first = rows[0];
    if (first === undefined) {
      fits.push({ part: measurement.part, size: null, reason: 'no_column' });
      continue;
    }
    const epsilon = 1e-6;
    const chosen = rows.find((row) => value <= row.high + epsilon);
    if (chosen === undefined) {
      over = true;
      fits.push({ part: measurement.part, size: null, reason: 'above_chart' });
      continue;
    }
    const reason: FitReason =
      chosen === first && value < first.low - epsilon
        ? 'below_chart'
        : value >= chosen.low - epsilon
          ? 'fits'
          : 'between';
    fits.push({ part: measurement.part, size: chosen.label, reason });
    if (best === null || chosen.index > best.row)
      best = { row: chosen.index, part: measurement.part };
  }

  if (over || best === null) return { ...none, fits };
  const label = (chart.rows[best.row]?.[layout.sizeIndex] ?? '').trim();
  return {
    size: label,
    canonical: canonicalSize(label) ?? label.toUpperCase(),
    decidedBy: best.part,
    fits,
  };
}
