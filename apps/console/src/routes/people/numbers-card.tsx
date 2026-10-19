import {
  Button,
  DateTime,
  Dialog,
  ErrorState,
  Input,
  Label,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Select,
  Skeleton,
  StatusBadge,
  cn,
  controlClassName,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { GitMerge, MoreHorizontal, Phone, Plus, Star } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { useAbility, useSession } from '../../auth/session.js';
import { customersPath } from '../customers/customers-nav.js';
import {
  getPerson,
  isSupervisor,
  mergePerson,
  nationalPhone,
  peopleOnNumber,
  PHONE_KINDS,
  PHONE_RELATIONS,
  RETIRE_REASONS,
  typedMobile,
  type CustomerPhoneView,
} from './api.js';
import { peopleKey, usePeopleT, type PeopleT } from './messages.js';
import { usePageActions, type PersonActions } from './person-actions.js';

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
  const actions = usePageActions(customerId);
  const mayUpdate = ability.can('update', 'Customer');
  const supervisor = isSupervisor(
    session.context?.roles ?? [],
    session.context?.isSuperAdmin ?? false,
  );
  const person = useQuery({
    queryKey: ['people', customerId],
    queryFn: () => getPerson(customerId),
  });

  if (person.isPending) return <Skeleton className="h-32 w-full rounded-xl" />;
  if (person.isError) {
    return <ErrorState title={t('people.numbers.failed')} detail={person.error.message} />;
  }
  const data = person.data;
  if (data.mergedIntoCustomerId !== null) {
    return (
      <section className="rounded-xl border border-border bg-card px-4 py-3 text-sm">
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
  return (
    <NumbersList
      customerId={customerId}
      phones={data.phones}
      actions={mayUpdate ? actions : null}
      allowMerge={mayUpdate && supervisor}
      variant="page"
    />
  );
}

/**
 * A person's numbers (M48; M49 D-890): the buyer page's card, and the inbox customer card's
 * compact list, where each number has its Call button and its actions sit in a menu. `actions`
 * null shows the numbers only.
 */
export function NumbersList({
  customerId,
  phones,
  actions,
  allowMerge = false,
  variant,
  call,
}: {
  readonly customerId: string;
  readonly phones: readonly CustomerPhoneView[];
  readonly actions: PersonActions | null;
  readonly allowMerge?: boolean;
  readonly variant: 'page' | 'panel';
  /** The inbox's Call button for a number, beside it. */
  readonly call?: (phone: CustomerPhoneView) => ReactNode;
}) {
  const t = usePeopleT();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<CustomerPhoneView | null>(null);
  const [retiring, setRetiring] = useState<CustomerPhoneView | null>(null);
  const [merging, setMerging] = useState(false);
  const active = phones.filter((phone) => phone.retired === null);
  const retired = phones.filter((phone) => phone.retired !== null);
  const panel = variant === 'panel';

  const rows =
    active.length === 0 ? (
      <p className={cn('text-sm text-muted-foreground', panel ? 'px-3 py-2' : 'px-4 py-3')}>
        {t('people.numbers.none')}
      </p>
    ) : (
      <ul className={panel ? 'space-y-1' : 'divide-y divide-border'}>
        {active.map((phone) => (
          <NumberRow
            key={phone.id}
            phone={phone}
            t={t}
            panel={panel}
            call={call?.(phone)}
            actions={
              actions === null ? null : (
                <RowActions
                  phone={phone}
                  actions={actions}
                  panel={panel}
                  canRetire={active.length > 1}
                  onEdit={() => setEditing(phone)}
                  onRetire={() => setRetiring(phone)}
                />
              )
            }
          />
        ))}
      </ul>
    );

  const retiredList =
    retired.length === 0 ? null : (
      <details className={cn('text-sm', panel ? 'px-1 pt-1' : 'border-t border-border px-4 py-3')}>
        <summary className="cursor-pointer text-xs text-muted-foreground focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          {t('people.numbers.retired', { count: retired.length })}
        </summary>
        <ul className="mt-2 space-y-2">
          {retired.map((phone) => (
            <li key={phone.id} className="text-xs text-muted-foreground">
              <span className="text-foreground tabular-nums">{nationalPhone(phone.phone)}</span>
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
    );

  const dialogs = (
    <>
      {adding && actions !== null ? (
        <AddNumber actions={actions} onClose={() => setAdding(false)} />
      ) : null}
      {editing === null || actions === null ? null : (
        <EditNumber actions={actions} phone={editing} onClose={() => setEditing(null)} />
      )}
      {retiring === null || actions === null ? null : (
        <RetireNumber actions={actions} phone={retiring} onClose={() => setRetiring(null)} />
      )}
      {merging ? (
        <MergeDialog
          keptId={customerId}
          keptPhones={active.map((phone) => phone.phone)}
          onClose={() => setMerging(false)}
        />
      ) : null}
    </>
  );

  if (panel) {
    return (
      <div className="space-y-1.5">
        {rows}
        {retiredList}
        {actions === null ? null : (
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground"
            onClick={() => setAdding(true)}
          >
            <Plus aria-hidden="true" />
            {t('people.numbers.add')}
          </Button>
        )}
        {dialogs}
      </div>
    );
  }

  return (
    <section
      aria-labelledby={`numbers-${customerId}`}
      className="overflow-hidden rounded-xl border border-border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 id={`numbers-${customerId}`} className="text-sm font-semibold">
          {t('people.numbers.title')}
        </h2>
        <div className="flex flex-wrap gap-2">
          {allowMerge ? (
            <Button variant="outline" size="sm" onClick={() => setMerging(true)}>
              <GitMerge aria-hidden="true" />
              {t('people.merge.button')}
            </Button>
          ) : null}
          {actions === null ? null : (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <Plus aria-hidden="true" />
              {t('people.numbers.add')}
            </Button>
          )}
        </div>
      </div>
      {rows}
      {retiredList}
      {dialogs}
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
  panel,
  call,
  actions,
}: {
  readonly phone: CustomerPhoneView;
  readonly t: PeopleT;
  readonly panel: boolean;
  readonly call: ReactNode;
  readonly actions: ReactNode;
}) {
  if (panel) {
    return (
      <li className="group motion-safe:duration-fast flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-accent motion-safe:transition-colors">
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
            phone.rank === 1 ? 'bg-primary-subtle text-primary' : 'bg-muted text-muted-foreground',
          )}
        >
          <Phone className="size-3.5" />
        </span>
        <div className="min-w-0 flex-1 space-y-0.5 text-sm">
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium tabular-nums">{nationalPhone(phone.phone)}</span>
            {phone.rank === 1 ? (
              <StatusBadge tone="info">{t('people.numbers.primary')}</StatusBadge>
            ) : null}
            {phone.needsDetails ? (
              <StatusBadge tone="warning">
                <span title={t('people.numbers.needsDetailsHint')}>
                  {t('people.numbers.needsDetails')}
                </span>
              </StatusBadge>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            {label(t, 'kind', phone.kind)} · {label(t, 'relation', phone.relation)}
          </p>
          {phone.note === null ? null : <p className="text-xs break-words">{phone.note}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          {call}
          {actions}
        </div>
      </li>
    );
  }
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
      <div className="min-w-0 space-y-1 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium tabular-nums">{nationalPhone(phone.phone)}</span>
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
            : t('people.numbers.addedBy', {
                name: phone.addedBy.name ?? t('people.numbers.colleague'),
              })}
          {' · '}
          <DateTime value={phone.addedAt} />
        </p>
      </div>
      <div className="flex items-center gap-1">
        {call}
        {actions}
      </div>
    </li>
  );
}

function RowActions({
  phone,
  actions,
  panel,
  canRetire,
  onEdit,
  onRetire,
}: {
  readonly phone: CustomerPhoneView;
  readonly actions: PersonActions;
  readonly panel: boolean;
  readonly canRetire: boolean;
  readonly onEdit: () => void;
  readonly onRetire: () => void;
}) {
  const t = usePeopleT();
  const primary = useMutation({ mutationFn: () => actions.updatePhone(phone.id, { rank: 1 }) });
  const error = primary.isError ? (
    <p role="alert" className="w-full text-xs text-destructive-text">
      {primary.error.message}
    </p>
  ) : null;

  if (panel) {
    return (
      <>
        <Menu>
          <MenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t('people.numbers.actions', { phone: nationalPhone(phone.phone) })}
            >
              <MoreHorizontal aria-hidden="true" />
            </Button>
          </MenuTrigger>
          <MenuContent align="end">
            {phone.rank === 1 ? null : (
              <MenuItem disabled={primary.isPending} onSelect={() => primary.mutate()}>
                <Star aria-hidden="true" className="size-4" />
                {t('people.numbers.makePrimary')}
              </MenuItem>
            )}
            <MenuItem onSelect={onEdit}>{t('people.numbers.edit')}</MenuItem>
            {canRetire ? (
              <MenuItem destructive onSelect={onRetire}>
                {t('people.numbers.retire')}
              </MenuItem>
            ) : null}
          </MenuContent>
        </Menu>
        {error}
      </>
    );
  }
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
      {error}
    </div>
  );
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

/** Add a number, with its kind, whose it is and the required note; `phone` prefills it. */
export function AddNumber({
  actions,
  onClose,
  phone: given = '',
}: {
  readonly actions: PersonActions;
  readonly onClose: () => void;
  readonly phone?: string;
}) {
  const t = usePeopleT();
  const id = useId();
  const [phone, setPhone] = useState(given);
  const [kind, setKind] = useState<string>('mobile');
  const [relation, setRelation] = useState<string>('own');
  const [note, setNote] = useState('');
  const mobile = typedMobile(phone);
  const save = useMutation({
    mutationFn: () =>
      actions.addPhone({
        phone: mobile ?? phone,
        kind: kind as (typeof PHONE_KINDS)[number],
        relation: relation as (typeof PHONE_RELATIONS)[number],
        note: note.trim(),
      }),
    onSuccess: onClose,
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
          <p role="alert" className="text-sm text-destructive-text">
            {save.error.message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function EditNumber({
  actions,
  phone,
  onClose,
}: {
  readonly actions: PersonActions;
  readonly phone: CustomerPhoneView;
  readonly onClose: () => void;
}) {
  const t = usePeopleT();
  const id = useId();
  const [kind, setKind] = useState<string>(phone.kind);
  const [relation, setRelation] = useState<string>(phone.relation);
  const [note, setNote] = useState(phone.note ?? '');
  const save = useMutation({
    mutationFn: () =>
      actions.updatePhone(phone.id, {
        kind: kind as (typeof PHONE_KINDS)[number],
        relation: relation as (typeof PHONE_RELATIONS)[number],
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: onClose,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('people.numbers.editTitle')}
      description={nationalPhone(phone.phone)}
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
          <p role="alert" className="text-sm text-destructive-text">
            {save.error.message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function RetireNumber({
  actions,
  phone,
  onClose,
}: {
  readonly actions: PersonActions;
  readonly phone: CustomerPhoneView;
  readonly onClose: () => void;
}) {
  const t = usePeopleT();
  const id = useId();
  const [reason, setReason] = useState<string>('changed_number');
  const [note, setNote] = useState('');
  const save = useMutation({
    mutationFn: () =>
      actions.retirePhone(phone.id, {
        reason: reason as (typeof RETIRE_REASONS)[number],
        ...(note.trim() === '' ? {} : { note: note.trim() }),
      }),
    onSuccess: onClose,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('people.numbers.retireTitle')}
      description={`${nationalPhone(phone.phone)}. ${t('people.numbers.retireDetail')}`}
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
          <p role="alert" className="text-sm text-destructive-text">
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
      void queryClient.invalidateQueries({ queryKey: ['people', keptId] });
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
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
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-2 text-sm"
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
            <p role="alert" className="text-sm text-destructive-text">
              {merge.error.message}
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
