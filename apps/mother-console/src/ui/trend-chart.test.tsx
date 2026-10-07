import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { TrendChart } from './trend-chart.js';

/**
 * The chart's reading rules (D-496): a legend that names each brand, one tooltip listing
 * every brand at the day in focus (keyboard as well as pointer), and a table view.
 */
describe('TrendChart', () => {
  afterEach(cleanup);

  const props = {
    dates: ['2026-10-01', '2026-10-02', '2026-10-03'],
    series: [
      { key: 'a', label: 'Brand A', slot: 0, values: [10, 20, 30] },
      { key: 'b', label: 'Brand B', slot: 1, values: [5, 15, 25] },
    ],
    tick: (value: number) => String(value),
    display: (series: number, day: number) => `${['A', 'B'][series] ?? ''}${String(day)}`,
    locale: 'en' as const,
    title: 'Revenue by brand',
    showTableLabel: 'Show as table',
    showChartLabel: 'Show as chart',
    dateHeading: 'Date',
  };

  it('names every brand in the legend', () => {
    render(<TrendChart {...props} />);
    expect(screen.getAllByText('Brand A').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Brand B').length).toBeGreaterThan(0);
  });

  it('reads every brand at the focused day, and moves with the arrow keys', () => {
    render(<TrendChart {...props} />);
    const chart = screen.getByRole('img', { name: 'Revenue by brand' });
    fireEvent.focus(chart);
    const tooltip = screen.getByRole('status');
    expect(tooltip.textContent).toContain('A2');
    expect(tooltip.textContent).toContain('B2');
    fireEvent.keyDown(chart, { key: 'ArrowLeft' });
    expect(screen.getByRole('status').textContent).toContain('A1');
  });

  it('shows the same values as a table', () => {
    render(<TrendChart {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show as table' }));
    expect(screen.getByRole('table', { name: 'Revenue by brand' })).toBeTruthy();
    expect(screen.getByText('B0')).toBeTruthy();
  });
});
