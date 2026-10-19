import {
  Button,
  DateTime,
  Dialog,
  ErrorState,
  Input,
  Label,
  Select,
  Skeleton,
  StatusBadge,
  controlClassName,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { GitMerge, Plus, Star } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { useAbility, useSession } from '../../auth/session.js';
import { customersPath } from '../customers/customers-nav.js';
import {
  addPhone,
  getPerson,
  isSupervisor,
  mergePerson,
  peopleOnNumber,
  PHONE_KINDS,
  PHONE_RELATIONS,
  retirePhone,
  RETIRE_REASONS,
  typedMobile,
  updatePhone,
  type CustomerPhoneView,
} from './api.js';
import { peopleKey, usePeopleT, type PeopleT } from './messages.js';

/**
 * The buyer page's Numbers card (M48, D-870 to D-873): every number the person uses, ranked, with
 * its kind, whose it is, the staff's details and who added it; "Needs details" on one nobody has
 * written about yet. Add (with a required note), Make primary, Edit and Retire follow who may
 * update the buyer (`update Customer`; the server checks the buyer's reach). Retired numbers are
 * kept, collapsed. Supervisors also get Merge with… (D-884).
 */
export function NumbersCard({ customerId }: { readonly customerId: string }) {
  const t = usePeopleT();
  const ability = useAbility();
  const session = useSession();
  const mayUpdate = ability.can('update', 'Customer');
  const supervisor = isSupervisor(
    session.context?.roles ?? [],
    session.context?.isSuperAdmin ?? false,
  );
  const person = useQuery({
    queryKey: ['people', customerId],
    queryFn: () => getPerson(customerId),
  });
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CustomerPhoneView | null>(null);
  const [retiring, setRetiring] = useState<CustomerPhoneView | null>(null);
  const [merging, setMerging] = useState(false);

  if (person.isPending) return <Skeleton className="h-32 w-full" />;
  if (person.isError) {
    return <ErrorState title={t('people.numbers.failed')} detail={person.error.message} />;
  }
  const data = person.data;
  if (data.mergedIntoCustomerId !== null) {
    return (
      <section className="rounded-lg border border-border bg-card px-4 py-3 text-sm">
        <p>{t('people.merge.mergedInto')}</p>
        <Link
          to={customersPath(`/customers/${data.mergedIntoCustomerId}`)}
          className="mt-1 inline-block font-medium text-primary underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {t('people.merge.open')}
        </Link>
      </section>
    );
  }
  const active = data.phones.filter((phone) => phone.retired === null);
  const retired = data.phones.filter((phone) => phone.retired !== null);

  return (
    <section
      aria-labelledby={`numbers-${customerId}`}
      className="overflow-hidden rounded-lg border border-border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id={`numbers-${customerId}`} className="text-sm font-semibold">
          {t('people.numbers.title')}
        </h2>
        <div className="flex flex-wrap gap-2">
          {mayUpdate && supervisor ? (
            <Button variant="outline" size="sm" onClick={() => setMerging(true)}>
              <GitMerge aria-hidden="true" />
              {t('people.merge.button')}
            </Button>
          ) : null}
          {mayUpdate ? (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" />
              {t('people.numbers.add')}
            </Button>
          ) : null}
        </div>
      </div>
      {active.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('people.numbers.none')}</p>
      ) : (
        <ul className="divide-y divide-border">
          {active.map((phone) => (
            <NumberRow
              key={phone.id}
              phone={phone}
              t={t}
              actions={
                mayUpdate ? (
                  <RowActions
                    customerId={customerId}
                    phone={phone}
                    canRetire={active.length > 1}
                    onEdit={() => setEditing(phone)}
                    onRetire={() => setRetiring(phone)}
                  />
                ) : null
              }
            />
          ))}
        </ul>
      )}
      {retired.length === 0 ? null : (
        <details className="border-t border-border px-4 py-3 text-sm">
          <summary className="cursor-pointer text-muted-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
            {t('people.numbers.retired', { count: retired.length })}
          </summary>
          <ul className="mt-2 space-y-2">
            {retired.map((phone) => (
              <li key={phone.id} className="text-muted-foreground">
                <span className="text-foreground tabular-nums">{phone.phone}</span>
                {' · '}
                {label(t, 'retire', phone.retired?.reason ?? 'other')}
                {phone.retired?.note ? ` · ${phone.retired.note}` : ''}
                {' · '}
                {t('people.numbers.retiredOn')}{' '}
                <DateTime value={phone.retired?.at ?? phone.addedAt} dateOnly />
              </li>
            ))}
          </ul>
        </details>
      )}
      {adding ? <AddNumber customerId={customerId} onClose={() => setAdding(false)} /> : null}
      {editing === null ? null : (
        <EditNumber customerId={customerId} phone={editing} onClose={() => setEditing(null)} />
      )}
      {retiring === null ? null : (
        <RetireNumber customerId={customerId} phone={retiring} onClose={() => setRetiring(null)} />
      )}
      {merging ? (
        <MergeDialog
          keptId={customerId}
          keptPhones={active.map((phone) => phone.phone)}
          onClose={() => setMerging(false)}
        />
      ) : null}
    </section>
  );
}

function label(t: PeopleT, prefix: string, value: string): string {
  const key = peopleKey(prefix, value);
  return key === null ? value : t(key);
}

function NumberRow({
  phone,
  t,
  actions,
}: {
  readonly phone: CustomerPhoneView;
  readonly t: PeopleT;
  readonly actions: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 space-y-1 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium tabular-nums">{phone.phone}</span>
          {phone.rank === 1 ? (
            <StatusBadge tone="info">{t('people.numbers.primary')}</StatusBadge>
          ) : (
            <span className="text-xs text-muted-foreground">
              {t('people.numbers.rank', { rank: phone.rank })}
            </span>
          )}
          <span className="text-xs text-muted-foreground">
            {label(t, 'kind', phone.kind)} · {label(t, 'relation', phone.relation)}
          </span>
          {phone.needsDetails ? (
            <StatusBadge tone="warning">
              <span title={t('people.numbers.needsDetailsHint')}>
                {t('people.numbers.needsDetails')}
              </span>
            </StatusBadge>
          ) : null}
        </p>
        {phone.note === null ? null : <p className="break-words">{phone.note}</p>}
        <p className="text-xs text-muted-foreground">
          {phone.addedBy === null
            ? `${t('people.numbers.addedBySystem')} (${label(t, 'source', phone.source)})`
            : t('people.numbers.addedBy', { name: phone.addedBy.name ?? phone.addedBy.id })}
          {' · '}
          <DateTime value={phone.addedAt} />
        </p>
      </div>
      {actions}
    </li>
  );
}

function RowActions({
  customerId,
  phone,
  canRetire,
  onEdit,
  onRetire,
}: {
  readonly customerId: string;
  readonly phone: CustomerPhoneView;
  readonly canRetire: boolean;
  readonly onEdit: () => void;
  readonly onRetire: () => void;
}) {
  const t = usePeopleT();
  const queryClient = useQueryClient();
  const primary = useMutation({
    mutationFn: () => updatePhone(customerId, phone.id, { rank: 1 }),
    onSuccess: () => invalidate(queryClient, customerId),
  });
  return (
    <div className="flex flex-wrap gap-1">
      {phone.rank === 1 ? null : (
        <Button
          variant="ghost"
          size="sm"
          disabled={primary.isPending}
          onClick={() => primary.mutate()}
        >
          <Star aria-hidden="true" />
          {t('people.numbers.makePrimary')}
        </Button>
      )}
      <Button variant="ghost" size="sm" onClick={onEdit}>
        {t('people.numbers.edit')}
      </Button>
      {canRetire ? (
        <Button variant="ghost" size="sm" onClick={onRetire}>
          {t('people.numbers.retire')}
        </Button>
      ) : null}
      {primary.isError ? (
        <p role="alert" className="w-full text-xs text-destructive">
          {primary.error.message}
        </p>
      ) : null}
    </div>
  );
}

function invalidate(queryClient: ReturnType<typeof useQueryClient>, customerId: string) {
  void queryClient.invalidateQueries({ queryKey: ['people', customerId] });
  void queryClient.invalidateQueries({ queryKey: ['customers'] });
}

function options(t: PeopleT, prefix: string, values: readonly string[]) {
  return values.map((value) => ({ value, label: label(t, prefix, value) }));
}

function NoteField({
  id,
  value,
  onChange,
  required,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly required: boolean;
}) {
  const t = usePeopleT();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} required={required}>
        {t('people.numbers.note')}
      </Label>
      <textarea
        id={id}
        value={value}
        rows={3}
        maxLength={500}
        required={required}
        aria-describedby={`${id}-hint`}
        className={`${controlClassName} h-auto min-h-16 w-full py-2`}
        onChange={(event) => onChange(event.target.value)}
      />
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {t('people.numbers.noteHint')}
      </p>
    </div>
  );
}

function AddNumber({
  customerId,
  onClose,
}: {
  readonly customerId: string;
  readonly onClose: () => void;
}) {
  const t = usePeopleT();
  const id = useId();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState('');
  const [kind, setKind] = useState<string>('mobile');
  const [relation, setRelation] = useState<string>('own');
  const [note, setNote] = useState('');
  const mobile = typedMobile(phone);
  const save = useMutation({
    mutationFn: () =>
      addPhone(customerId, {
        phone: mobile ?? phone,
        kind: kind as (typeof PHONE_KINDS)[number],
        relation: relation as (typeof PHONE_RELATIONS)[number],
        note: note.trim(),
      }),
    onSuccess: () => {
      invalidate(queryClient, customerId);
      onClose();
    },
  });
  const ready = mobile !== null && note.trim() !== '';
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('people.numbers.addTitle')}
      closeLabel={t('people.numbers.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('people.numbers.cancel')}
          </Button>
          <Button disabled={!ready || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('people.numbers.saving') : t('people.numbers.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-phone`} required>
            {t('people.numbers.phone')}
          </Label>
          <Input
            id={`${id}-phone`}
            type="tel"
            inputMode="tel"
            value={phone}
            className="tabular-nums"
            onChange={(event) => setPhone(event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-kind`}>{t('people.numbers.kind')}</Label>
            <Select
              id={`${id}-kind`}
              value={kind}
              options={options(t, 'kind', PHONE_KINDS)}
              onValueChange={setKind}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-relation`}>{t('people.numbers.relation')}</Label>
            <Select
              id={`${id}-relation`}
              value={relation}
              options={options(t, 'relation', PHONE_RELATIONS)}
              onValueChange={setRelation}
            />
          </div>
        </div>
        <NoteField id={`${id}-note`} value={note} onChange={setNote} required />
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function EditNumber({
  customerId,
  phone,
  onClose,
}: {
  readonly customerId: string;
  readonly phone: CustomerPhoneView;
  readonly onClose: () => void;
}) {
  const t = usePeopleT();
  const id = useId();
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<string>(phone.kind);
  const [relation, setRelation] = useState<string>(phone.relation);
  const [note, setNote] = useState(phone.note ?? '');
  const save = useMutation({
    mutationFn: () =>
      updatePhone(customerId, phone.id, {
        kind: kind as (typeof PHONE_KINDS)[number],
        relation: relation as (typeof PHONE_RELATIONS)[number],
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: () => {
      invalidate(queryClient, customerId);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('people.numbers.editTitle')}
      description={phone.phone}
      closeLabel={t('people.numbers.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('people.numbers.cancel')}
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('people.numbers.saving') : t('people.numbers.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-kind`}>{t('people.numbers.kind')}</Label>
            <Select
              id={`${id}-kind`}
              value={kind}
              options={options(t, 'kind', PHONE_KINDS)}
              onValueChange={setKind}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-relation`}>{t('people.numbers.relation')}</Label>
            <Select
              id={`${id}-relation`}
              value={relation}
              options={options(t, 'relation', PHONE_RELATIONS)}
              onValueChange={setRelation}
            />
          </div>
        </div>
        <NoteField id={`${id}-note`} value={note} onChange={setNote} required={false} />
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function RetireNumber({
  customerId,
  phone,
  onClose,
}: {
  readonly customerId: string;
  readonly phone: CustomerPhoneView;
  readonly onClose: () => void;
}) {
  const t = usePeopleT();
  const id = useId();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState<string>('changed_number');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () =>
      retirePhone(customerId, phone.id, {
        reason: reason as (typeof RETIRE_REASONS)[number],
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: () => {
      invalidate(queryClient, customerId);
      onClose();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('people.numbers.retireTitle')}
      description={`${phone.phone}. ${t('people.numbers.retireDetail')}`}
      closeLabel={t('people.numbers.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('people.numbers.cancel')}
          </Button>
          <Button variant="destructive" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('people.numbers.saving') : t('people.numbers.retire')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-reason`}>{t('people.numbers.reason')}</Label>
          <Select
            id={`${id}-reason`}
            value={reason}
            options={options(t, 'retire', RETIRE_REASONS)}
            onValueChange={setReason}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-note`}>{t('people.numbers.retireNote')}</Label>
          <Input
            id={`${id}-note`}
            value={note}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
          />
        </div>
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {save.error.message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Merge with… (D-884): find the other record by a phone, pick it, say why. Supervisors only. */
function MergeDialog({
  keptId,
  keptPhones,
  onClose,
}: {
  readonly keptId: string;
  readonly keptPhones: readonly string[];
  readonly onClose: () => void;
}) {
  const t = usePeopleT();
  const id = useId();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState(keptPhones[0] ?? '');
  const [otherId, setOtherId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const mobile = typedMobile(phone);
  const found = useQuery({
    queryKey: ['people', 'on-number', mobile],
    queryFn: () => peopleOnNumber(mobile ?? ''),
    enabled: mobile !== null,
  });
  const others = (found.data?.candidates ?? []).filter((person) => person.customerId !== keptId);
  const merge = useMutation({
    mutationFn: () => mergePerson(keptId, otherId ?? '', reason.trim()),
    onSuccess: (result) => {
      invalidate(queryClient, keptId);
      setDone(t('people.merge.done', { orders: result.ordersMoved }));
    },
  });
  const ready = otherId !== null && reason.trim().length >= 3;
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('people.merge.title')}
      description={t('people.merge.detail')}
      closeLabel={t('people.numbers.close')}
      footer={
        done === null ? (
          <>
            <Button variant="outline" onClick={onClose}>
              {t('people.numbers.cancel')}
            </Button>
            <Button disabled={!ready || merge.isPending} onClick={() => merge.mutate()}>
              {merge.isPending ? t('people.numbers.saving') : t('people.merge.confirm')}
            </Button>
          </>
        ) : (
          <Button onClick={onClose}>{t('people.numbers.close')}</Button>
        )
      }
    >
      {done !== null ? (
        <p role="status" className="text-sm">
          {done}
        </p>
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-phone`}>{t('people.merge.find')}</Label>
            <Input
              id={`${id}-phone`}
              type="tel"
              inputMode="tel"
              value={phone}
              className="tabular-nums"
              onChange={(event) => {
                setPhone(event.target.value);
                setOtherId(null);
              }}
            />
          </div>
          {mobile === null ? null : others.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {found.isPending ? t('people.numbers.saving') : t('people.merge.noneFound')}
            </p>
          ) : (
            <fieldset className="space-y-2">
              <legend className="text-sm font-medium">{t('people.merge.pick')}</legend>
              {others.map((person) => (
                <label
                  key={person.customerId}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-sm"
                >
                  <input
                    type="radio"
                    name={`${id}-other`}
                    value={person.customerId}
                    checked={otherId === person.customerId}
                    onChange={() => setOtherId(person.customerId)}
                    className="mt-1 focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <span>
                    <span className="block font-medium">{person.name}</span>
                    <span className="block text-xs text-muted-foreground">
                      {label(t, 'relation', person.relation)}
                      {person.note === null ? '' : ` · ${person.note}`}
                      {' · '}
                      {t('people.chooser.orders', { count: person.orders })}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-reason`} required>
              {t('people.merge.reason')}
            </Label>
            <Input
              id={`${id}-reason`}
              value={reason}
              maxLength={500}
              onChange={(event) => setReason(event.target.value)}
            />
          </div>
          {merge.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {merge.error.message}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
