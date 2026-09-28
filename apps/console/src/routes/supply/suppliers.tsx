import { Button, Money, PermissionGate, StatusBadge } from '@elysium/ui';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { createSupplier, listSuppliers, updateSupplier } from './api.js';
import { useSupplyT } from './messages.js';
import { control, Field, SupplyNav } from './supply-nav.js';

/**
 * The supplier list: who the brand buys from, what it owes them, what they hold (M09).
 *
 * The two money columns are the screen's reason to exist — a purchasing team's first
 * question is "who are we behind with" — and they are rendered only when the server sent
 * them. `duePoisha` and `advancePoisha` are supplier balances, which §6 protects like
 * cost, so a caller without `read Cost` receives rows without them and `costWithheld:
 * true`. Rendering `<Money>` over an absent value would print a broken amount to exactly
 * the person who should not see the figure.
 *
 * Deactivating rather than deleting, and the button says so. A supplier the brand once
 * bought from is part of the record: every entry, return and payment names them, and the
 * server holds no DELETE on the table at all.
 */
export function SuppliersPage() {
  const ability = useAbility();
  const st = useSupplyT();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Supply');
  const mayCreate = ability.can('create', 'Supply');
  const mayUpdate = ability.can('update', 'Supply');

  const [term, setTerm] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');

  const suppliers = useQuery({
    queryKey: ['supply', 'suppliers', term, includeInactive],
    queryFn: () => listSuppliers({ q: term === '' ? undefined : term, includeInactive }),
    enabled: mayRead,
  });

  const create = useMutation({
    mutationFn: () =>
      createSupplier({
        code: code.trim().toUpperCase(),
        name: name.trim(),
        ...(phone.trim() === '' ? {} : { phone: phone.trim() }),
      }),
    onSuccess: () => {
      setCode('');
      setName('');
      setPhone('');
      void queryClient.invalidateQueries({ queryKey: ['supply'] });
    },
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => updateSupplier(id, { isActive: false }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['supply'] }),
  });

  return (
    <PermissionGate
      allowed={mayRead || mayCreate}
      explain={{ title: st('supply.deniedTitle'), detail: st('supply.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">{st('supply.suppliers')}</h1>
          <p className="text-sm text-muted-foreground">{st('supply.statementHint')}</p>
        </header>

        <SupplyNav />

        <PermissionGate allowed={mayCreate}>
          <form
            className="grid gap-3 rounded-lg border border-border bg-card p-4 sm:grid-cols-4"
            onSubmit={(event) => {
              event.preventDefault();
              create.mutate();
            }}
          >
            <Field label={st('supply.code')} id="supplier-code">
              <input
                id="supplier-code"
                value={code}
                required
                maxLength={24}
                className={control}
                onChange={(event) => setCode(event.target.value)}
              />
            </Field>
            <Field label={st('supply.name')} id="supplier-name">
              <input
                id="supplier-name"
                value={name}
                required
                maxLength={160}
                className={control}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
            <Field label={st('supply.phone')} id="supplier-phone">
              <input
                id="supplier-phone"
                value={phone}
                maxLength={32}
                className={control}
                onChange={(event) => setPhone(event.target.value)}
              />
            </Field>
            <div className="flex items-end gap-3">
              <Button
                type="submit"
                size="sm"
                disabled={code.trim() === '' || name.trim() === '' || create.isPending}
              >
                {st('supply.newSupplier')}
              </Button>
            </div>
            {create.error !== null ? (
              <p role="alert" className="text-sm text-destructive sm:col-span-4">
                {create.error instanceof ApiError ? create.error.message : st('supply.saveFailed')}
              </p>
            ) : null}
          </form>
        </PermissionGate>

        <PermissionGate allowed={mayRead}>
          <div className="flex flex-wrap items-end gap-3">
            <Field label={st('supply.search')} id="supplier-search">
              <input
                id="supplier-search"
                value={term}
                className={`${control} sm:w-72`}
                onChange={(event) => setTerm(event.target.value)}
              />
            </Field>
            <label className="flex items-center gap-2 pb-1 text-sm">
              <input
                type="checkbox"
                checked={includeInactive}
                className="size-4 rounded border-border"
                onChange={(event) => setIncludeInactive(event.target.checked)}
              />
              {st('supply.includeInactive')}
            </label>
          </div>

          {suppliers.data?.costWithheld === true ? (
            <p className="text-sm text-muted-foreground">{st('supply.costWithheld')}</p>
          ) : null}

          <section aria-label={st('supply.suppliers')} className="space-y-2">
            <table className="w-full text-sm">
              <caption className="sr-only">{st('supply.suppliers')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {st('supply.code')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('supply.name')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('supply.phone')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {st('supply.colDue')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {st('supply.colAdvance')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('supply.colStatus')}
                  </th>
                  <th scope="col" className="py-2" />
                </tr>
              </thead>
              <tbody>
                {(suppliers.data?.items ?? []).map((row) => (
                  <tr key={row.id} className="border-b border-border/60">
                    <td className="py-2 tabular-nums">{row.code}</td>
                    <td className="py-2">
                      <Link
                        to="/supply/suppliers/$supplierId"
                        params={{ supplierId: row.id }}
                        className="underline decoration-border underline-offset-4 hover:decoration-foreground"
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="py-2 tabular-nums">{row.phone ?? '—'}</td>
                    <td className="py-2 text-right">
                      {row.duePoisha === undefined ? '—' : <Money poisha={row.duePoisha} />}
                    </td>
                    <td className="py-2 text-right">
                      {row.advancePoisha === undefined ? '—' : <Money poisha={row.advancePoisha} />}
                    </td>
                    <td className="py-2">
                      <StatusBadge tone={row.isActive ? 'success' : 'neutral'}>
                        {row.isActive ? st('supply.active') : st('supply.inactive')}
                      </StatusBadge>
                    </td>
                    <td className="py-2 text-right">
                      {mayUpdate && row.isActive ? (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          disabled={deactivate.isPending}
                          onClick={() => deactivate.mutate(row.id)}
                        >
                          {st('supply.deactivate')}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(suppliers.data?.items ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{st('supply.empty')}</p>
            ) : null}
          </section>
        </PermissionGate>
      </div>
    </PermissionGate>
  );
}
