/** What the ledger screen's URL may carry, and nothing else. */
export type LedgerView = 'trial' | 'daybook' | 'account';

export interface LedgerSearch {
  readonly view?: LedgerView;
  readonly asOf?: string;
  readonly from?: string;
  readonly to?: string;
  readonly account?: string;
}

export function ledgerSearch(search: Record<string, unknown>): LedgerSearch {
  const out: { view?: LedgerView; asOf?: string; from?: string; to?: string; account?: string } =
    {};
  if (search.view === 'trial' || search.view === 'daybook' || search.view === 'account') {
    out.view = search.view;
  }
  if (typeof search.asOf === 'string') out.asOf = search.asOf;
  if (typeof search.from === 'string') out.from = search.from;
  if (typeof search.to === 'string') out.to = search.to;
  if (typeof search.account === 'string' && /^[0-9a-f-]{36}$/i.test(search.account)) {
    out.account = search.account;
  }
  return out;
}
