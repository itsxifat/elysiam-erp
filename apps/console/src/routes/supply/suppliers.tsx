import {
  Button,
  Checkbox,
  EmptyState,
  Monogram,
  Money,
  PermissionGate,
  SearchInput,
  Section,
  StatusBadge,
} from '@elysium/ui';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Truck } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { createSupplier, listSuppliers, updateSupplier } from './api.js';
import { useSupplyT } from './messages.js';
import {
  control,
  Field,
  LoadingRows,
  SupplyHeader,
  TableFrame,
  TD,
  TD_NUMERIC,
  TH,
  TH_NUMERIC,
  TR,
} from './supply-nav.js';
import { deleteSupplier, supplierUsage } from '../../api/manage.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/manage.js';
import { DeleteOrArchive } from '../../ui/delete-or-archive.js';

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
 *
 * The add form stays on the page, one compact row above the list (D-447 does not apply:
 * three fields are quicker typed in place than opened in a sheet).
 */
export function SuppliersPage() {
  const ability = useAbility();
  const st = useSupplyT();
  const queryClient = useQueryClient();

  const mayRead = ability.can('read', 'Supply');
  const mayCreate = ability.can('create', 'Supply');
  const mayUpdate = ability.can('update', 'Supply');
  // M39a (D-630): a supplier nothing names can be deleted (org_admin); one that is named is
  // deactivated, and a deactivated one can be brought back.
  const mayDelete = ability.can('delete', 'Supply');
  const [managing, setManaging] = useState<{ id: string; name: string } | null>(null);
  const tm = useT();

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
  const reactivate = useMutation({
    mutationFn: (id: string) => updateSupplier(id, { isActive: true }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['supply'] }),
  });

  const rows = suppliers.data?.items ?? [];

  return (
    <PermissionGate
      allowed={mayRead || mayCreate}
      explain={{ title: st('supply.deniedTitle'), detail: st('supply.deniedDetail') }}
    >
      <div className="space-y-6">
        <SupplyHeader title={st('supply.suppliers')} description={st('supply.statementHint')} />

        <PermissionGate allowed={mayCreate}>
          <Section title={st('supply.newSupplier')}>
            <form
              className="grid items-end gap-4 sm:grid-cols-[1fr_2fr_1fr_auto]"
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
                  className={`${control} uppercase`}
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
                  inputMode="tel"
                  className={`${control} tabular-nums`}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </Field>
              <Button
                type="submit"
                disabled={code.trim() === '' || name.trim() === '' || create.isPending}
              >
                <Plus aria-hidden="true" />
                {st('supply.newSupplier')}
              </Button>
              {create.error !== null ? (
                <p role="alert" className="text-sm text-destructive sm:col-span-4">
                  {create.error instanceof ApiError
                    ? create.error.message
                    : st('supply.saveFailed')}
                </p>
              ) : null}
            </form>
          </Section>
        </PermissionGate>

        <PermissionGate allowed={mayRead}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-3">
              <label className="sr-only" htmlFor="supplier-search">
                {st('supply.search')}
              </label>
              <SearchInput
                id="supplier-search"
                value={term}
                placeholder={st('supply.search')}
                onChange={(event) => setTerm(event.target.value)}
              />
              <label className="flex items-center gap-2 text-sm text-foreground">
                <Checkbox
                  checked={includeInactive}
                  onCheckedChange={(checked) => setIncludeInactive(checked === true)}
                />
                {st('supply.includeInactive')}
              </label>
            </div>

            {suppliers.data?.costWithheld === true ? (
              <p className="text-sm text-muted-foreground">{st('supply.costWithheld')}</p>
            ) : null}

            <section aria-label={st('supply.suppliers')}>
              {suppliers.isPending ? (
                <LoadingRows />
              ) : rows.length === 0 ? (
                <EmptyState icon={Truck} title={st('supply.empty')} />
              ) : (
                <TableFrame label={st('supply.suppliers')}>
                  <table className="w-full border-separate border-spacing-0 text-sm">
                    <caption className="sr-only">{st('supply.suppliers')}</caption>
                    <thead>
                      <tr>
                        <th scope="col" className={TH}>
                          {st('supply.code')}
                        </th>
                        <th scope="col" className={TH}>
                          {st('supply.name')}
                        </th>
                        <th scope="col" className={TH}>
                          {st('supply.phone')}
                        </th>
                        <th scope="col" className={TH_NUMERIC}>
                          {st('supply.colDue')}
                        </th>
                        <th scope="col" className={TH_NUMERIC}>
                          {st('supply.colAdvance')}
                        </th>
                        <th scope="col" className={TH}>
                          {st('supply.colStatus')}
                        </th>
                        <th scope="col" className={TH}>
                          <span className="sr-only">{st('supply.deactivate')}</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id} className={TR}>
                          <td className={`${TD} font-medium tabular-nums`}>{row.code}</td>
                          <td className={TD}>
                            <Link
                              to="/supply/suppliers/$supplierId"
                              params={{ supplierId: row.id }}
                              className="inline-flex items-center gap-2.5 rounded-sm font-medium underline-offset-4 hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                            >
                              <Monogram name={row.name} size="sm" />
                              {row.name}
                            </Link>
                          </td>
                          <td className={`${TD} text-muted-foreground tabular-nums`}>
                            {row.phone ?? '—'}
                          </td>
                          <td className={TD_NUMERIC}>
                            {row.duePoisha === undefined ? '—' : <Money poisha={row.duePoisha} />}
                          </td>
                          <td className={TD_NUMERIC}>
                            {row.advancePoisha === undefined ? (
                              '—'
                            ) : (
                              <Money poisha={row.advancePoisha} />
                            )}
                          </td>
                          <td className={TD}>
                            <StatusBadge tone={row.isActive ? 'success' : 'neutral'}>
                              {row.isActive ? st('supply.active') : st('supply.inactive')}
                            </StatusBadge>
                          </td>
                          <td className={`${TD} text-right`}>
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
                            {mayUpdate && !row.isActive ? (
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                disabled={reactivate.isPending}
                                onClick={() => reactivate.mutate(row.id)}
                              >
                                {tm('mg.restore')}
                              </Button>
                            ) : null}
                            {mayDelete ? (
                              <Button
                                type="button"
                                size="icon-sm"
                                variant="ghost"
                                aria-label={tm('mg.setup.manageNamed').replace('{name}', row.name)}
                                title={tm('mg.setup.manage')}
                                onClick={() => setManaging({ id: row.id, name: row.name })}
                              >
                                <Trash2 aria-hidden="true" />
                              </Button>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              )}
            </section>
          </div>
        </PermissionGate>
        {managing === null ? null : (
          <DeleteOrArchive
            key={managing.id}
            open
            onClose={() => setManaging(null)}
            queryKey={['supply', 'suppliers', managing.id]}
            loadUsage={() => supplierUsage(managing.id)}
            onDelete={() => deleteSupplier(managing.id)}
            onArchive={() => updateSupplier(managing.id, { isActive: false })}
            onRestore={() => updateSupplier(managing.id, { isActive: true })}
            onDone={() => void queryClient.invalidateQueries({ queryKey: ['supply'] })}
          />
        )}
      </div>
    </PermissionGate>
  );
}
