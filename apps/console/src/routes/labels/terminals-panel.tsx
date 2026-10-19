import type { MessageKey } from '@elysium/i18n';
import {
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Input,
  Label,
  Select,
  Skeleton,
  StatusBadge,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, Monitor, Plus, Printer, Users } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';

import { ApiError } from '../../api.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/pack-station.js';
import { packingCameras } from '../orders/pack-station-api.js';
import {
  bindTerminal,
  createTerminal,
  listTerminals,
  revokeDevice,
  setTerminalCameras,
  setTerminalMembers,
  updateTerminal,
  type TerminalCard,
  type TerminalKind,
} from './api.js';
import { PresenceBadge, PrinterStateBadge, useHubLocations } from './parts.js';
import { clearBinding, saveBinding, useTerminalBinding } from './terminal-binding.js';

/**
 * The terminals of one kind (M46, D-801 to D-803, D-823): a live card for each — who is signed
 * in at it now and their presence, its cameras and printers with their state, its queue, what it
 * is packing and its orders per hour today — and, for a supervisor, adding and editing them,
 * assigning people and cameras, and binding this computer.
 */
export function TerminalsPanel({ kind }: { readonly kind: TerminalKind }) {
  const t = useT();
  const view = useQuery({
    queryKey: ['terminals'],
    queryFn: listTerminals,
    refetchInterval: 20_000,
  });
  const [adding, setAdding] = useState(false);

  if (view.isPending) {
    return (
      <div className="grid gap-4 md:grid-cols-2" aria-busy="true" aria-label={t('lb.loading')}>
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (view.isError) {
    return (
      <ErrorState
        title={t('lb.failed')}
        action={
          <Button variant="outline" size="sm" onClick={() => void view.refetch()}>
            {t('lb.retry')}
          </Button>
        }
      />
    );
  }
  const terminals = view.data.terminals.filter((terminal) => terminal.kind === kind);
  return (
    <div className="space-y-4">
      {view.data.canEdit ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => setAdding(true)} data-testid="add-terminal">
            <Plus aria-hidden />
            {t('lb.terminals.add')}
          </Button>
        </div>
      ) : null}
      {terminals.length === 0 ? (
        <EmptyState title={t('lb.terminals.empty')} detail={t('lb.terminals.emptyDetail')} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {terminals.map((terminal) => (
            <TerminalLiveCard
              key={terminal.id}
              terminal={terminal}
              canEdit={view.data.canEdit}
              people={view.data.people}
            />
          ))}
        </div>
      )}
      {adding ? <TerminalDialog kind={kind} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function Fact({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

function TerminalLiveCard({
  terminal,
  canEdit,
  people,
}: {
  readonly terminal: TerminalCard;
  readonly canEdit: boolean;
  readonly people: readonly { readonly id: string; readonly name: string }[];
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const binding = useTerminalBinding();
  const { names } = useHubLocations();
  const [dialog, setDialog] = useState<'edit' | 'people' | 'cameras' | 'bind' | null>(null);
  const thisOne = binding?.terminalId === terminal.id;
  const revoke = useMutation({
    mutationFn: revokeDevice,
    onSuccess: async (_result, deviceId) => {
      if (binding?.deviceId === deviceId) clearBinding();
      await queryClient.invalidateQueries({ queryKey: ['terminals'] });
    },
  });

  return (
    <section
      className="space-y-4 rounded-lg border border-border bg-card p-5"
      data-testid="terminal-card"
      data-terminal={terminal.name}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            {terminal.name}
            {terminal.active ? null : <StatusBadge>{t('lb.terminal.off')}</StatusBadge>}
            {thisOne ? (
              <StatusBadge tone="info">
                <Monitor aria-hidden className="size-3.5" />
                {t('lb.terminal.thisOne')}
              </StatusBadge>
            ) : null}
          </h3>
          <p className="text-xs text-muted-foreground">
            {t(`lb.terminal.kind.${terminal.kind}` as MessageKey)}
            {terminal.locationId === null
              ? ` · ${t('lb.allLocations')}`
              : ` · ${names.get(terminal.locationId) ?? ''}`}
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setDialog('edit')}>
              {t('lb.terminal.edit')}
            </Button>
            {thisOne ? (
              <Button size="sm" variant="outline" onClick={() => clearBinding()}>
                {t('lb.terminal.unbind')}
              </Button>
            ) : terminal.active ? (
              <Button size="sm" onClick={() => setDialog('bind')} data-testid="bind-terminal">
                <Monitor aria-hidden />
                {t('lb.terminal.bind')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </header>

      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">{t('lb.terminal.workingNow')}</p>
        {terminal.workingNow.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('lb.terminal.nobody')}</p>
        ) : (
          <ul className="space-y-1" data-testid="working-now">
            {terminal.workingNow.map((person) => (
              <li
                key={`${person.id}-${person.deviceLabel}`}
                className="flex items-center gap-2 text-sm"
              >
                <span className="font-medium">{person.name ?? '—'}</span>
                <PresenceBadge state={person.presence} />
                <span className="text-xs text-muted-foreground">{person.deviceLabel}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <dl className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {terminal.kind === 'packing' ? (
          <>
            <Fact label={t('lb.terminal.packingNow')}>
              {terminal.packingNow === null ? '—' : terminal.packingNow.orderNo}
            </Fact>
            <Fact label={t('lb.terminal.packedToday')}>{terminal.packedToday}</Fact>
            <Fact label={t('lb.terminal.perHour')}>{terminal.ordersPerHour}</Fact>
          </>
        ) : null}
        <Fact label={t('lb.terminal.queue')}>{terminal.queued}</Fact>
      </dl>

      {terminal.kind === 'packing' ? (
        <div className="space-y-2">
          <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <Camera aria-hidden className="size-3.5" />
              {t('lb.terminal.cameras')}
            </span>
            {canEdit ? (
              <Button size="sm" variant="ghost" onClick={() => setDialog('cameras')}>
                {t('lb.terminal.setCameras')}
              </Button>
            ) : null}
          </p>
          {terminal.cameras.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('lb.terminal.noCameras')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {terminal.cameras.map((camera) => (
                <li key={camera.id}>
                  <StatusBadge
                    tone={
                      camera.state === 'ready'
                        ? 'success'
                        : camera.state === 'offline'
                          ? 'danger'
                          : 'neutral'
                    }
                  >
                    {`${camera.name} · ${t(`ps.cams.state.${camera.state}` as MessageKey)}`}
                  </StatusBadge>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}

      <div className="space-y-2">
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Printer aria-hidden className="size-3.5" />
          {t('lb.terminal.printers')}
        </p>
        {terminal.printers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('lb.terminal.noPrinters')}</p>
        ) : (
          <ul className="space-y-1">
            {terminal.printers.map((printer) => (
              <li key={printer.id} className="flex flex-wrap items-center gap-2 text-sm">
                <span>{printer.name}</span>
                <PrinterStateBadge state={printer.state} detail={printer.detail} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <p className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Users aria-hidden className="size-3.5" />
            {t('lb.terminal.people')}
          </span>
          {canEdit ? (
            <Button size="sm" variant="ghost" onClick={() => setDialog('people')}>
              {t('lb.terminal.assign')}
            </Button>
          ) : null}
        </p>
        <p className="text-sm">
          {terminal.members.length === 0
            ? t('lb.terminal.noPeople')
            : terminal.members.map((member) => member.name ?? '—').join(', ')}
        </p>
      </div>

      {canEdit && terminal.devices.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t('lb.terminal.computers')}</p>
          <ul className="space-y-1">
            {terminal.devices.map((device) => (
              <li
                key={device.id}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span>
                  {device.label}
                  {device.lastSeenAt === null
                    ? ''
                    : ` · ${t('lb.terminal.lastSeen')} ${new Date(device.lastSeenAt).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka' })}`}
                  {device.lastUser === null ? '' : ` · ${device.lastUser.name ?? ''}`}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(device.id)}
                >
                  {t('lb.terminal.revoke')}
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {dialog === 'edit' ? (
        <TerminalDialog kind={terminal.kind} terminal={terminal} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'people' ? (
        <PeopleDialog terminal={terminal} people={people} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'cameras' ? (
        <CamerasDialog terminal={terminal} onClose={() => setDialog(null)} />
      ) : null}
      {dialog === 'bind' ? (
        <BindDialog terminal={terminal} onClose={() => setDialog(null)} />
      ) : null}
    </section>
  );
}

function useSaved(onClose: () => void) {
  const queryClient = useQueryClient();
  return async () => {
    await queryClient.invalidateQueries({ queryKey: ['terminals'] });
    await queryClient.invalidateQueries({ queryKey: ['labels'] });
    onClose();
  };
}

function errorText(error: unknown, fallback: string): string | null {
  if (error === null) return null;
  return error instanceof ApiError ? error.message : fallback;
}

function TerminalDialog({
  kind,
  terminal,
  onClose,
}: {
  readonly kind: TerminalKind;
  readonly terminal?: TerminalCard;
  readonly onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const saved = useSaved(onClose);
  const { options } = useHubLocations();
  const [name, setName] = useState(terminal?.name ?? '');
  const [location, setLocation] = useState(terminal?.locationId ?? '');
  const [active, setActive] = useState(terminal?.active ?? true);
  const save = useMutation({
    mutationFn: () =>
      terminal === undefined
        ? createTerminal({ kind, name: name.trim(), locationId: location === '' ? null : location })
        : updateTerminal(terminal.id, {
            name: name.trim(),
            locationId: location === '' ? null : location,
            active,
          }),
    onSuccess: saved,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={terminal === undefined ? t('lb.terminals.add') : t('lb.terminal.edit')}
      closeLabel={t('lb.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('lb.cancel')}
          </Button>
          <Button disabled={name.trim() === '' || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('lb.saving') : t('lb.save')}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-name`}>{t('lb.terminal.name')}</Label>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={40}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-location`}>{t('lb.terminal.location')}</Label>
          <Select
            id={`${id}-location`}
            value={location}
            onValueChange={setLocation}
            options={options}
            placeholder={t('lb.allLocations')}
          />
        </div>
        {terminal === undefined ? null : (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={active} onCheckedChange={(value) => setActive(value === true)} />
            {t('lb.terminal.active')}
          </label>
        )}
        {save.error === null ? null : (
          <p role="alert" className="text-sm text-destructive-text">
            {errorText(save.error, t('lb.failed'))}
          </p>
        )}
      </div>
    </Dialog>
  );
}

function PeopleDialog({
  terminal,
  people,
  onClose,
}: {
  readonly terminal: TerminalCard;
  readonly people: readonly { readonly id: string; readonly name: string }[];
  readonly onClose: () => void;
}) {
  const t = useT();
  const saved = useSaved(onClose);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    new Set(terminal.members.map((member) => member.id)),
  );
  const save = useMutation({
    mutationFn: () => setTerminalMembers(terminal.id, [...chosen]),
    onSuccess: saved,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${t('lb.terminal.assign')} · ${terminal.name}`}
      closeLabel={t('lb.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('lb.cancel')}
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('lb.saving') : t('lb.save')}
          </Button>
        </>
      }
    >
      <ul className="max-h-80 space-y-2 overflow-y-auto">
        {people.map((person) => (
          <li key={person.id}>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={chosen.has(person.id)}
                onCheckedChange={() =>
                  setChosen((current) => {
                    const next = new Set(current);
                    if (next.has(person.id)) next.delete(person.id);
                    else next.add(person.id);
                    return next;
                  })
                }
              />
              {person.name}
            </label>
          </li>
        ))}
      </ul>
      {save.error === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {errorText(save.error, t('lb.failed'))}
        </p>
      )}
    </Dialog>
  );
}

function CamerasDialog({
  terminal,
  onClose,
}: {
  readonly terminal: TerminalCard;
  readonly onClose: () => void;
}) {
  const t = useT();
  const saved = useSaved(onClose);
  const cameras = useQuery({ queryKey: ['packing', 'cameras'], queryFn: packingCameras });
  const [chosen, setChosen] = useState<ReadonlySet<string>>(
    new Set(terminal.cameras.map((camera) => camera.id)),
  );
  const save = useMutation({
    mutationFn: () => setTerminalCameras(terminal.id, [...chosen]),
    onSuccess: saved,
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${t('lb.terminal.setCameras')} · ${terminal.name}`}
      closeLabel={t('lb.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('lb.cancel')}
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? t('lb.saving') : t('lb.save')}
          </Button>
        </>
      }
    >
      <ul className="max-h-80 space-y-2 overflow-y-auto">
        {(cameras.data?.cameras ?? []).map((camera) => (
          <li key={camera.id}>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={chosen.has(camera.id)}
                onCheckedChange={() =>
                  setChosen((current) => {
                    const next = new Set(current);
                    if (next.has(camera.id)) next.delete(camera.id);
                    else next.add(camera.id);
                    return next;
                  })
                }
              />
              {camera.name}
            </label>
          </li>
        ))}
      </ul>
      {save.error === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {errorText(save.error, t('lb.failed'))}
        </p>
      )}
    </Dialog>
  );
}

function BindDialog({
  terminal,
  onClose,
}: {
  readonly terminal: TerminalCard;
  readonly onClose: () => void;
}) {
  const t = useT();
  const id = useId();
  const saved = useSaved(onClose);
  const [label, setLabel] = useState('');
  const bind = useMutation({
    mutationFn: () => bindTerminal(terminal.id, label.trim()),
    onSuccess: async (bound) => {
      saveBinding({
        token: bound.token,
        deviceId: bound.device.id,
        label: bound.device.label,
        terminalId: bound.terminal.id,
        terminalName: bound.terminal.name,
        kind: bound.terminal.kind,
      });
      await saved();
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${t('lb.terminal.bind')} · ${terminal.name}`}
      description={t('lb.terminal.bindHint')}
      closeLabel={t('lb.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('lb.cancel')}
          </Button>
          <Button disabled={label.trim() === '' || bind.isPending} onClick={() => bind.mutate()}>
            {t('lb.terminal.bind')}
          </Button>
        </>
      }
    >
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-label`}>{t('lb.terminal.bindLabel')}</Label>
        <Input
          id={`${id}-label`}
          value={label}
          maxLength={60}
          autoFocus
          onChange={(event) => setLabel(event.target.value)}
        />
      </div>
      {bind.error === null ? null : (
        <p role="alert" className="text-sm text-destructive-text">
          {errorText(bind.error, t('lb.failed'))}
        </p>
      )}
    </Dialog>
  );
}
