import { formatCount } from '@elysium/i18n';
import { Button, Dialog, Spinner, controlClassName } from '@elysium/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { branchHolds, updateBranch, type BranchHolds } from '../../api/manage.js';
import { useLocale } from '../../i18n/locale.js';
import '../../i18n/manage.js';

/**
 * Rename a branch, or switch it off once nothing runs there (M39a, D-633).
 *
 * Never a delete: a branch's sales, cash and staff history name it from its first day. The
 * dialog asks the server what still runs at the branch (tills switched on, open shifts,
 * wallets holding money, staff, stock) and offers "Switch off" only when the answer is
 * nothing; the server checks again when it is pressed.
 */
export function BranchManageDialog({
  branchId,
  onClose,
  onDone,
}: {
  readonly branchId: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const { t, locale } = useLocale();
  const nameId = useId();
  const holds = useQuery({
    queryKey: ['pos', 'branches', branchId, 'holds'],
    queryFn: () => branchHolds(branchId),
    staleTime: 0,
    retry: false,
  });
  const [name, setName] = useState<string | null>(null);
  const current = holds.data;
  const shownName = name ?? current?.name ?? '';

  const save = useMutation({
    mutationFn: (patch: { name?: string; isActive?: boolean }) => updateBranch(branchId, patch),
    onSuccess: () => {
      onDone();
      onClose();
    },
  });

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('mg.branch.title').replace('{name}', current?.name ?? '')}
      description={t('mg.branch.never')}
      closeLabel={t('mg.close')}
      className="w-[min(34rem,calc(100vw-2rem))]"
      footer={
        <Button variant="outline" onClick={onClose}>
          {t('mg.cancel')}
        </Button>
      }
    >
      {current === undefined ? (
        holds.isPending ? (
          <Spinner label={t('mg.loading')} />
        ) : (
          <Failure error={holds.error} />
        )
      ) : (
        <div className="space-y-5 text-sm">
          <div className="space-y-2">
            <label htmlFor={nameId} className="font-medium">
              {t('mg.branch.name')}
            </label>
            <div className="flex flex-wrap gap-2">
              <input
                id={nameId}
                value={shownName}
                maxLength={120}
                onChange={(event) => setName(event.target.value)}
                className={`${controlClassName} min-w-56 flex-1`}
              />
              <Button
                disabled={
                  shownName.trim() === '' || shownName.trim() === current.name || save.isPending
                }
                onClick={() => save.mutate({ name: shownName.trim() })}
              >
                {t('mg.branch.rename')}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              <span className="font-mono">{current.code}</span> · {t('mg.branch.codeFixed')}
            </p>
          </div>

          {current.isActive ? (
            <Deactivate
              holds={current}
              count={(n) => formatCount(n, locale)}
              busy={save.isPending}
              onDeactivate={() => save.mutate({ isActive: false })}
            />
          ) : (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/60 p-3">
              <span>{t('mg.branch.inactive')}</span>
              <Button
                variant="outline"
                disabled={save.isPending}
                onClick={() => save.mutate({ isActive: true })}
              >
                {t('mg.branch.reactivate')}
              </Button>
            </div>
          )}
          <Failure error={save.error} />
        </div>
      )}
    </Dialog>
  );
}

function Deactivate({
  holds,
  count,
  busy,
  onDeactivate,
}: {
  readonly holds: BranchHolds;
  readonly count: (n: number) => string;
  readonly busy: boolean;
  readonly onDeactivate: () => void;
}) {
  const { t } = useLocale();
  const rows = [
    { key: 'registers', label: t('mg.branch.registers'), n: holds.holds.registers },
    { key: 'openShifts', label: t('mg.branch.openShifts'), n: holds.holds.openShifts },
    { key: 'wallets', label: t('mg.branch.walletsWithMoney'), n: holds.holds.walletsWithMoney },
    { key: 'employees', label: t('mg.branch.employees'), n: holds.holds.employees },
    { key: 'stock', label: t('mg.branch.stockPlaces'), n: holds.holds.stockPlaces },
  ].filter((row) => row.n > 0);
  return (
    <section className="space-y-3 rounded-lg border border-border p-4">
      {rows.length === 0 ? (
        <p>{t('mg.branch.ready')}</p>
      ) : (
        <>
          <p>{t('mg.branch.blocked')}</p>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {rows.map((row) => (
              <li key={row.key} className="flex items-baseline justify-between px-3 py-2">
                <span>{row.label}</span>
                <span className="font-medium tabular-nums">{count(row.n)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <Button variant="outline" disabled={busy || !holds.canDeactivate} onClick={onDeactivate}>
        {t('mg.branch.deactivate')}
      </Button>
    </section>
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
