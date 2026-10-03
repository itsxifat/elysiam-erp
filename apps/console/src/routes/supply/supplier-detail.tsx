import {
  Button,
  DateTime,
  EmptyState,
  Monogram,
  Money,
  PermissionGate,
  Section,
  StatusBadge,
} from '@elysium/ui';
import { Link, useParams } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ScrollText } from 'lucide-react';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { DatePicker } from '../../ui/date-picker.js';
import { addContact, addNote, getStatement, getSupplier } from './api.js';
import { useSupplyT } from './messages.js';
import {
  control,
  Field,
  SupplyHeader,
  TableFrame,
  TD,
  TD_NUMERIC,
  TH,
  TH_NUMERIC,
  TR,
} from './supply-nav.js';

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
  const statementRows = statement.data?.items ?? [];

  return (
    <PermissionGate
      allowed={mayRead}
      explain={{ title: st('supply.deniedTitle'), detail: st('supply.deniedDetail') }}
    >
      <div className="space-y-6">
        <SupplyHeader
          eyebrow={
            <Link
              to="/supply"
              className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <ArrowLeft aria-hidden="true" className="size-3.5" />
              {st('supply.suppliers')}
            </Link>
          }
          title={row === undefined ? st('supply.supplier') : `${row.code} · ${row.name}`}
          description={st('supply.statementHint')}
        />

        {row === undefined ? null : (
          <dl className="grid overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-4 sm:divide-x sm:divide-border">
            <Detail label={st('supply.phone')}>{row.phone ?? '—'}</Detail>
            <Detail label={st('supply.terms')}>{row.paymentTermsDays ?? '—'}</Detail>
            <Detail label={st('supply.colDue')} figure>
              {row.duePoisha === undefined ? (
                '—'
              ) : (
                <Money poisha={row.duePoisha} align="start" compact />
              )}
            </Detail>
            <Detail label={st('supply.colAdvance')} figure>
              {row.advancePoisha === undefined ? (
                '—'
              ) : (
                <Money poisha={row.advancePoisha} align="start" compact />
              )}
            </Detail>
          </dl>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <Section title={st('supply.contacts')}>
            <section aria-label={st('supply.contacts')} className="space-y-4">
              {(row?.contacts ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">{st('supply.empty')}</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {(row?.contacts ?? []).map((person) => (
                    <li key={person.id} className="flex flex-wrap items-center gap-3 py-2.5">
                      <Monogram name={person.name} size="sm" className="rounded-full" />
                      <span className="font-medium">{person.name}</span>
                      <span className="text-muted-foreground">{person.role ?? '—'}</span>
                      <span className="text-muted-foreground tabular-nums">
                        {person.phone ?? '—'}
                      </span>
                      {person.isPrimary ? (
                        <StatusBadge tone="info">{st('supply.primary')}</StatusBadge>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}

              <PermissionGate allowed={mayUpdate}>
                <form
                  className="grid items-end gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_1fr_auto]"
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
                      className={control}
                      onChange={(event) => setContactName(event.target.value)}
                    />
                  </Field>
                  <Field label={st('supply.role')} id="contact-role">
                    <input
                      id="contact-role"
                      value={contactRole}
                      maxLength={60}
                      className={control}
                      onChange={(event) => setContactRole(event.target.value)}
                    />
                  </Field>
                  <Button
                    type="submit"
                    variant="outline"
                    disabled={contactName.trim() === '' || contact.isPending}
                  >
                    {st('supply.addContact')}
                  </Button>
                </form>
              </PermissionGate>
            </section>
          </Section>

          <Section title={st('supply.notes')}>
            <section aria-label={st('supply.notes')} className="space-y-4">
              {(row?.notes ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground">{st('supply.empty')}</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {(row?.notes ?? []).map((entry) => (
                    <li key={entry.id} className="space-y-0.5 py-2.5">
                      <p>{entry.body}</p>
                      <p className="text-xs text-muted-foreground">
                        <DateTime value={entry.createdAt} />
                      </p>
                    </li>
                  ))}
                </ul>
              )}

              <PermissionGate allowed={mayUpdate}>
                <form
                  className="grid items-end gap-3 border-t border-border pt-4 sm:grid-cols-[1fr_auto]"
                  onSubmit={(event) => {
                    event.preventDefault();
                    noteMutation.mutate();
                  }}
                >
                  <Field
                    label={st('supply.addNote')}
                    id="supplier-note"
                    hint={st('supply.noteHint')}
                  >
                    <input
                      id="supplier-note"
                      value={note}
                      required
                      maxLength={2000}
                      className={control}
                      onChange={(event) => setNote(event.target.value)}
                    />
                  </Field>
                  <Button
                    type="submit"
                    variant="outline"
                    className="sm:mb-6"
                    disabled={note.trim() === '' || noteMutation.isPending}
                  >
                    {st('supply.save')}
                  </Button>
                </form>
              </PermissionGate>
            </section>
          </Section>
        </div>

        <PermissionGate allowed={mayReadCost}>
          <section aria-label={st('supply.statement')} className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <h2 className="text-base font-semibold tracking-tight">{st('supply.statement')}</h2>
              <Field label={st('supply.colDate')} id="statement-to">
                <DatePicker
                  id="statement-to"
                  value={to}
                  size="sm"
                  className="w-44"
                  onValueChange={(value) => {
                    if (value !== '') setTo(value);
                  }}
                />
              </Field>
            </div>

            {statement.error !== null ? (
              <p role="alert" className="text-sm text-destructive">
                {statement.error instanceof ApiError
                  ? statement.error.message
                  : st('supply.errorDetail')}
              </p>
            ) : null}

            <dl className="grid overflow-hidden rounded-lg border border-border bg-card sm:grid-cols-3 sm:divide-x sm:divide-border">
              <Detail label={`${st('supply.opening')} · ${st('supply.colDue')}`} figure>
                <Money poisha={statement.data?.openingDuePoisha ?? '0'} align="start" compact />
              </Detail>
              <Detail label={`${st('supply.closing')} · ${st('supply.colDue')}`} figure>
                <Money poisha={statement.data?.closingDuePoisha ?? '0'} align="start" compact />
              </Detail>
              <Detail label={`${st('supply.closing')} · ${st('supply.colAdvance')}`} figure>
                <Money poisha={statement.data?.closingAdvancePoisha ?? '0'} align="start" compact />
              </Detail>
            </dl>

            {statementRows.length === 0 ? (
              <EmptyState icon={ScrollText} title={st('supply.empty')} />
            ) : (
              <TableFrame label={st('supply.statement')}>
                <table className="w-full border-separate border-spacing-0 text-sm">
                  <caption className="sr-only">{st('supply.statement')}</caption>
                  <thead>
                    <tr>
                      <th scope="col" className={TH}>
                        {st('supply.colDate')}
                      </th>
                      <th scope="col" className={TH}>
                        {st('supply.colSource')}
                      </th>
                      <th scope="col" className={TH}>
                        {st('supply.colAccount')}
                      </th>
                      <th scope="col" className={TH}>
                        {st('supply.colMemo')}
                      </th>
                      <th scope="col" className={TH_NUMERIC}>
                        {st('supply.colDebit')}
                      </th>
                      <th scope="col" className={TH_NUMERIC}>
                        {st('supply.colCredit')}
                      </th>
                      <th scope="col" className={TH_NUMERIC}>
                        {st('supply.colRunning')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {statementRows.map((line) => (
                      <tr key={`${line.journalId}-${line.lineNo}`} className={TR}>
                        <td className={`${TD} text-muted-foreground tabular-nums`}>
                          {line.businessDate}
                        </td>
                        <td className={TD}>{line.sourceType}</td>
                        <td className={TD}>{line.account}</td>
                        <td className={`${TD} text-muted-foreground`}>{line.memo ?? '—'}</td>
                        <td className={TD_NUMERIC}>
                          <Money poisha={line.debitPoisha} />
                        </td>
                        <td className={TD_NUMERIC}>
                          <Money poisha={line.creditPoisha} />
                        </td>
                        <td className={`${TD_NUMERIC} font-medium`}>
                          <Money poisha={line.runningDuePoisha} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            )}
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
  figure = false,
  children,
}: {
  readonly label: string;
  /** A balance: set larger, as the figure the card is about. */
  readonly figure?: boolean;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="space-y-1 px-5 py-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={figure ? 'text-xl font-medium tabular-nums' : 'text-sm tabular-nums'}>
        {children}
      </dd>
    </div>
  );
}
