import {
  Button,
  Dialog,
  ErrorState,
  PageHeader,
  PermissionGate,
  Select,
  Skeleton,
  StatusBadge,
  controlClassName,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { cloneElement, useId, useState, type ReactElement } from 'react';

import { ApiError } from '../../api.js';
import {
  archiveLocation,
  deleteLocation,
  locationUsage,
  restoreLocation,
} from '../../api/manage.js';
import { useAbility } from '../../auth/session.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/manage.js';
import '../../i18n/stock-tools.js';
import { DeleteOrArchive } from '../../ui/delete-or-archive.js';
import { codeFrom } from '../catalog/variant-grid.js';
import {
  createLocation,
  listAllLocations,
  listBranchOptions,
  updateLocation,
  type StockLocation,
} from '../stock/api.js';

/**
 * Locations: every place that holds the brand's stock, on a page of its own (D-951).
 *
 * It was the last section of Catalog setup (D-424, D-429), reached through a menu item
 * and a button that both named only categories, sizes and colours, so an owner looking
 * for "add a location" did not find it. The section moved here unchanged: the same
 * list, the same add form, the same edit and delete-or-archive dialogs, the same grants.
 *
 * - **Who sees it:** `read Stock`, the same as the stock screens that pick a location.
 * - **Who adds, renames, archives or deletes:** `create`, `update` and `delete Catalog`,
 *   org_admin alone (§6): a location is part of the brand's physical footprint, a setup
 *   decision like a category, and the server checks the same grants.
 * - **A branch:** a showroom always belongs to one (the server refuses one without). A
 *   warehouse may belong to one, as the seeded main warehouse belongs to the head office,
 *   or to none, serving the whole brand; the add form offers both, where it used to send
 *   none. The branch cannot be changed afterwards (the server's update takes a name and
 *   on/off only), which the form says before saving.
 * - **Branch names** come from `GET /v1/hr/branch-options` (`create Employee`). A role
 *   without it still sees every location, with no branch name beside it.
 */
export function LocationsPage() {
  const ability = useAbility();
  const t = useT();
  const queryClient = useQueryClient();

  const mayStock = ability.can('read', 'Stock');
  const mayCreate = ability.can('create', 'Catalog');
  const mayUpdate = ability.can('update', 'Catalog');
  // M39a (D-621): deleting is its own grant; archiving and restoring are `update`.
  const mayDelete = ability.can('delete', 'Catalog');
  const mayBranches = mayCreate || ability.can('create', 'Employee');

  // Every kind, in-transit included, and archived ones too, so a switched-off one can be
  // switched back on (ledger audit L2).
  const locations = useQuery({
    queryKey: ['stock', 'locations', 'all'],
    queryFn: listAllLocations,
    enabled: mayStock,
  });
  const branches = useQuery({
    queryKey: ['hr', 'branch-options'],
    queryFn: listBranchOptions,
    enabled: mayStock && mayBranches,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // Every stock screen's location list, the till's included, reads `['stock', …]`.
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
    void queryClient.invalidateQueries({ queryKey: ['settings', 'locations'] });
  };

  return (
    <div className="max-w-4xl space-y-6">
      <PageHeader title={t('st.loc.title')} description={t('st.loc.help')} />
      <PermissionGate
        allowed={mayStock}
        explain={{ title: t('st.loc.deniedTitle'), detail: t('st.loc.deniedDetail') }}
      >
        {locations.isPending ? (
          <div className="space-y-2" aria-hidden>
            <Skeleton className="h-row w-full" />
            <Skeleton className="h-row w-full" />
            <Skeleton className="h-row w-full" />
          </div>
        ) : locations.isError ? (
          <ErrorState title={t('st.loc.errorTitle')} />
        ) : (
          <Locations
            items={locations.data.items}
            branches={branches.data?.items ?? []}
            mayCreate={mayCreate}
            mayUpdate={mayUpdate}
            mayDelete={mayDelete}
            onDone={refresh}
          />
        )}
      </PermissionGate>
    </div>
  );
}

/** The kit's control; width comes from where it sits (a dialog's column, a form row). */
const control = controlClassName;

/** `{name}` in a catalogue string, filled. */
const fill = (text: string, values: Readonly<Record<string, string>>): string =>
  Object.entries(values).reduce((out, [key, value]) => out.replace(`{${key}}`, value), text);

interface BranchOption {
  readonly id: string;
  readonly name: string;
}

function Locations({
  items,
  branches,
  mayCreate,
  mayUpdate,
  mayDelete,
  onDone,
}: {
  readonly items: readonly StockLocation[];
  readonly branches: readonly BranchOption[];
  readonly mayCreate: boolean;
  readonly mayUpdate: boolean;
  readonly mayDelete: boolean;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [managing, setManaging] = useState<StockLocation | null>(null);
  const [editing, setEditing] = useState<StockLocation | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'warehouse' | 'showroom'>('showroom');
  // `null` until chosen: a showroom then takes the first branch, a warehouse none.
  const [branchId, setBranchId] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const suggested = code ?? codeFrom(name, 16);

  const branchName = new Map(branches.map((branch) => [branch.id, branch.name]));
  const chosenBranch = branchId ?? (kind === 'showroom' ? (branches[0]?.id ?? '') : '');
  const branchOptions = [
    ...(kind === 'warehouse' ? [{ value: '', label: t('st.loc.noBranch') }] : []),
    ...branches.map((branch) => ({ value: branch.id, label: branch.name })),
  ];

  const create = useMutation({
    mutationFn: () =>
      createLocation({
        code: suggested,
        name: name.trim(),
        kind,
        ...(chosenBranch === '' ? {} : { branchId: chosenBranch }),
      }),
    onSuccess: () => {
      setName('');
      setCode(null);
      setBranchId(null);
      onDone();
    },
  });

  /** Whose location it is, when the caller may read branch names. */
  const ownerOf = (location: StockLocation): string | null => {
    if (location.branchId === null) return t('st.loc.wholeBrand');
    return branchName.get(location.branchId) ?? null;
  };

  return (
    <section
      aria-labelledby="locations-heading"
      className="space-y-4 rounded-lg border border-border bg-card p-5"
    >
      <h2 id="locations-heading" className="text-base font-semibold tracking-tight">
        {t('cs.setup.locations')}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('st.loc.empty')}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((location) => {
            const owner = ownerOf(location);
            return (
              <li
                key={location.id}
                className="flex min-h-row items-center gap-3 px-4 py-1.5 text-sm"
              >
                <span className="font-medium">{location.name}</span>
                <span className="text-xs text-muted-foreground tabular-nums">{location.code}</span>
                <StatusBadge tone="neutral">{t(`cs.locationKind.${location.kind}`)}</StatusBadge>
                {owner === null ? null : (
                  <span className="text-xs text-muted-foreground">{owner}</span>
                )}
                {location.isActive ? null : (
                  <StatusBadge tone="neutral">{t('mg.archivedBadge')}</StatusBadge>
                )}
                <span className="flex-1" />
                <PermissionGate allowed={mayUpdate}>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(location)}>
                    {t('cs.edit')}
                  </Button>
                </PermissionGate>
                <PermissionGate allowed={mayUpdate || mayDelete}>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={fill(t('mg.setup.manageNamed'), { name: location.name })}
                    title={t('mg.setup.manage')}
                    onClick={() => setManaging(location)}
                  >
                    <Trash2 aria-hidden />
                  </Button>
                </PermissionGate>
              </li>
            );
          })}
        </ul>
      )}

      <PermissionGate allowed={mayCreate}>
        <div className="flex flex-wrap items-end gap-3 rounded-lg bg-muted/50 p-4">
          <Field label={t('cs.setup.locationName')}>
            <input
              value={name}
              maxLength={120}
              placeholder={t('cs.setup.locationExample')}
              onChange={(event) => setName(event.target.value)}
              className={control}
            />
          </Field>
          <Field label={t('cs.setup.locationKind')}>
            <Select
              value={kind}
              onValueChange={(value) => {
                setKind(value as 'warehouse' | 'showroom');
                setBranchId(null);
              }}
              className="min-w-36"
              options={[
                { value: 'showroom', label: t('cs.locationKind.showroom') },
                { value: 'warehouse', label: t('cs.locationKind.warehouse') },
              ]}
            />
          </Field>
          <Field label={t('cs.setup.branch')}>
            <Select
              value={chosenBranch}
              onValueChange={setBranchId}
              className="min-w-44"
              options={branchOptions}
            />
          </Field>
          <Field label={t('cs.setup.code')}>
            <input
              value={suggested}
              maxLength={16}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              className={`${control} w-28 font-mono uppercase`}
            />
          </Field>
          <Button
            size="sm"
            disabled={
              name.trim() === '' ||
              !/^[A-Z0-9][A-Z0-9-]{0,15}$/.test(suggested) ||
              (kind === 'showroom' && chosenBranch === '') ||
              create.isPending
            }
            onClick={() => create.mutate()}
          >
            {t('cs.setup.addLocation')}
          </Button>
          <p className="basis-full text-sm text-muted-foreground">{t('st.loc.branchFixed')}</p>
          <Problem error={create.error} />
        </div>
      </PermissionGate>

      {editing === null ? null : (
        <EditLocation
          key={editing.id}
          location={editing}
          onClose={() => setEditing(null)}
          onDone={onDone}
        />
      )}

      {managing === null ? null : (
        <DeleteOrArchive
          key={managing.id}
          open
          onClose={() => setManaging(null)}
          queryKey={['stock', 'locations', managing.id]}
          loadUsage={() => locationUsage(managing.id)}
          onDelete={mayDelete ? () => deleteLocation(managing.id) : undefined}
          onArchive={mayUpdate ? () => archiveLocation(managing.id) : undefined}
          archiveNote={t('mg.archive.location')}
          onRestore={mayUpdate ? () => restoreLocation(managing.id) : undefined}
          onDone={onDone}
        />
      )}
    </section>
  );
}

function EditLocation({
  location,
  onClose,
  onDone,
}: {
  readonly location: StockLocation;
  readonly onClose: () => void;
  readonly onDone: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(location.name);
  const save = useMutation({
    mutationFn: () => updateLocation(location.id, { name: name.trim() }),
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
      title={t('cs.setup.editLocation')}
      description={t('mg.setup.locationCodeFixed')}
      closeLabel={t('cs.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cs.cancel')}
          </Button>
          <Button disabled={name.trim() === '' || save.isPending} onClick={() => save.mutate()}>
            {t('cs.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label={t('cs.setup.locationName')}>
          <input
            value={name}
            maxLength={120}
            onChange={(event) => setName(event.target.value)}
            className={control}
          />
        </Field>
        <Problem error={save.error} />
      </div>
    </Dialog>
  );
}

/** A label joined to its one control by id (see `Field` in catalog/parts.tsx for why). */
function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactElement<{ id?: string }>;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {cloneElement(children, { id })}
    </div>
  );
}

function Problem({ error }: { readonly error: unknown }) {
  const t = useT();
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className="basis-full text-sm text-destructive">
      {error instanceof ApiError ? error.message : t('cs.saveFailed')}
    </p>
  );
}
