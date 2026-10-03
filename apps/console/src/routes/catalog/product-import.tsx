import { Button, Money, PermissionGate, StatusBadge } from '@elysium/ui';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import { commitProductImport, dryRunProductImport, type ProductImportReport } from './api.js';
import { PRODUCT_TEMPLATE, csvDataUrl } from './variant-grid.js';

/**
 * New products from a spreadsheet (D-425): download the template, fill in one row per
 * product, check it, read every problem with its line and column, then import. The
 * Import button exists only after a check said the whole file can go in, and the server
 * checks again and creates every product or none.
 */
export function ProductImport() {
  const ability = useAbility();
  const t = useT();
  const mayRead = ability.can('read', 'Catalog');
  const mayCreate = ability.can('create', 'Catalog');

  const [csv, setCsv] = useState<string | null>(null);
  const [report, setReport] = useState<ProductImportReport | null>(null);
  const [created, setCreated] = useState<{
    created: number;
    skuCount: number;
    products: { id: string; name: string }[];
  } | null>(null);

  const check = useMutation({
    mutationFn: () => dryRunProductImport(csv ?? ''),
    onSuccess: (result) => {
      setReport(result);
      setCreated(null);
    },
  });
  const commit = useMutation({
    mutationFn: () => commitProductImport(csv ?? ''),
    onSuccess: (result) => {
      setCreated(result);
      setReport(null);
    },
  });

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: t('catalog.deniedTitle'), detail: t('catalog.deniedDetail') }}
    >
      <div className="space-y-5">
        <section aria-labelledby="product-import-heading" className="space-y-2">
          <h2 id="product-import-heading" className="text-base font-semibold tracking-tight">
            {t('cs.import.products')}
          </h2>
          <ol className="max-w-2xl list-decimal space-y-1 ps-5 text-sm text-muted-foreground">
            <li>{t('cs.import.step1')}</li>
            <li>{t('cs.import.step2')}</li>
            <li>{t('cs.import.step3')}</li>
          </ol>
          <a
            href={csvDataUrl(PRODUCT_TEMPLATE)}
            download="products-template.csv"
            className="inline-flex items-center gap-1.5 rounded-sm text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Download aria-hidden className="size-4" />
            {t('cs.import.template')}
          </a>
        </section>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            {t('catalog.importFile')}
            <input
              type="file"
              accept=".csv,text/csv"
              className="text-sm text-muted-foreground file:me-3 file:h-control-sm file:cursor-pointer file:rounded-md file:border file:border-input file:bg-background file:px-3 file:text-sm file:font-medium file:text-foreground hover:file:bg-accent"
              onChange={(event) => {
                const file = event.target.files?.[0];
                setReport(null);
                setCreated(null);
                if (file === undefined) {
                  setCsv(null);
                  return;
                }
                void file.text().then(setCsv);
              }}
            />
          </label>
          <Button disabled={csv === null || check.isPending} onClick={() => check.mutate()}>
            {t('cs.import.check')}
          </Button>
          {report?.canCommit === true && mayCreate ? (
            <Button disabled={commit.isPending} onClick={() => commit.mutate()}>
              {t('cs.import.commit')}
            </Button>
          ) : null}
        </div>

        {[check.error, commit.error].map((error, index) =>
          error === null ? null : (
            <p key={index} role="alert" className="text-sm text-destructive">
              {error instanceof ApiError ? error.message : t('cs.saveFailed')}
            </p>
          ),
        )}

        {created !== null ? (
          <div
            role="status"
            className="space-y-2 rounded-lg border border-border bg-card p-4 text-sm"
          >
            <p className="font-medium">
              {`${String(created.created)} ${t('cs.import.created')} · ${String(created.skuCount)} ${t('cs.import.skus')}`}
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {created.products.slice(0, 30).map((product) => (
                <li key={product.id}>
                  <Link
                    to="/catalog/$productId"
                    params={{ productId: product.id }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {product.name}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {report !== null ? (
          <div className="space-y-4">
            <p className="text-sm" role="status">
              {report.canCommit
                ? `${t('cs.import.ready')} ${String(report.willCreate)} ${t('cs.import.productsWord')}, ${String(report.skuCount)} ${t('cs.import.skus')}.`
                : (report.reason ?? '')}
            </p>

            {report.problems.length > 0 ? (
              <section aria-labelledby="import-problems-heading" className="space-y-2">
                <h3 id="import-problems-heading" className="text-sm font-semibold text-destructive">
                  {t('catalog.importProblems')}
                </h3>
                <div className="overflow-x-auto rounded-lg border border-border bg-card">
                  <table className="w-full text-sm">
                    <caption className="sr-only">{t('catalog.importProblems')}</caption>
                    <thead>
                      <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                        <th scope="col" className="h-10 w-16 px-3 font-medium whitespace-nowrap">
                          {t('catalog.importLine')}
                        </th>
                        <th scope="col" className="h-10 w-32 px-3 font-medium whitespace-nowrap">
                          {t('catalog.importColumn')}
                        </th>
                        <th scope="col" className="h-10 px-3 font-medium whitespace-nowrap">
                          {t('catalog.importMessage')}
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
            ) : null}

            {report.preview.length > 0 ? (
              <div className="overflow-x-auto rounded-lg border border-border bg-card">
                <table className="w-full text-sm">
                  <caption className="sr-only">{t('cs.import.preview')}</caption>
                  <thead>
                    <tr className="border-b border-border bg-muted/50 text-left text-xs text-muted-foreground">
                      <th scope="col" className="h-10 w-16 px-3 font-medium whitespace-nowrap">
                        {t('catalog.importLine')}
                      </th>
                      <th scope="col" className="h-10 px-3 font-medium whitespace-nowrap">
                        {t('catalog.colProduct')}
                      </th>
                      <th scope="col" className="h-10 px-3 font-medium whitespace-nowrap">
                        {t('catalog.colCategory')}
                      </th>
                      <th scope="col" className="h-10 px-3 font-medium whitespace-nowrap">
                        {t('cs.import.sizes')}
                      </th>
                      <th scope="col" className="h-10 px-3 font-medium whitespace-nowrap">
                        {t('cs.import.colours')}
                      </th>
                      <th
                        scope="col"
                        className="h-10 px-3 text-right font-medium whitespace-nowrap"
                      >
                        {t('catalog.colSkus')}
                      </th>
                      <th
                        scope="col"
                        className="h-10 px-3 text-right font-medium whitespace-nowrap"
                      >
                        {t('cs.col.price')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.preview.map((row) => (
                      <tr key={row.line} className="border-b border-border last:border-b-0">
                        <td className="px-3 py-2 tabular-nums">{row.line}</td>
                        <td className="px-3 py-2">
                          <span className="font-medium">{row.name}</span>
                          {row.status === 'draft' ? (
                            <span className="ms-2">
                              <StatusBadge tone="info">{t('catalog.status.draft')}</StatusBadge>
                            </span>
                          ) : null}
                        </td>
                        <td className="px-3 py-2">{row.categoryName ?? '—'}</td>
                        <td className="px-3 py-2">{row.sizes.join(', ') || '—'}</td>
                        <td className="px-3 py-2">{row.colours.join(', ') || '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{row.variantCount}</td>
                        <td className="px-3 py-2 text-right">
                          <Money poisha={row.pricePoisha} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </PermissionGate>
  );
}
