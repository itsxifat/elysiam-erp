import { describe, expect, it } from 'vitest';

import { segmentReport, type LeadFact } from './index.js';

const SAREE = { id: 'p-saree', name: 'Jamdani saree' };
const KURTI = { id: 'p-kurti', name: 'Cotton kurti' };

const LEADS: LeadFact[] = [
  { product: SAREE, size: 'M', ageBand: '25_34', profession: 'Teacher', status: 'converted' },
  { product: SAREE, size: ' m ', ageBand: '25_34', profession: 'teacher ', status: 'new' },
  { product: SAREE, size: 'L', ageBand: '35_44', profession: 'Doctor', status: 'converted' },
  { product: KURTI, size: 'M', ageBand: '18_24', profession: 'Student', status: 'lost' },
  { product: null, size: null, ageBand: null, profession: null, status: 'contacted' },
];

describe('lead segment reports by product, size, age band and profession', () => {
  it('by product: counts, conversions and the rate, largest first, not stated last', () => {
    expect(segmentReport(LEADS, 'product')).toEqual([
      { key: 'p-saree', label: 'Jamdani saree', leads: 3, converted: 2, conversionBps: 6_667n },
      { key: 'p-kurti', label: 'Cotton kurti', leads: 1, converted: 0, conversionBps: 0n },
      { key: null, label: null, leads: 1, converted: 0, conversionBps: 0n },
    ]);
  });

  it('by size: one size however it was typed', () => {
    const rows = segmentReport(LEADS, 'size');
    expect(rows.map((row) => [row.key, row.leads])).toEqual([
      ['M', 3],
      ['L', 1],
      [null, 1],
    ]);
  });

  it('by age band: youngest first', () => {
    expect(segmentReport(LEADS, 'age_band').map((row) => row.key)).toEqual([
      '18_24',
      '25_34',
      '35_44',
      null,
    ]);
  });

  it('by profession: case and spaces do not split a profession', () => {
    const rows = segmentReport(LEADS, 'profession');
    expect(rows[0]).toEqual({
      key: 'teacher',
      label: 'Teacher',
      leads: 2,
      converted: 1,
      conversionBps: 5_000n,
    });
  });
});
