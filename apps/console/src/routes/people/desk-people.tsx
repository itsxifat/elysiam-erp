import { Checkbox, DateTime, Input, Label, Select, StatusBadge } from '@elysium/ui';
import type { ReactNode } from 'react';

import { PHONE_RELATIONS, typedMobile, type BuyerCandidateView } from './api.js';
import { peopleKey, usePeopleT } from './messages.js';

/**
 * The desk's two M48 parts (D-875, D-878 to D-881): who on a shared number is ordering, and an
 * order for someone else. Both are plain controlled components; the desk (and the inbox's order
 * form) owns the state and builds the request from it with `buyerFields` and `behalfFields`.
 */

export type BuyerChoice =
  /** Nobody chosen: the server picks (the primary own number's person, else the last to order) and flags a shared number. */
  | { readonly kind: 'auto' }
  | { readonly kind: 'person'; readonly customerId: string }
  | { readonly kind: 'new'; readonly relation: string; readonly note: string };

export const AUTO: BuyerChoice = { kind: 'auto' };

/** The create body's buyer part for a choice: an id, a new person, or the phone alone. */
export function buyerFields(
  choice: BuyerChoice,
  phone: string,
  name: string,
):
  | { readonly customerId: string }
  | {
      readonly customer: {
        readonly phone: string;
        readonly name: string;
        readonly newPerson?: true;
        readonly phoneRelation?: (typeof PHONE_RELATIONS)[number];
        readonly phoneNote?: string;
      };
    } {
  if (choice.kind === 'person') return { customerId: choice.customerId };
  if (choice.kind === 'new') {
    return {
      customer: {
        phone,
        name,
        newPerson: true,
        phoneRelation: choice.relation as (typeof PHONE_RELATIONS)[number],
        ...(choice.note.trim() === '' ? {} : { phoneNote: choice.note.trim() }),
      },
    };
  }
  return { customer: { phone, name } };
}

export function BuyerChooser({
  idBase,
  candidates,
  value,
  onChange,
}: {
  readonly idBase: string;
  readonly candidates: readonly BuyerCandidateView[];
  readonly value: BuyerChoice;
  readonly onChange: (choice: BuyerChoice) => void;
}) {
  const t = usePeopleT();
  if (candidates.length === 0) return null;
  const single = candidates.length === 1 ? candidates[0] : undefined;
  const radio = (checked: boolean, select: () => void, children: ReactNode, key: string) => (
    <label
      key={key}
      className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-2 text-sm has-[:checked]:border-primary"
    >
      <input
        type="radio"
        name={`${idBase}-buyer`}
        checked={checked}
        onChange={select}
        className="mt-1 focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="min-w-0">{children}</span>
    </label>
  );
  const relationOf = (relation: string) => {
    const key = peopleKey('relation', relation);
    return key === null ? relation : t(key);
  };
  return (
    <fieldset className="space-y-2 sm:col-span-2">
      <legend className="text-sm font-medium">
        {single === undefined
          ? t('people.chooser.many', { count: candidates.length })
          : t('people.chooser.one', { name: single.name })}
      </legend>
      {candidates.map((person) =>
        radio(
          single !== undefined
            ? value.kind === 'auto' ||
                (value.kind === 'person' && value.customerId === person.customerId)
            : value.kind === 'person' && value.customerId === person.customerId,
          () => onChange({ kind: 'person', customerId: person.customerId }),
          <>
            <span className="flex flex-wrap items-center gap-2 font-medium">
              {person.name}
              {person.suggested && single === undefined ? (
                <StatusBadge tone="info">{t('people.chooser.suggested')}</StatusBadge>
              ) : null}
            </span>
            <span className="block text-xs text-muted-foreground">
              {relationOf(person.relation)}
              {person.rank === 1 ? ` · ${t('people.numbers.primary')}` : ''}
              {person.note === null ? '' : ` · ${person.note}`}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t('people.chooser.orders', { count: person.orders })} ·{' '}
              {person.lastOrderAt === null ? (
                t('people.chooser.noOrders')
              ) : (
                <>
                  {t('people.chooser.lastOrder')} <DateTime value={person.lastOrderAt} dateOnly />
                </>
              )}
            </span>
          </>,
          person.customerId,
        ),
      )}
      {radio(
        value.kind === 'new',
        () => onChange({ kind: 'new', relation: 'household', note: '' }),
        t('people.chooser.newPerson'),
        'new',
      )}
      {value.kind === 'new' ? (
        <div className="grid gap-3 pl-6 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${idBase}-new-relation`}>{t('people.chooser.newRelation')}</Label>
            <Select
              id={`${idBase}-new-relation`}
              value={value.relation}
              options={PHONE_RELATIONS.map((relation) => ({
                value: relation,
                label: relationOf(relation),
              }))}
              onValueChange={(relation) => onChange({ ...value, relation })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idBase}-new-note`}>{t('people.chooser.newNote')}</Label>
            <Input
              id={`${idBase}-new-note`}
              value={value.note}
              maxLength={500}
              onChange={(event) => onChange({ ...value, note: event.target.value })}
            />
          </div>
        </div>
      ) : null}
      {single === undefined
        ? radio(value.kind === 'auto', () => onChange(AUTO), t('people.chooser.auto'), 'auto')
        : null}
    </fieldset>
  );
}

/** "For someone else" (D-878): the recipient's name and phone, a note, and two ticks. */
export interface Behalf {
  readonly on: boolean;
  readonly name: string;
  readonly phone: string;
  readonly note: string;
  readonly save: boolean;
  readonly addNumber: boolean;
}

export const NO_BEHALF: Behalf = {
  on: false,
  name: '',
  phone: '',
  note: '',
  save: false,
  addNumber: false,
};

/** Whether the someone-else part is complete enough to send (or not on at all). */
export function behalfReady(behalf: Behalf): boolean {
  return !behalf.on || (behalf.name.trim() !== '' && typedMobile(behalf.phone) !== null);
}

/** The create body's someone-else part, merged over the ship-to the desk already builds. */
export function behalfFields(behalf: Behalf): {
  readonly placedFor: 'someone_else';
  readonly recipient: { readonly name: string; readonly phone: string };
  readonly placedForNote?: string;
  readonly saveRecipient?: true;
  readonly addRecipientNumberToBuyer?: true;
} | null {
  const phone = typedMobile(behalf.phone);
  if (!behalf.on || phone === null || behalf.name.trim() === '') return null;
  return {
    placedFor: 'someone_else',
    recipient: { name: behalf.name.trim(), phone },
    ...(behalf.note.trim() === '' ? {} : { placedForNote: behalf.note.trim() }),
    ...(behalf.save ? { saveRecipient: true as const } : {}),
    ...(behalf.addNumber ? { addRecipientNumberToBuyer: true as const } : {}),
  };
}

export function ForSomeoneElse({
  idBase,
  value,
  onChange,
  attempted,
}: {
  readonly idBase: string;
  readonly value: Behalf;
  readonly onChange: (behalf: Behalf) => void;
  readonly attempted: boolean;
}) {
  const t = usePeopleT();
  const invalid = attempted && !behalfReady(value);
  return (
    <div className="space-y-3 sm:col-span-2">
      <label className="flex items-center gap-2 text-sm font-medium">
        <Checkbox
          checked={value.on}
          onCheckedChange={(checked) => onChange({ ...value, on: checked === true })}
        />
        {t('people.behalf.toggle')}
      </label>
      {value.on ? (
        <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-2">
          <p className="text-xs text-muted-foreground sm:col-span-2">{t('people.behalf.hint')}</p>
          <div className="space-y-1.5">
            <Label htmlFor={`${idBase}-recipient-name`} required>
              {t('people.behalf.name')}
            </Label>
            <Input
              id={`${idBase}-recipient-name`}
              value={value.name}
              autoComplete="off"
              aria-invalid={invalid && value.name.trim() === ''}
              onChange={(event) => onChange({ ...value, name: event.target.value })}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${idBase}-recipient-phone`} required>
              {t('people.behalf.phone')}
            </Label>
            <Input
              id={`${idBase}-recipient-phone`}
              type="tel"
              inputMode="tel"
              value={value.phone}
              autoComplete="off"
              className="tabular-nums"
              aria-invalid={invalid && typedMobile(value.phone) === null}
              onChange={(event) => onChange({ ...value, phone: event.target.value })}
            />
          </div>
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor={`${idBase}-recipient-note`}>{t('people.behalf.note')}</Label>
            <Input
              id={`${idBase}-recipient-note`}
              value={value.note}
              maxLength={500}
              placeholder={t('people.behalf.notePlaceholder')}
              onChange={(event) => onChange({ ...value, note: event.target.value })}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={value.save}
              onCheckedChange={(checked) => onChange({ ...value, save: checked === true })}
            />
            {t('people.behalf.save')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={value.addNumber}
              onCheckedChange={(checked) => onChange({ ...value, addNumber: checked === true })}
            />
            {t('people.behalf.addNumber')}
          </label>
          {invalid ? (
            <p role="alert" className="text-sm text-destructive sm:col-span-2">
              {t('people.behalf.missing')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
