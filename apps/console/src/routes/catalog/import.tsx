import {
  Button,
  ErrorState,
  Money,
  PageHeader,
  PermissionGate,
  cn,
  tabClassName,
} from '@elysium/ui';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';

import { useAbility } from '../../auth/session.js';
import { commitPriceImport, dryRunPriceImport, type ImportReport } from './api.js';
import { useCatalogT } from './messages.js';
import { ProductImport } from './product-import.js';
import { useT } from '../../i18n/locale.js';
import { Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { DEFAULT_PAGE_SIZE } from '../../lib/table-search.js';

/**
 * Import: new products from a spreadsheet (D-425), or new prices for existing SKUs
 * (M06 check 4). Two tabs on one page, because both start the same way — download the
 * template, fill it in, check it — and an owner looking for "import" should find both.
 */
export function CatalogImportPage() {
  const t = useT();
  const [tab, setTab] = useState<'products' | 'prices'>('products');
  // The kit's underline tabs, selected by `aria-selected` (these are in-page tabs, not links).
  const tabClass = cn(
    tabClassName,
    'aria-selected:border-foreground aria-selected:font-medium aria-selected:text-foreground',
  );
  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <nav aria-label={t('cs.breadcrumb')} className="text-sm text-muted-foreground">
          <Link
            to="/catalog"
            search={{ page: 1, pageSize: DEFAULT_PAGE_SIZE }}
            className="inline-flex items-center gap-1.5 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <ArrowLeft aria-hidden className="size-4" />
            {t('catalog.title')}
          </Link>
        </nav>
        <PageHeader title={t('cs.import.title')} />
      </div>
      <div
        role="tablist"
        aria-label={t('cs.import.title')}
        className="flex gap-5 border-b border-border"
      >
        <button
          type="button"
          role="tab"
          id="tab-products"
          aria-selected={tab === 'products'}
          aria-controls="panel-import"
          className={tabClass}
          onClick={() => setTab('products')}
        >
          {t('cs.import.products')}
        </button>
        <button
          type="button"
          role="tab"
          id="tab-prices"
          aria-selected={tab === 'prices'}
          aria-controls="panel-import"
          className={tabClass}
          onClick={() => setTab('prices')}
        >
          {t('cs.import.prices')}
        </button>
      </div>
      <div
        role="tabpanel"
        id="panel-import"
        aria-labelledby={tab === 'products' ? 'tab-products' : 'tab-prices'}
      >
        {tab === 'products' ? <ProductImport /> : <PriceImport />}
      </div>
    </div>
  );
}

/**
 * The price importer's two steps (M06 acceptance check 4).
 *
 * The screen's shape is the check: **check the file**, read the report, then
 * **apply the file** — and the second button does not exist until the first has
 * answered `canCommit`. That is not politeness, it is what stops the failure the
 * check is about: a partial import of a price file leaves some SKUs repriced and
 * nobody able to say which, and the only way back is the prices from before, which
 * the import destroyed.
 *
 * Every problem is listed with its line and column, so the report can be read
 * beside the spreadsheet. Showing only the first would turn a 500-row file into
 * one error per round trip, which is how people stop using an importer and start
 * editing the database.
 *
 * The file is read in the browser as text and posted as a string rather than
 * uploaded through §22's presigned PUT: a price file is a few kilobytes and the
 * operator is standing there waiting for the report, so a presign, an upload and a
 * poll would be three round trips for something that fits in one.
 */
function PriceImport() {
  const ability = useAbility();
  const ct = useCatalogT();

  const mayRead = ability.can('read', 'Catalog');
  const mayWrite = ability.can('update', 'Catalog');

  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<ImportReport | null>(null);
  const [applied, setApplied] = useState<number | null>(null);

  const check = useMutation({
    mutationFn: () => dryRunPriceImport(csv ?? ''),
    onSuccess: (result) => {
      setReport(result);
      setApplied(null);
    },
  });

  const apply = useMutation({
    mutationFn: () => commitPriceImport(csv ?? '', fileName),
    onSuccess: (result) => {
      setApplied(result.applied);
      // The report is cleared so the Apply button cannot be pressed twice against a
      // file that has already been applied — the second press would be a no-op,
      // but an operator reading "3 prices applied" twice cannot tell that.
      setReport(null);
    },
  });

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: ct('catalog.deniedTitle'), detail: ct('catalog.deniedDetail') }}
    >
      <div className="space-y-5">
        <header>
          <h2 className="text-base font-semibold tracking-tight">{ct('catalog.import')}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{ct('catalog.importHelp')}</p>
        </header>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {ct('catalog.importFile')}
            <input
              type="file"
              accept=".csv,text/csv"
              className="text-sm text-muted-foreground file:me-3 file:h-control-sm file:cursor-pointer file:rounded-md file:border file:border-input file:bg-background file:px-3 file:text-sm file:font-medium file:text-foreground hover:file:bg-accent"
              onChange={(event) => {
                const file = event.target.files?.[0];
                setReport(null);
                setApplied(null);
                if (file === undefined) {
                  setCsv(null);
                  return;
                }
                setFileName(file.name);
                void file.text().then(setCsv);
              }}
            />
          </label>
          <Button
            size="sm"
            disabled={csv === null || check.isPending}
            onClick={() => check.mutate()}
          >
            {ct('catalog.importDryRun')}
          </Button>
          {/* Only after a dry run said it can be applied. */}
          {report?.canCommit === true && mayWrite && (
            <Button size="sm" disabled={apply.isPending} onClick={() => apply.mutate()}>
              {ct('catalog.importCommit')}
            </Button>
          )}
        </div>

        {check.error !== null && (
          <ErrorState title={ct('catalog.errorTitle')} detail={ct('catalog.errorDetail')} />
        )}

        {applied !== null && (
          <p className="text-sm font-medium text-success-subtle-foreground">
            {String(applied)} {ct('catalog.importApplied')}
          </p>
        )}

        {report !== null && (
          <div className="space-y-4">
            <dl className="flex flex-wrap gap-8 rounded-lg border border-border bg-card px-5 py-4 text-sm">
              <div>
                <dt className="text-xs text-muted-foreground">{ct('catalog.importRows')}</dt>
                <dd className="mt-0.5 text-xl font-medium tabular-nums">{report.totalRows}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{ct('catalog.importWillChange')}</dt>
                <dd className="mt-0.5 text-xl font-medium tabular-nums">{report.willChange}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{ct('catalog.importUnchanged')}</dt>
                <dd className="mt-0.5 text-xl font-medium tabular-nums">{report.unchanged}</dd>
              </div>
            </dl>

            {report.problems.length > 0 && (
              <section aria-labelledby="problems-heading" className="space-y-2">
                <h3 id="problems-heading" className="text-sm font-semibold text-destructive">
                  {ct('catalog.importProblems')}
                </h3>
                <p className="text-sm text-muted-foreground">{ct('catalog.importBlocked')}</p>
                <div className="overflow-x-auto rounded-lg border border-border bg-card">
                  <table className="w-full text-sm">
                    <caption className="sr-only">{ct('catalog.importProblems')}</caption>
                    <thead>
                      <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                        <th scope="col" className="h-10 w-16 px-3 font-medium whitespace-nowrap">
                          {ct('catalog.importLine')}
                        </th>
                        <th scope="col" className="h-10 w-32 px-3 font-medium whitespace-nowrap">
                          {ct('catalog.importColumn')}
                        </th>
                        <th scope="col" className="h-10 px-3 font-medium whitespace-nowrap">
                          {ct('catalog.importMessage')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {report.problems.map((problem, index) => (
                        <tr
                          key={`${String(problem.line)}-${problem.column ?? ''}-${String(index)}`}
                          className="border-b border-border last:border-b-0"
                        >
                          <td className="px-3 py-2 tabular-nums">{problem.line}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                            {problem.column ?? '—'}
                          </td>
                          <td className="px-3 py-2">{problem.message}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {report.preview.length > 0 && (
              <div className="overflow-x-auto rounded-lg border border-border bg-card">
                <table className="w-full text-sm">
                  <caption className="sr-only">{ct('catalog.importDryRun')}</caption>
                  <thead>
                    <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                      <th scope="col" className="h-10 px-3 font-medium whitespace-nowrap">
                        {ct('catalog.colCode')}
                      </th>
                      <th
                        scope="col"
                        className="h-10 px-3 text-right font-medium whitespace-nowrap"
                      >
                        {ct('catalog.priceFrom')}
                      </th>
                      <th
                        scope="col"
                        className="h-10 px-3 text-right font-medium whitespace-nowrap"
                      >
                        {ct('catalog.priceTo')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.preview.map((row) => (
                      <tr key={row.sku} className="border-b border-border last:border-b-0">
                        <td className="px-3 py-2 text-xs text-muted-foreground tabular-nums">
                          {row.sku}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {row.fromPricePoisha === null ? (
                            '—'
                          ) : (
                            <Money poisha={row.fromPricePoisha} />
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Money poisha={row.toPricePoisha} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </PermissionGate>
  );
}
