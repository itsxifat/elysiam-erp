import type { UsageEntry, UsageExample, UsageReason, UsageReport } from '@elysium/contracts';
import { formatCount } from '@elysium/i18n';
import { Button, Checkbox, Dialog, Select, Spinner, type SelectOption } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Trash2 } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { ApiError } from '../api.js';
import { useLocale } from '../i18n/locale.js';
import '../i18n/manage.js';

/**
 * The one Delete-or-archive dialog (M39a, D-621).
 *
 * It asks the server what uses the row first (`loadUsage`, one of the `…Usage` calls in
 * `api/manage.ts`) and offers only what can work:
 *
 * - **Delete**, when nothing uses it: gone for good, with its own audit row.
 * - **Empty and delete**, when everything that uses it can be moved (a category's products,
 *   subcategories and menu entries; a size chart's products): choose where they go.
 * - **Archive instead**, when something keeps it and the row has an archive state: hidden from
 *   new work, kept wherever it is used. Optionally "also archive the N variants" for a size or
 *   a colour.
 * - **Restore**, when it is already archived.
 *
 * What uses it is listed in plain words with counts and a few names, which a caller may turn
 * into links (`renderExample`). The server checks again inside its transaction; a delete that
 * lost a race comes back `*_IN_USE` and the report is loaded again.
 *
 * For M39b's product page and list: pass `productUsage` / `skuUsage` as `loadUsage`,
 * `deleteProduct` / `deleteSku` as `onDelete`, and the existing archive PATCH as `onArchive`.
 */
export interface DeleteOrArchiveProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** React Query's key for the usage report, unique to the row. */
  readonly queryKey: readonly unknown[];
  readonly loadUsage: () => Promise<UsageReport>;
  /** Present when the row can be deleted at all (the caller's ability decides). */
  readonly onDelete?: (() => Promise<unknown>) | undefined;
  readonly emptyAndDelete?:
    | {
        readonly help: string;
        /** Where the row's dependants can go; the row itself must not be among them. */
        readonly targets: readonly SelectOption[];
        /** The "none" choice ("No category", "No size chart"). */
        readonly noneLabel: string;
        readonly run: (targetId: string | null) => Promise<unknown>;
      }
    | undefined;
  /** Present when the row has an archive state the caller may set. */
  readonly onArchive?: ((withVariants: boolean) => Promise<unknown>) | undefined;
  /** What archiving this kind of row means, beyond the general sentence. */
  readonly archiveNote?: string | undefined;
  /** Offer "also archive the N variants" (sizes, colours, lists). */
  readonly offerArchiveVariants?: boolean | undefined;
  readonly onRestore?: (() => Promise<unknown>) | undefined;
  readonly renderExample?:
    ((reason: UsageReason, example: UsageExample) => ReactNode | undefined) | undefined;
  /** After any action succeeded: refresh the screen behind. */
  readonly onDone: () => void;
}

const fill = (text: string, values: Readonly<Record<string, string>>): string =>
  Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text);

export function DeleteOrArchive(props: DeleteOrArchiveProps) {
  const { t, locale } = useLocale();
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [target, setTarget] = useState('');
  const [withVariants, setWithVariants] = useState(false);
  const checkboxId = useId();

  const usage = useQuery({
    queryKey: [...props.queryKey, 'usage'],
    queryFn: props.loadUsage,
    enabled: props.open,
    staleTime: 0,
    retry: false,
  });

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setProblem(null);
    try {
      await action();
      props.onDone();
      props.onClose();
    } catch (error) {
      setProblem(error);
      // Something started using it since the report was read: read it again.
      if (error instanceof ApiError && error.code?.endsWith('_IN_USE') === true) {
        await usage.refetch();
      }
    } finally {
      setBusy(false);
    }
  }

  const report = usage.data;
  const name = report?.label ?? '';
  const title = report === undefined ? t('mg.title') : fill(t('mg.titleNamed'), { name });

  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next && !busy) props.onClose();
      }}
      title={title}
      closeLabel={t('mg.close')}
      className="w-[min(36rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button variant="outline" disabled={busy} onClick={props.onClose}>
            {t('mg.cancel')}
          </Button>
          {report?.canDelete === true && props.onDelete !== undefined ? (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => void run(props.onDelete ?? (() => Promise.resolve()))}
            >
              <Trash2 aria-hidden />
              {t('mg.deleteForGood')}
            </Button>
          ) : null}
        </>
      }
    >
      {usage.isPending ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner label={t('mg.loading')} />
          {t('mg.loading')}
        </div>
      ) : report === undefined ? (
        <Failure error={usage.error} />
      ) : (
        <div className="space-y-5 text-sm">
          {report.archived ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/60 p-3">
              <p>{fill(t('mg.archived'), { name })}</p>
              {props.onRestore === undefined ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void run(props.onRestore ?? (() => Promise.resolve()))}
                >
                  <ArchiveRestore aria-hidden />
                  {t('mg.restore')}
                </Button>
              )}
            </div>
          ) : null}

          {report.uses.length === 0 ? (
            <p>{fill(t('mg.unused'), { name })}</p>
          ) : (
            <section aria-label={fill(t('mg.usedBy'), { name })} className="space-y-2">
              <h3 className="font-medium">{fill(t('mg.usedBy'), { name })}</h3>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {report.uses.map((use) => (
                  <UseRow
                    key={use.reason}
                    use={use}
                    label={t(`mg.reason.${use.reason}`)}
                    count={formatCount(use.count, locale)}
                    more={t('mg.andMore')}
                    renderExample={props.renderExample}
                  />
                ))}
              </ul>
              {report.canEmptyAndDelete ? null : (
                <p className="text-muted-foreground">{t('mg.cannotDelete')}</p>
              )}
            </section>
          )}

          {report.canEmptyAndDelete && props.emptyAndDelete !== undefined ? (
            <section className="space-y-3 rounded-lg border border-border p-4">
              <h3 className="font-medium">{t('mg.empty.title')}</h3>
              <p className="text-muted-foreground">{props.emptyAndDelete.help}</p>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex flex-col gap-1.5">
                  <span className="font-medium">{t('mg.empty.target')}</span>
                  <Select
                    value={target}
                    onValueChange={setTarget}
                    className="min-w-56"
                    options={[
                      { value: '', label: props.emptyAndDelete.noneLabel },
                      ...props.emptyAndDelete.targets,
                    ]}
                  />
                </label>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => {
                    const empty = props.emptyAndDelete;
                    if (empty !== undefined)
                      void run(() => empty.run(target === '' ? null : target));
                  }}
                >
                  {t('mg.empty.action')}
                </Button>
              </div>
            </section>
          ) : null}

          {/* Archive when something keeps the row, or when this person may not delete it
              (marketing archives a discount nobody used; only org_admin deletes). */}
          {report.canArchive &&
          props.onArchive !== undefined &&
          (!report.canDelete || props.onDelete === undefined) ? (
            <section className="space-y-3 rounded-lg border border-border p-4">
              <h3 className="font-medium">{t('mg.archive.title')}</h3>
              <p className="text-muted-foreground">
                {t('mg.archive.help')}
                {props.archiveNote === undefined ? null : ` ${props.archiveNote}`}
              </p>
              {props.offerArchiveVariants === true && (report.activeVariants ?? 0) > 0 ? (
                <label htmlFor={checkboxId} className="flex items-center gap-2">
                  <Checkbox
                    id={checkboxId}
                    checked={withVariants}
                    onCheckedChange={(next) => setWithVariants(next === true)}
                  />
                  {fill(t('mg.archive.variants'), {
                    n: formatCount(report.activeVariants ?? 0, locale),
                  })}
                </label>
              ) : null}
              <Button
                variant="outline"
                disabled={busy}
                onClick={() => {
                  const archive = props.onArchive;
                  if (archive !== undefined) void run(() => archive(withVariants));
                }}
              >
                <Archive aria-hidden />
                {t('mg.archive.action')}
              </Button>
            </section>
          ) : null}

          <Failure error={problem} />
        </div>
      )}
    </Dialog>
  );
}

function UseRow({
  use,
  label,
  count,
  more,
  renderExample,
}: {
  readonly use: UsageEntry;
  readonly label: string;
  readonly count: string;
  readonly more: string;
  readonly renderExample: DeleteOrArchiveProps['renderExample'];
}) {
  return (
    <li className="space-y-1 px-3 py-2">
      <div className="flex items-baseline justify-between gap-3">
        <span>{label}</span>
        <span className="font-medium tabular-nums">{count}</span>
      </div>
      {use.examples.length === 0 ? null : (
        <p className="text-xs text-muted-foreground">
          {use.examples.map((example, index) => (
            <span key={example.id}>
              {index === 0 ? null : ', '}
              {renderExample?.(use.reason, example) ?? example.label}
            </span>
          ))}
          {use.count > use.examples.length ? `, ${more}` : null}
        </p>
      )}
    </li>
  );
}

function Failure({ error }: { readonly error: unknown }) {
  const { t } = useLocale();
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {error instanceof ApiError ? error.message : t('mg.failed')}
    </p>
  );
}
