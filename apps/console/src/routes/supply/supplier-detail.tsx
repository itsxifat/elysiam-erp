import { Button, DateTime, Money, PermissionGate } from '@elysium/ui';
import { useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { addContact, addNote, getStatement, getSupplier } from './api.js';
import { useSupplyT } from './messages.js';
import { control, Field, SupplyNav } from './supply-nav.js';

/**
 * One supplier: the profile, the people, the notes, the documents, and the statement.
 *
 * The statement is the part that matters, and the numbers in it are not computed here.
 * Every line is a `ledger.journal_lines` row and the closing balances come from the same
 * grouped query `GET /v1/ledger/party-balances` uses — so what this screen shows is what
 * the books say, not a running total assembled from supply entries. A statement that
 * disagreed with the ledger would be discovered by the supplier, months later.
 *
 * Two closing figures rather than one net number, because they are different facts: what
 * is owed and what the supplier is holding as an advance. Netting them would hide an
 * advance sitting with a mill the brand also owes money to, which is the position worth
 * watching.
 */
export function SupplierDetailPage() {
  const ability = useAbility();
  const st = useSupplyT();
  const queryClient = useQueryClient();
  const { supplierId } = useParams({ from: '/supply/suppliers/$supplierId' });

  const mayRead = ability.can('read', 'Supply');
  const mayUpdate = ability.can('update', 'Supply');
  const mayReadCost = ability.can('read', 'Cost');

  const [contactName, setContactName] = useState('');
  const [contactRole, setContactRole] = useState('');
  const [note, setNote] = useState('');
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));

  const supplier = useQuery({
    queryKey: ['supply', 'supplier', supplierId],
    queryFn: () => getSupplier(supplierId),
    enabled: mayRead,
  });

  const statement = useQuery({
    queryKey: ['supply', 'statement', supplierId, to],
    queryFn: () => getStatement(supplierId, { to }),
    enabled: mayReadCost,
  });

  const contact = useMutation({
    mutationFn: () =>
      addContact(supplierId, {
        name: contactName.trim(),
        ...(contactRole.trim() === '' ? {} : { role: contactRole.trim() }),
      }),
    onSuccess: () => {
      setContactName('');
      setContactRole('');
      void queryClient.invalidateQueries({ queryKey: ['supply', 'supplier', supplierId] });
    },
  });

  const noteMutation = useMutation({
    mutationFn: () => addNote(supplierId, note.trim()),
    onSuccess: () => {
      setNote('');
      void queryClient.invalidateQueries({ queryKey: ['supply', 'supplier', supplierId] });
    },
  });

  const row = supplier.data;

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: st('supply.deniedTitle'), detail: st('supply.deniedDetail') }}
    >
      <div className="space-y-6">
        <header>
          <h1 className="text-lg font-semibold tracking-tight">
            {row === undefined ? st('supply.supplier') : `${row.code} · ${row.name}`}
          </h1>
          <p className="text-sm text-muted-foreground">{st('supply.statementHint')}</p>
        </header>

        <SupplyNav />

        {row === undefined ? null : (
          <section className="grid gap-4 rounded-lg border border-border bg-card p-4 sm:grid-cols-4">
            <Detail label={st('supply.phone')}>{row.phone ?? '—'}</Detail>
            <Detail label={st('supply.terms')}>{row.paymentTermsDays ?? '—'}</Detail>
            <Detail label={st('supply.colDue')}>
              {row.duePoisha === undefined ? '—' : <Money poisha={row.duePoisha} />}
            </Detail>
            <Detail label={st('supply.colAdvance')}>
              {row.advancePoisha === undefined ? '—' : <Money poisha={row.advancePoisha} />}
            </Detail>
          </section>
        )}

        <section aria-label={st('supply.contacts')} className="space-y-2">
          <h2 className="text-sm font-semibold">{st('supply.contacts')}</h2>
          <ul className="space-y-1 text-sm">
            {(row?.contacts ?? []).map((person) => (
              <li key={person.id} className="flex flex-wrap items-center gap-2">
                <span>{person.name}</span>
                <span className="text-muted-foreground">{person.role ?? '—'}</span>
                <span className="text-muted-foreground tabular-nums">{person.phone ?? '—'}</span>
                {person.isPrimary ? (
                  <span className="text-xs text-muted-foreground">({st('supply.primary')})</span>
                ) : null}
              </li>
            ))}
          </ul>
          {(row?.contacts ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{st('supply.empty')}</p>
          ) : null}

          <PermissionGate allowed={mayUpdate}>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                contact.mutate();
              }}
            >
              <Field label={st('supply.name')} id="contact-name">
                <input
                  id="contact-name"
                  value={contactName}
                  required
                  maxLength={120}
                  className={`${control} sm:w-56`}
                  onChange={(event) => setContactName(event.target.value)}
                />
              </Field>
              <Field label={st('supply.role')} id="contact-role">
                <input
                  id="contact-role"
                  value={contactRole}
                  maxLength={60}
                  className={`${control} sm:w-40`}
                  onChange={(event) => setContactRole(event.target.value)}
                />
              </Field>
              <Button
                type="submit"
                size="sm"
                disabled={contactName.trim() === '' || contact.isPending}
              >
                {st('supply.addContact')}
              </Button>
            </form>
          </PermissionGate>
        </section>

        <section aria-label={st('supply.notes')} className="space-y-2">
          <h2 className="text-sm font-semibold">{st('supply.notes')}</h2>
          <ul className="space-y-2 text-sm">
            {(row?.notes ?? []).map((entry) => (
              <li key={entry.id} className="rounded-md border border-border p-2">
                <p>{entry.body}</p>
                <p className="text-xs text-muted-foreground">
                  <DateTime value={entry.createdAt} />
                </p>
              </li>
            ))}
          </ul>
          {(row?.notes ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{st('supply.empty')}</p>
          ) : null}

          <PermissionGate allowed={mayUpdate}>
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                noteMutation.mutate();
              }}
            >
              <Field label={st('supply.addNote')} id="supplier-note" hint={st('supply.noteHint')}>
                <input
                  id="supplier-note"
                  value={note}
                  required
                  maxLength={2000}
                  className={`${control} sm:w-96`}
                  onChange={(event) => setNote(event.target.value)}
                />
              </Field>
              <Button
                type="submit"
                size="sm"
                disabled={note.trim() === '' || noteMutation.isPending}
              >
                {st('supply.save')}
              </Button>
            </form>
          </PermissionGate>
        </section>

        <PermissionGate allowed={mayReadCost}>
          <section aria-label={st('supply.statement')} className="space-y-2">
            <h2 className="text-sm font-semibold">{st('supply.statement')}</h2>
            <Field label={st('supply.colDate')} id="statement-to">
              <input
                id="statement-to"
                type="date"
                value={to}
                className={`${control} sm:w-44`}
                onChange={(event) => setTo(event.target.value)}
              />
            </Field>

            {statement.error !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {statement.error instanceof ApiError
                  ? statement.error.message
                  : st('supply.errorDetail')}
              </p>
            ) : null}

            <div className="flex flex-wrap gap-6 text-sm">
              <Detail label={`${st('supply.opening')} · ${st('supply.colDue')}`}>
                <Money poisha={statement.data?.openingDuePoisha ?? '0'} />
              </Detail>
              <Detail label={`${st('supply.closing')} · ${st('supply.colDue')}`}>
                <Money poisha={statement.data?.closingDuePoisha ?? '0'} />
              </Detail>
              <Detail label={`${st('supply.closing')} · ${st('supply.colAdvance')}`}>
                <Money poisha={statement.data?.closingAdvancePoisha ?? '0'} />
              </Detail>
            </div>

            <table className="w-full text-sm">
              <caption className="sr-only">{st('supply.statement')}</caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th scope="col" className="py-2">
                    {st('supply.colDate')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('supply.colSource')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('supply.colAccount')}
                  </th>
                  <th scope="col" className="py-2">
                    {st('supply.colMemo')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {st('supply.colDebit')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {st('supply.colCredit')}
                  </th>
                  <th scope="col" className="py-2 text-right">
                    {st('supply.colRunning')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {(statement.data?.items ?? []).map((line) => (
                  <tr
                    key={`${line.journalId}-${line.lineNo}`}
                    className="border-b border-border/60"
                  >
                    <td className="py-2 tabular-nums">{line.businessDate}</td>
                    <td className="py-2">{line.sourceType}</td>
                    <td className="py-2">{line.account}</td>
                    <td className="py-2">{line.memo ?? '—'}</td>
                    <td className="py-2 text-right">
                      <Money poisha={line.debitPoisha} />
                    </td>
                    <td className="py-2 text-right">
                      <Money poisha={line.creditPoisha} />
                    </td>
                    <td className="py-2 text-right">
                      <Money poisha={line.runningDuePoisha} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {(statement.data?.items ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground">{st('supply.empty')}</p>
            ) : null}
            {statement.data?.truncated === true ? (
              <p className="text-sm text-muted-foreground">{st('supply.truncated')}</p>
            ) : null}
          </section>
        </PermissionGate>
      </div>
    </PermissionGate>
  );
}

function Detail({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="text-sm tabular-nums">{children}</p>
    </div>
  );
}
