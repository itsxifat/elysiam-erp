import { Button, Dialog, Select, StatusBadge, controlClassName } from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useId, useState } from 'react';

import { ApiError } from '../../api.js';
import { createHead, listHeads, updateHead, type Head } from '../../api/manage.js';
import { useAbility } from '../../auth/session.js';
import { useLocale } from '../../i18n/locale.js';
import '../../i18n/manage.js';

/**
 * The brand's expense and income heads (M39a, D-634), under the wallets they are paid from.
 *
 * Add a head ("Electricity", "Scrap sale"); rename, archive or restore one the brand added.
 * The chart's standard heads (Rent, Utilities, Other income …) stay as they are, and no head
 * is ever deleted: the books keep every entry against it. A branch manager books against
 * heads but does not set them up, so the server answers them 404 and this section stays away.
 */
export function HeadsSection() {
  const { t } = useLocale();
  const ability = useAbility();
  const queryClient = useQueryClient();
  const nameId = useId();
  const kindId = useId();
  const may = ability.can('update', 'Wallet');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'expense' | 'income'>('expense');
  const [renaming, setRenaming] = useState<Head | null>(null);

  const heads = useQuery({
    queryKey: ['accounts', 'heads'],
    queryFn: listHeads,
    enabled: may,
    retry: false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['accounts'] });

  const create = useMutation({
    mutationFn: () => createHead({ name: name.trim(), kind }),
    onSuccess: async () => {
      setName('');
      await refresh();
    },
  });
  const change = useMutation({
    mutationFn: (input: { id: string; patch: { name?: string; isActive?: boolean } }) =>
      updateHead(input.id, input.patch),
    onSuccess: refresh,
  });

  // Not for this role (or not this scope): nothing to show.
  if (!may || (heads.error instanceof ApiError && heads.error.status === 404)) return null;

  return (
    <section
      aria-labelledby="heads-heading"
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <div className="space-y-1">
        <h2 id="heads-heading" className="text-base font-semibold tracking-tight">
          {t('mg.heads.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('mg.heads.help')}</p>
      </div>

      <ul className="divide-y divide-border rounded-lg border border-border">
        {(heads.data?.items ?? []).map((head) => (
          <li key={head.id} className="flex min-h-row items-center gap-3 px-4 py-1.5 text-sm">
            <span className="w-12 font-mono text-xs text-muted-foreground tabular-nums">
              {head.code}
            </span>
            <span className={head.isActive ? 'font-medium' : 'text-muted-foreground'}>
              {head.name}
            </span>
            <StatusBadge tone="neutral">
              {head.kind === 'income' ? t('mg.heads.income') : t('mg.heads.expense')}
            </StatusBadge>
            {head.isSystem ? <StatusBadge tone="info">{t('mg.heads.system')}</StatusBadge> : null}
            {head.isActive ? null : (
              <StatusBadge tone="neutral">{t('mg.archivedBadge')}</StatusBadge>
            )}
            <span className="flex-1" />
            {head.isSystem ? (
              <span className="text-xs text-muted-foreground">{t('mg.heads.systemHint')}</span>
            ) : (
              <>
                <Button size="sm" variant="ghost" onClick={() => setRenaming(head)}>
                  {t('mg.setup.rename')}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={change.isPending}
                  onClick={() =>
                    change.mutate({ id: head.id, patch: { isActive: !head.isActive } })
                  }
                >
                  {head.isActive ? t('mg.heads.archive') : t('mg.heads.restore')}
                </Button>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/50 p-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-sm font-medium">
            {t('mg.heads.name')}
          </label>
          <input
            id={nameId}
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            className={controlClassName}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <span id={kindId} className="text-sm font-medium">
            {t('mg.heads.kind')}
          </span>
          <Select
            aria-labelledby={kindId}
            value={kind}
            onValueChange={(value) => setKind(value === 'income' ? 'income' : 'expense')}
            className="min-w-36"
            options={[
              { value: 'expense', label: t('mg.heads.expense') },
              { value: 'income', label: t('mg.heads.income') },
            ]}
          />
        </div>
        <Button
          size="sm"
          disabled={name.trim() === '' || create.isPending}
          onClick={() => create.mutate()}
        >
          <Plus aria-hidden />
          {t('mg.heads.add')}
        </Button>
        <Failure error={create.error ?? change.error} />
      </div>

      {renaming === null ? null : (
        <RenameHead
          key={renaming.id}
          head={renaming}
          onClose={() => setRenaming(null)}
          onSave={async (next) => {
            await change.mutateAsync({ id: renaming.id, patch: { name: next } });
          }}
        />
      )}
    </section>
  );
}

function RenameHead({
  head,
  onClose,
  onSave,
}: {
  readonly head: Head;
  readonly onClose: () => void;
  readonly onSave: (name: string) => Promise<void>;
}) {
  const { t } = useLocale();
  const id = useId();
  const [value, setValue] = useState(head.name);
  const save = useMutation({ mutationFn: () => onSave(value.trim()), onSuccess: onClose });
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('mg.heads.renameTitle')}
      closeLabel={t('mg.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('mg.cancel')}
          </Button>
          <Button disabled={value.trim() === '' || save.isPending} onClick={() => save.mutate()}>
            {t('mg.heads.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-1.5">
        <label htmlFor={id} className="text-sm font-medium">
          {t('mg.heads.name')}
        </label>
        <input
          id={id}
          value={value}
          maxLength={120}
          onChange={(event) => setValue(event.target.value)}
          className={controlClassName}
        />
      </div>
      <Failure error={save.error} />
    </Dialog>
  );
}

function Failure({ error }: { readonly error: unknown }) {
  const { t } = useLocale();
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className="basis-full text-sm text-destructive">
      {error instanceof ApiError ? error.message : t('mg.failed')}
    </p>
  );
}
