import type {
  CustomerAddressInput,
  CustomerAddressView,
  CustomerDetailsInput,
  CustomerGender,
} from '@elysium/contracts/customers';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Dialog,
  Input,
  Label,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  Select,
  StatusBadge,
  cn,
  controlClassName,
} from '@elysium/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { MapPin, MoreHorizontal, Star } from 'lucide-react';
import { useId, useMemo, useState, type ReactNode } from 'react';

import { DatePicker } from '../../ui/date-picker.js';
import { listAreas } from '../orders/api.js';
import { GENDERS } from './api.js';
import { usePeopleT } from './messages.js';
import type { PersonActions } from './person-actions.js';

/**
 * A buyer's details and address book (M49, D-891 to D-894), shared by the buyer page and the
 * inbox's customer card: the same fields, the same forms, the same rules; only the frame and the
 * routes (`PersonActions`) differ.
 */

/** What the details need of a buyer: the buyer page's person and the inbox's card both have it. */
export interface PersonDetails {
  readonly name: string;
  readonly email: string | null;
  readonly gender: string | null;
  readonly ageBand: string | null;
  readonly profession: string | null;
  readonly birthday: string | null;
  readonly anniversary: string | null;
  readonly tags: readonly string[];
  readonly notes: string | null;
}

/** A birthday or an anniversary can be decades back: the calendar lists the years. */
const OCCASION_YEARS = { from: 1930, to: new Date().getUTCFullYear() } as const;

function genderLabel(t: ReturnType<typeof usePeopleT>, value: string | null): string | null {
  if (value === 'female') return t('people.details.gender.female');
  if (value === 'male') return t('people.details.gender.male');
  if (value === 'other') return t('people.details.gender.other');
  return null;
}

/** "12 Mar" for a stored `YYYY-MM-DD`, the year left out on purpose (a birthday's age is theirs). */
function dayMonth(value: string | null): string | null {
  if (value === null) return null;
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return value;
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, day)));
}

/** The details that are set, as label and value rows; a short hint when none is. */
export function DetailsList({
  person,
  compact = false,
  withDates = true,
}: {
  readonly person: PersonDetails;
  readonly compact?: boolean;
  /** The buyer page shows the dates in its Occasions panel instead. */
  readonly withDates?: boolean;
}) {
  const t = usePeopleT();
  const rows: [string, ReactNode][] = [];
  if (person.email !== null) {
    rows.push([
      t('people.details.email'),
      <a
        key="email"
        href={`mailto:${person.email}`}
        className="break-all text-foreground underline-offset-4 hover:underline focus-visible:rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {person.email}
      </a>,
    ]);
  }
  const gender = genderLabel(t, person.gender);
  if (gender !== null) rows.push([t('people.details.genderLabel'), gender]);
  if (person.ageBand !== null) rows.push([t('people.details.ageBand'), person.ageBand]);
  if (person.profession !== null) rows.push([t('people.details.profession'), person.profession]);
  const birthday = withDates ? dayMonth(person.birthday) : null;
  if (birthday !== null) rows.push([t('people.details.birthday'), birthday]);
  const anniversary = withDates ? dayMonth(person.anniversary) : null;
  if (anniversary !== null) rows.push([t('people.details.anniversary'), anniversary]);

  return (
    <div className="space-y-2.5">
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('people.details.none')}</p>
      ) : (
        <dl className={compact ? 'space-y-1.5 text-sm' : 'grid gap-2 text-sm sm:grid-cols-2'}>
          {rows.map(([name, value]) =>
            compact ? (
              <div key={name} className="flex gap-3">
                <dt className="w-24 shrink-0 truncate text-muted-foreground">{name}</dt>
                <dd className="min-w-0 break-words">{value}</dd>
              </div>
            ) : (
              <div key={name} className="flex justify-between gap-3">
                <dt className="text-muted-foreground">{name}</dt>
                <dd className="min-w-0 text-right break-words">{value}</dd>
              </div>
            ),
          )}
        </dl>
      )}
      {person.tags.length === 0 ? null : (
        <ul className="flex flex-wrap gap-1" aria-label={t('people.details.tags')}>
          {person.tags.map((tag) => (
            <li
              key={tag}
              className="rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              {tag}
            </li>
          ))}
        </ul>
      )}
      {person.notes === null ? null : (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm break-words whitespace-pre-wrap">
          {person.notes}
        </p>
      )}
    </div>
  );
}

/** A typed value: trimmed, and empty as `null` (the server clears it). */
function typed(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Edit the buyer's details (D-891): only what changed is sent; an emptied field is cleared, not
 * kept. The number is not here: numbers have their own card (M48).
 */
export function DetailsDialog({
  person,
  actions,
  onClose,
}: {
  readonly person: PersonDetails;
  readonly actions: PersonActions;
  readonly onClose: () => void;
}) {
  const t = usePeopleT();
  const id = useId();
  const [name, setName] = useState(person.name);
  const [email, setEmail] = useState(person.email ?? '');
  const [gender, setGender] = useState(person.gender ?? '');
  const [ageBand, setAgeBand] = useState(person.ageBand ?? '');
  const [profession, setProfession] = useState(person.profession ?? '');
  const [birthday, setBirthday] = useState(person.birthday ?? '');
  const [anniversary, setAnniversary] = useState(person.anniversary ?? '');
  const [tags, setTags] = useState(person.tags.join(', '));
  const [notes, setNotes] = useState(person.notes ?? '');

  const patch = useMemo(() => {
    const next: CustomerDetailsInput = {};
    const changed = <K extends keyof CustomerDetailsInput>(
      key: K,
      value: CustomerDetailsInput[K],
      before: unknown,
    ) => {
      if (value !== before) Object.assign(next, { [key]: value });
    };
    if (name.trim() !== '' && name.trim() !== person.name) next.name = name.trim();
    changed('email', typed(email)?.toLowerCase() ?? null, person.email);
    changed('gender', gender === '' ? null : (gender as CustomerGender), person.gender);
    changed('ageBand', typed(ageBand), person.ageBand);
    changed('profession', typed(profession), person.profession);
    changed('birthday', birthday === '' ? null : birthday, person.birthday);
    changed('anniversary', anniversary === '' ? null : anniversary, person.anniversary);
    const tagList = [
      ...new Set(
        tags
          .split(',')
          .map((tag) => tag.trim())
          .filter((tag) => tag !== ''),
      ),
    ].slice(0, 20);
    if (tagList.join('\n') !== person.tags.join('\n')) next.tags = tagList;
    changed('notes', typed(notes), person.notes);
    return next;
  }, [name, email, gender, ageBand, profession, birthday, anniversary, tags, notes, person]);

  const save = useMutation({ mutationFn: () => actions.updateDetails(patch), onSuccess: onClose });
  const emailBad = typed(email) !== null && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const ready = name.trim() !== '' && !emailBad && Object.keys(patch).length > 0;

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={t('people.details.editTitle')}
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
          <Label htmlFor={`${id}-name`} required>
            {t('people.details.name')}
          </Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={200}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-email`}>{t('people.details.email')}</Label>
          <Input
            id={`${id}-email`}
            type="email"
            inputMode="email"
            autoComplete="off"
            value={email}
            maxLength={254}
            aria-invalid={emailBad}
            aria-describedby={emailBad ? `${id}-email-error` : undefined}
            onChange={(event) => setEmail(event.target.value)}
          />
          {emailBad ? (
            <p id={`${id}-email-error`} className="text-xs text-destructive-text">
              {t('people.details.emailInvalid')}
            </p>
          ) : null}
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-gender`}>{t('people.details.genderLabel')}</Label>
            <Select
              id={`${id}-gender`}
              value={gender}
              onValueChange={setGender}
              options={[
                { value: '', label: t('people.details.notSet') },
                ...GENDERS.map((value) => ({
                  value,
                  label: genderLabel(t, value) ?? value,
                })),
              ]}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-age`}>{t('people.details.ageBand')}</Label>
            <Input
              id={`${id}-age`}
              value={ageBand}
              maxLength={40}
              placeholder={t('people.details.ageBandHint')}
              onChange={(event) => setAgeBand(event.target.value)}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-profession`}>{t('people.details.profession')}</Label>
          <Input
            id={`${id}-profession`}
            value={profession}
            maxLength={120}
            onChange={(event) => setProfession(event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-birthday`}>{t('people.details.birthday')}</Label>
            <DatePicker
              id={`${id}-birthday`}
              value={birthday}
              clearable
              years={OCCASION_YEARS}
              onValueChange={setBirthday}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-anniversary`}>{t('people.details.anniversary')}</Label>
            <DatePicker
              id={`${id}-anniversary`}
              value={anniversary}
              clearable
              years={OCCASION_YEARS}
              onValueChange={setAnniversary}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-tags`}>{t('people.details.tags')}</Label>
          <Input
            id={`${id}-tags`}
            value={tags}
            placeholder={t('people.details.tagsHint')}
            onChange={(event) => setTags(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-notes`}>{t('people.details.notes')}</Label>
          <textarea
            id={`${id}-notes`}
            value={notes}
            rows={3}
            maxLength={2000}
            placeholder={t('people.details.notesHint')}
            className={`${controlClassName} h-auto min-h-16 w-full py-2`}
            onChange={(event) => setNotes(event.target.value)}
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

/** One line for an address: house and road, then area, thana and district. */
export function addressText(address: {
  readonly addressLine: string;
  readonly area: string | null;
  readonly thanaName: string | null;
  readonly districtName: string | null;
}): string {
  return [address.addressLine, address.area, address.thanaName, address.districtName]
    .filter((part): part is string => part !== null && part.trim() !== '')
    .join(', ');
}

/** The address book: each saved address, the default marked, with Make default, Edit, Remove. */
export function AddressList({
  addresses,
  actions,
  compact = false,
}: {
  readonly addresses: readonly CustomerAddressView[];
  readonly actions: PersonActions | null;
  readonly compact?: boolean;
}) {
  const t = usePeopleT();
  const [editing, setEditing] = useState<CustomerAddressView | null>(null);
  const [removing, setRemoving] = useState<CustomerAddressView | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const makeDefault = useMutation({
    mutationFn: (address: CustomerAddressView) =>
      actions === null
        ? Promise.resolve()
        : actions.replaceAddress(address.id, inputOf(address, true)),
    onError: (error) => setFailed(error.message),
  });

  if (addresses.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('people.addresses.none')}</p>;
  }
  return (
    <>
      <ul className={compact ? 'space-y-1' : 'divide-y divide-border'}>
        {addresses.map((address) => (
          <li
            key={address.id}
            className={cn(
              'flex items-start gap-2.5',
              compact ? 'rounded-lg px-2 py-2 hover:bg-accent' : 'px-4 py-3',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full',
                address.isDefault
                  ? 'bg-primary-subtle text-primary'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              <MapPin className="size-3.5" />
            </span>
            <div className="min-w-0 flex-1 space-y-0.5 text-sm">
              <p className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">
                  {address.label ?? address.thanaName ?? t('people.addresses.address')}
                </span>
                {address.isDefault ? (
                  <StatusBadge tone="info">{t('people.addresses.default')}</StatusBadge>
                ) : null}
              </p>
              <p className="text-xs break-words text-muted-foreground">{addressText(address)}</p>
            </div>
            {actions === null ? null : (
              <Menu>
                <MenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('people.addresses.actions', { address: addressText(address) })}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </Button>
                </MenuTrigger>
                <MenuContent align="end">
                  {address.isDefault ? null : (
                    <MenuItem
                      disabled={makeDefault.isPending}
                      onSelect={() => {
                        setFailed(null);
                        makeDefault.mutate(address);
                      }}
                    >
                      <Star aria-hidden="true" className="size-4" />
                      {t('people.addresses.makeDefault')}
                    </MenuItem>
                  )}
                  <MenuItem onSelect={() => setEditing(address)}>
                    {t('people.addresses.edit')}
                  </MenuItem>
                  <MenuItem destructive onSelect={() => setRemoving(address)}>
                    {t('people.addresses.remove')}
                  </MenuItem>
                </MenuContent>
              </Menu>
            )}
          </li>
        ))}
      </ul>
      {failed === null ? null : (
        <p role="alert" className="text-xs text-destructive-text">
          {failed}
        </p>
      )}
      {editing === null || actions === null ? null : (
        <AddressDialog actions={actions} address={editing} onClose={() => setEditing(null)} />
      )}
      {actions === null ? null : (
        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(open) => (open ? undefined : setRemoving(null))}
          title={t('people.addresses.removeTitle')}
          description={removing === null ? '' : addressText(removing)}
          confirmLabel={t('people.addresses.remove')}
          cancelLabel={t('people.numbers.cancel')}
          closeLabel={t('people.numbers.close')}
          destructive
          onConfirm={async () => {
            if (removing === null) return;
            setFailed(null);
            try {
              await actions.removeAddress(removing.id);
            } catch (error) {
              setFailed(error instanceof Error ? error.message : String(error));
            }
          }}
        />
      )}
    </>
  );
}

function inputOf(address: CustomerAddressView, isDefault: boolean): CustomerAddressInput {
  return {
    label: address.label,
    districtId: address.districtId,
    thanaId: address.thanaId,
    area: address.area,
    addressLine: address.addressLine,
    isDefault,
  };
}

/** A starting point for a new address: one found in the chat, say. */
export interface AddressDraft {
  readonly districtId: number | null;
  readonly thanaId: number | null;
  readonly area: string | null;
  readonly addressLine: string;
}

/** Add an address (from `draft` when given) or edit one; the district first, then its thana. */
export function AddressDialog({
  actions,
  address,
  draft,
  onClose,
}: {
  readonly actions: PersonActions;
  readonly address?: CustomerAddressView;
  readonly draft?: AddressDraft;
  readonly onClose: () => void;
}) {
  const t = usePeopleT();
  const id = useId();
  const areas = useQuery({
    queryKey: ['orders', 'areas'],
    queryFn: listAreas,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const start = address ?? draft;
  const [label, setLabel] = useState(address?.label ?? '');
  const [district, setDistrict] = useState<number | null>(start?.districtId ?? null);
  const [thana, setThana] = useState<number | null>(start?.thanaId ?? null);
  const [area, setArea] = useState(start?.area ?? '');
  const [line, setLine] = useState(start?.addressLine ?? '');
  const [isDefault, setIsDefault] = useState(address?.isDefault ?? false);

  const all = useMemo(() => areas.data?.areas ?? [], [areas.data]);
  const districts = useMemo(() => {
    const seen = new Map<number, string>();
    for (const entry of all)
      if (!seen.has(entry.districtId)) seen.set(entry.districtId, entry.districtEn);
    return [...seen]
      .map(([value, name]) => ({ value: String(value), label: name }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [all]);
  const thanas = useMemo(
    () =>
      district === null
        ? []
        : all
            .filter((entry) => entry.districtId === district)
            .map((entry) => ({ value: String(entry.thanaId), label: entry.thanaEn }))
            .sort((a, b) => a.label.localeCompare(b.label)),
    [all, district],
  );

  const body = (): CustomerAddressInput => ({
    label: typed(label),
    districtId: district ?? 0,
    thanaId: thana ?? 0,
    area: typed(area),
    addressLine: line.trim(),
    isDefault,
  });
  const save = useMutation({
    mutationFn: () =>
      address === undefined
        ? actions.addAddress(body())
        : actions.replaceAddress(address.id, body()),
    onSuccess: onClose,
  });
  const ready = district !== null && thana !== null && line.trim().length >= 3;

  return (
    <Dialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={
        address === undefined ? t('people.addresses.addTitle') : t('people.addresses.editTitle')
      }
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
          <Label htmlFor={`${id}-label`}>{t('people.addresses.label')}</Label>
          <Input
            id={`${id}-label`}
            value={label}
            maxLength={40}
            placeholder={t('people.addresses.labelHint')}
            onChange={(event) => setLabel(event.target.value)}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-district`} required>
              {t('people.addresses.district')}
            </Label>
            <Select
              id={`${id}-district`}
              value={district === null ? '' : String(district)}
              placeholder={t('people.addresses.choose')}
              disabled={areas.isPending}
              options={districts}
              onValueChange={(value) => {
                setDistrict(value === '' ? null : Number(value));
                setThana(null);
              }}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-thana`} required>
              {t('people.addresses.thana')}
            </Label>
            <Select
              id={`${id}-thana`}
              value={thana === null ? '' : String(thana)}
              placeholder={t('people.addresses.choose')}
              disabled={district === null}
              options={thanas}
              onValueChange={(value) => setThana(value === '' ? null : Number(value))}
            />
          </div>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-area`}>{t('people.addresses.area')}</Label>
          <Input
            id={`${id}-area`}
            value={area}
            maxLength={160}
            onChange={(event) => setArea(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-line`} required>
            {t('people.addresses.line')}
          </Label>
          <Input
            id={`${id}-line`}
            value={line}
            maxLength={500}
            onChange={(event) => setLine(event.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={isDefault}
            onCheckedChange={(checked) => setIsDefault(checked === true)}
          />
          {t('people.addresses.makeDefaultCheck')}
        </label>
        {areas.isError ? (
          <p role="alert" className="text-sm text-destructive-text">
            {t('people.addresses.areasFailed')}
          </p>
        ) : null}
        {save.isError ? (
          <p role="alert" className="text-sm text-destructive-text">
            {save.error.message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
