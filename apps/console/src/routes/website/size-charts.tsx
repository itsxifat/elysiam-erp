import { Button } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Minus, Pencil, Plus, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';

import { useAbility } from '../../auth/session.js';
import {
  createSizeChart,
  deleteSizeChart,
  listSizeCharts,
  updateSizeChart,
  type SizeChart,
} from './api.js';
import { useWebsiteT } from './messages.js';
import { control, Empty, Field, Loadable, NamedSection, Problem, WebsitePage } from './parts.js';
import '../../i18n/website.js';
import { Link } from '@tanstack/react-router';
import { emptyAndDeleteSizeChart, sizeChartUsage } from '../../api/manage.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/manage.js';
import { DeleteOrArchive } from '../../ui/delete-or-archive.js';

/**
 * Website → Size charts (M33, D-502): a grid editor for the charts a product page shows
 * beside its sizes. Headings across the top, one row per size; a chart products still use
 * cannot be deleted (the server says how many use it).
 */
export function WebsiteSizeChartsPage() {
  const t = useWebsiteT();
  const tm = useT();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ['website', 'size-charts'], queryFn: listSizeCharts });
  const [editing, setEditing] = useState<SizeChart | 'new' | null>(null);
  const [deleting, setDeleting] = useState<SizeChart | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const mayCreate = ability.can('create', 'Storefront');
  const mayUpdate = ability.can('update', 'Storefront');
  const mayDelete = ability.can('delete', 'Storefront');

  return (
    <WebsitePage tab="/website/size-charts" wide>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('web.charts.caption')}</p>
        {mayCreate && editing === null ? (
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {t('web.charts.add')}
          </Button>
        ) : null}
      </div>
      {editing === null ? null : (
        <ChartEditor
          key={editing === 'new' ? 'new' : editing.id}
          chart={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
      <Problem error={problem} />
      <Loadable query={query}>
        {(data) =>
          data.items.length === 0 ? (
            <Empty />
          ) : (
            <ul className="grid gap-4 lg:grid-cols-2">
              {data.items.map((chart) => (
                <li key={chart.id}>
                  <NamedSection
                    title={chart.name}
                    actions={
                      <span className="inline-flex gap-1">
                        {mayUpdate ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`${t('web.edit')}: ${chart.name}`}
                            onClick={() => setEditing(chart)}
                          >
                            <Pencil aria-hidden />
                          </Button>
                        ) : null}
                        {mayDelete ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            aria-label={`${t('web.delete')}: ${chart.name}`}
                            onClick={() => setDeleting(chart)}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        ) : null}
                      </span>
                    }
                  >
                    <ChartTable chart={chart} />
                  </NamedSection>
                </li>
              ))}
            </ul>
          )
        }
      </Loadable>
      {deleting === null ? null : (
        <DeleteOrArchive
          key={deleting.id}
          open
          onClose={() => setDeleting(null)}
          queryKey={['website', 'size-charts', deleting.id]}
          loadUsage={() => sizeChartUsage(deleting.id)}
          onDelete={() => deleteSizeChart(deleting.id)}
          emptyAndDelete={{
            help: tm('mg.empty.chartHelp'),
            noneLabel: tm('mg.empty.noChart'),
            targets: (query.data?.items ?? [])
              .filter((chart) => chart.id !== deleting.id)
              .map((chart) => ({ value: chart.id, label: chart.name })),
            run: (replacementId) => emptyAndDeleteSizeChart(deleting.id, replacementId),
          }}
          renderExample={(reason, example) =>
            reason === 'products' ? (
              <Link
                to="/catalog/$productId"
                params={{ productId: example.id }}
                className="underline underline-offset-2 hover:text-foreground"
              >
                {example.label}
              </Link>
            ) : undefined
          }
          onDone={() => {
            setProblem(null);
            void queryClient.invalidateQueries({ queryKey: ['website', 'size-charts'] });
          }}
        />
      )}
    </WebsitePage>
  );
}

function ChartTable({ chart }: { readonly chart: Pick<SizeChart, 'name' | 'columns' | 'rows'> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm tabular-nums">
        <caption className="sr-only">{chart.name}</caption>
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            {chart.columns.map((column, index) => (
              <th key={index} scope="col" className="h-8 pr-4 font-medium">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {chart.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="h-row border-b border-border last:border-b-0">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="pr-4">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ChartEditor({
  chart,
  onClose,
}: {
  readonly chart: SizeChart | null;
  readonly onClose: () => void;
}) {
  const t = useWebsiteT();
  const id = useId();
  const queryClient = useQueryClient();
  const [name, setName] = useState(chart?.name ?? '');
  // A new chart starts from the old site's usual headings, in the console's language.
  const [columns, setColumns] = useState<string[]>([
    ...(chart?.columns ?? [
      t('web.charts.default.size'),
      t('web.charts.default.chest'),
      t('web.charts.default.waist'),
      t('web.charts.default.length'),
    ]),
  ]);
  const [rows, setRows] = useState<string[][]>(
    chart === null ? [columns.map(() => '')] : chart.rows.map((row) => [...row]),
  );

  const setCell = (rowIndex: number, cellIndex: number, value: string) =>
    setRows((current) =>
      current.map((row, at) =>
        at === rowIndex ? row.map((cell, index) => (index === cellIndex ? value : cell)) : row,
      ),
    );
  const addColumn = () => {
    setColumns((current) => [...current, '']);
    setRows((current) => current.map((row) => [...row, '']));
  };
  const removeColumn = () => {
    setColumns((current) => current.slice(0, -1));
    setRows((current) => current.map((row) => row.slice(0, -1)));
  };

  const ready =
    name.trim() !== '' &&
    columns.length > 0 &&
    columns.every((column) => column.trim() !== '') &&
    rows.length <= 60;

  const save = useMutation({
    mutationFn: () => {
      const input = {
        name: name.trim(),
        columns: columns.map((column) => column.trim()),
        rows: rows.map((row) => row.map((cell) => cell.trim())),
      };
      return chart === null ? createSizeChart(input) : updateSizeChart(chart.id, input);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['website', 'size-charts'] });
      onClose();
    },
  });

  return (
    <NamedSection
      title={t('web.charts.formTitle')}
      actions={
        <span className="inline-flex gap-2">
          <Button size="sm" variant="outline" onClick={onClose}>
            {t('web.cancel')}
          </Button>
          <Button size="sm" disabled={!ready || save.isPending} onClick={() => save.mutate()}>
            {t('web.save')}
          </Button>
        </span>
      }
    >
      <div className="space-y-4">
        <Field id={`${id}-name`} label={t('web.charts.name')}>
          <input
            id={`${id}-name`}
            value={name}
            maxLength={120}
            className={`${control} max-w-sm`}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <div className="overflow-x-auto">
          <table className="text-sm">
            <caption className="sr-only">{name === '' ? t('web.charts.formTitle') : name}</caption>
            <thead>
              <tr>
                {columns.map((column, index) => (
                  <th key={index} scope="col" className="pr-2 pb-2 text-left font-normal">
                    <input
                      aria-label={`${t('web.charts.heading')} ${String(index + 1)}`}
                      value={column}
                      maxLength={40}
                      className={`${control} w-32 font-medium`}
                      onChange={(event) =>
                        setColumns((current) =>
                          current.map((entry, at) => (at === index ? event.target.value : entry)),
                        )
                      }
                    />
                  </th>
                ))}
                <th scope="col">
                  <span className="sr-only">{t('web.charts.removeRow')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => (
                    <td key={cellIndex} className="pr-2 pb-2">
                      <input
                        aria-label={`${t('web.charts.cell')} ${String(rowIndex + 1)}, ${columns[cellIndex] ?? ''}`}
                        value={cell}
                        maxLength={40}
                        className={`${control} w-32 tabular-nums`}
                        onChange={(event) => setCell(rowIndex, cellIndex, event.target.value)}
                      />
                    </td>
                  ))}
                  <td className="pb-2">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label={`${t('web.charts.removeRow')} ${String(rowIndex + 1)}`}
                      onClick={() =>
                        setRows((current) => current.filter((_, at) => at !== rowIndex))
                      }
                    >
                      <Minus aria-hidden />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={rows.length >= 60}
            onClick={() => setRows((current) => [...current, columns.map(() => '')])}
          >
            <Plus aria-hidden />
            {t('web.charts.addRow')}
          </Button>
          <Button size="sm" variant="outline" disabled={columns.length >= 12} onClick={addColumn}>
            <Plus aria-hidden />
            {t('web.charts.addColumn')}
          </Button>
          <Button size="sm" variant="ghost" disabled={columns.length <= 1} onClick={removeColumn}>
            <Minus aria-hidden />
            {t('web.charts.removeColumn')}
          </Button>
        </div>
        <Problem error={save.error} />
      </div>
    </NamedSection>
  );
}
