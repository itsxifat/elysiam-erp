/** What the screen's URL may carry, and nothing else (frontend rules: filters live in the URL). */
export type ReportView = 'pnl' | 'balance' | 'aging';

export interface ReportsSearch {
  readonly view?: ReportView;
  readonly from?: string;
  readonly to?: string;
  readonly asOf?: string;
  readonly side?: 'payable' | 'receivable';
  readonly branch?: string;
}

export function reportsSearch(search: Record<string, unknown>): ReportsSearch {
  const out: {
    view?: ReportView;
    from?: string;
    to?: string;
    asOf?: string;
    side?: 'payable' | 'receivable';
    branch?: string;
  } = {};
  if (search.view === 'pnl' || search.view === 'balance' || search.view === 'aging') {
    out.view = search.view;
  }
  if (typeof search.from === 'string') out.from = search.from;
  if (typeof search.to === 'string') out.to = search.to;
  if (typeof search.asOf === 'string') out.asOf = search.asOf;
  if (search.side === 'payable' || search.side === 'receivable') out.side = search.side;
  if (typeof search.branch === 'string' && /^[0-9a-f-]{36}$/i.test(search.branch)) {
    out.branch = search.branch;
  }
  return out;
}
