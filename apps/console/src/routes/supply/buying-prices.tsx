import { Button, PermissionGate, Section } from '@elysium/ui';
import { useMutation } from '@tanstack/react-query';
import { Download, FileUp } from 'lucide-react';
import { useRef, useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/catalog-pricing.js';
import {
  dryRunStandardCosts,
  exportStandardCosts,
  importStandardCosts,
  type StandardCostReport,
} from '../catalog/pricing-api.js';
import { csvDataUrl } from '../catalog/variant-grid.js';
import { useSupplyT } from './messages.js';
import { SupplyHeader, TableFrame, TD, TH, TR } from './supply-nav.js';

/**
 * Supply → Buying prices (M39b, D-638): every variant's standard buying price as a
 * spreadsheet, downloaded, filled in and uploaded back, checked first and then imported all
 * or nothing.
 *
 * Purchase cost, so only for a role that may read cost (invariant 5): the routes are `read
 * Cost`, and this screen shows a refusal rather than an empty form to anyone else. The catalog's
 * own spreadsheet never carries cost; this one is the supply module's.
 */
export function SupplyBuyingPricesPage() {
  const ability = useAbility();
  const t = useT();
  const st = useSupplyT();
  const mayCost = ability.can('read', 'Cost');
  const input = useRef<HTMLInputElement>(null);
  const [csv, setCsv] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<StandardCostReport | null>(null);
  const [imported, setImported] = useState<number | null>(null);

  const download = useMutation({
    mutationFn: () => exportStandardCosts(),
    onSuccess: (file) => {
      const link = document.createElement('a');
      link.href = csvDataUrl(file.csv);
      link.download = file.filename;
      link.click();
    },
  });
  const check = useMutation({
    mutationFn: (text: string) => dryRunStandardCosts(text),
    onSuccess: setReport,
  });
  const commit = useMutation({
    mutationFn: (text: string) => importStandardCosts(text),
    onSuccess: (result) => {
      setImported(result.set);
      setReport(null);
      setCsv(null);
      setFileName('');
    },
  });
  const error = download.error ?? check.error ?? commit.error;

  return (
    <PermissionGate
      allowed={mayCost}
      explain={{ title: st('supply.deniedTitle'), detail: st('supply.deniedDetail') }}
    >
      <div className="space-y-6">
        <SupplyHeader title={t('cp.costs.title')} description={t('cp.costs.help')} />

        <Section title={t('cp.costs.export')}>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">{t('cp.costs.exportHelp')}</p>
            <Button
              variant="outline"
              data-testid="export-costs"
              disabled={download.isPending}
              onClick={() => download.mutate()}
            >
              <Download aria-hidden="true" />
              {t('cp.costs.export')}
            </Button>
          </div>
        </Section>

        <Section title={t('cp.costs.import')}>
          <div className="space-y-3">
            <input
              ref={input}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file === undefined) return;
                setImported(null);
                setReport(null);
                setFileName(file.name);
                void file.text().then(setCsv);
              }}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={() => input.current?.click()}>
                <FileUp aria-hidden="true" />
                {t('cp.costs.chooseFile')}
              </Button>
              {fileName === '' ? null : (
                <span className="text-sm text-muted-foreground">{fileName}</span>
              )}
              <Button
                disabled={csv === null || check.isPending}
                onClick={() => {
                  if (csv !== null) check.mutate(csv);
                }}
              >
                {t('cp.costs.check')}
              </Button>
              <Button
                disabled={csv === null || report?.canCommit !== true || commit.isPending}
                onClick={() => {
                  if (csv !== null) commit.mutate(csv);
                }}
              >
                {t('cp.costs.commit')}
              </Button>
            </div>
            {report === null ? null : (
              <div role="status" className="space-y-2 text-sm">
                <p>
                  {`${String(report.willSet)} ${t('cp.costs.willSet')} · ${String(report.skipped)} ${t('cp.costs.skipped')}`}
                </p>
                {report.problems.length > 0 ? (
                  <TableFrame label={t('cp.costs.problems')}>
                    <table className="w-full border-separate border-spacing-0 text-sm">
                      <caption className="sr-only">{t('cp.costs.problems')}</caption>
                      <thead>
                        <tr>
                          <th scope="col" className={TH}>
                            {t('cp.costs.line')}
                          </th>
                          <th scope="col" className={TH}>
                            {t('cp.costs.problems')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {report.problems.map((problem, index) => (
                          <tr key={`${String(problem.line)}-${String(index)}`} className={TR}>
                            <td className={`${TD} tabular-nums`}>{problem.line}</td>
                            <td className={TD}>{problem.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableFrame>
                ) : null}
              </div>
            )}
            {imported === null ? null : (
              <p role="status" className="text-sm text-muted-foreground">
                {`${t('cp.costs.imported')} ${String(imported)} ${t('cp.costs.willSet')}`}
              </p>
            )}
            {error === null ? null : (
              <p role="alert" className="text-sm text-destructive">
                {error instanceof ApiError ? error.message : t('cp.saveFailed')}
              </p>
            )}
          </div>
        </Section>
      </div>
    </PermissionGate>
  );
}
