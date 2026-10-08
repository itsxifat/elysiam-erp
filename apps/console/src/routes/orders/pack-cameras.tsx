import { zodResolver } from '@hookform/resolvers/zod';
import {
  cameraNameSchema,
  cameraPasswordSchema,
  cameraUsernameSchema,
  rtspUrlSchema,
} from '@elysium/contracts';
import {
  Button,
  DateTime,
  Form,
  FormField,
  Input,
  Select,
  Skeleton,
  StatusBadge,
  TextField,
  cn,
} from '@elysium/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cctv, Pencil, Plus, VideoOff } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { useForm, type UseFormRegisterReturn } from 'react-hook-form';
import { z } from 'zod';

import { ApiError } from '../../api.js';
import { useT, type ConsoleT } from '../../i18n/locale.js';
import '../../i18n/pack-station.js';
import {
  CAMERA_STATE_TONE,
  PACK_SOURCE_KEY,
  cameraErrorCode,
  effectiveCameraId,
  formatElapsed,
  ipRecordingPhase,
  cameraInput,
  parsePackSource,
  serializePackSource,
  type PackSource,
} from './pack-logic.js';
import {
  addPackingCamera,
  packingCameras,
  updatePackingCamera,
  type PackCamera,
  type PackView,
} from './pack-station-api.js';

/**
 * The packing tables' IP cameras in the console (M38c, D-668 to D-676): which source this desk
 * records with, the IP camera's card at the station, and the cameras in the packing settings.
 *
 * The browser never sees the camera's stream (it cannot play RTSP): the server records it,
 * and the station only shows whether the camera is delivering pictures and where its recording
 * of the open order stands.
 */

const CAMERAS_KEY = ['packing', 'cameras'] as const;

function rememberedSource(): PackSource {
  try {
    return parsePackSource(window.localStorage.getItem(PACK_SOURCE_KEY));
  } catch {
    return { kind: 'browser' };
  }
}

function rememberSource(source: PackSource): void {
  try {
    window.localStorage.setItem(PACK_SOURCE_KEY, serializePackSource(source));
  } catch {
    // A remembered source is a convenience; the desk's own camera works too.
  }
}

export interface PackSourceChoice {
  readonly source: PackSource;
  /** The IP camera this desk records with now, or null for this computer's camera. */
  readonly cameraId: string | null;
  /** The brand's cameras in use, to choose from. */
  readonly cameras: readonly PackCamera[];
  /** The IP camera chosen, as the server last described it. */
  readonly camera: PackCamera | null;
  /** The chosen IP camera is switched off: this computer's camera records instead. */
  readonly fellBack: boolean;
  readonly choose: (source: PackSource) => void;
  /** Any of the brand's cameras by id (the one filming an order may not be this desk's). */
  readonly lookup: (cameraId: string) => PackCamera | null;
}

/**
 * This desk's recording source (D-670), remembered by its browser under a neutral key, and the
 * brand's cameras, polled every few seconds while an IP camera is the source so "ready" and
 * "offline" stay true.
 */
export function usePackSource(): PackSourceChoice {
  const [source, setSource] = useState<PackSource>(rememberedSource);
  const cameras = useQuery({
    queryKey: CAMERAS_KEY,
    queryFn: packingCameras,
    refetchInterval: source.kind === 'camera' ? 5_000 : false,
  });
  const list = cameras.data?.cameras;
  const cameraId = effectiveCameraId(source, list);
  return {
    source,
    cameraId,
    cameras: (list ?? []).filter((camera) => camera.enabled),
    camera: list?.find((camera) => camera.id === cameraId) ?? null,
    fellBack: source.kind === 'camera' && list !== undefined && cameraId === null,
    choose: (next) => {
      rememberSource(next);
      setSource(next);
    },
    lookup: (wanted) => list?.find((camera) => camera.id === wanted) ?? null,
  };
}

const BROWSER = 'browser';

/** "Recording source": this computer's camera, or one of the brand's IP cameras. */
export function SourceChoice({
  choice,
  locked,
}: {
  readonly choice: PackSourceChoice;
  /** The open packing is being filmed by its camera already: the source stays for it. */
  readonly locked: boolean;
}) {
  const t = useT();
  const id = useId();
  if (choice.cameras.length === 0 && choice.source.kind === 'browser') return null;
  return (
    <section
      aria-labelledby={`${id}-label`}
      className="space-y-1.5 rounded-lg border border-border bg-card p-4"
    >
      <label
        id={`${id}-label`}
        htmlFor={`${id}-source`}
        className="text-xs font-medium text-muted-foreground"
      >
        {t('ps.source.label')}
      </label>
      <Select
        id={`${id}-source`}
        value={choice.cameraId ?? BROWSER}
        disabled={locked}
        onValueChange={(value) =>
          choice.choose(
            value === BROWSER ? { kind: 'browser' } : { kind: 'camera', cameraId: value },
          )
        }
        options={[
          { value: BROWSER, label: t('ps.source.browser') },
          ...choice.cameras.map((camera) => ({ value: camera.id, label: camera.name })),
        ]}
      />
      {locked ? (
        <p className="text-xs text-muted-foreground">{t('ps.source.fixed')}</p>
      ) : choice.fellBack ? (
        <p role="status" className="text-xs text-warning-subtle-foreground">
          {t('ps.source.gone')}
        </p>
      ) : null}
    </section>
  );
}

/**
 * The IP camera's card at the station: whether the camera is delivering pictures, and where
 * its recording of the open order stands (ready, recording since, being cut, saved).
 */
export function IpCameraCard({
  view,
  camera,
}: {
  readonly view: PackView | undefined;
  readonly camera: PackCamera | null;
}) {
  const t = useT();
  const id = useId();
  const [now, setNow] = useState(() => Date.now());
  const phase = view === undefined ? null : ipRecordingPhase(view);
  const recording = phase === 'recording';
  useEffect(() => {
    if (!recording) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [recording]);

  const state = camera?.state ?? 'offline';
  const error = state === 'offline' ? cameraErrorCode(camera?.lastErrorCode ?? null) : null;
  const from = view?.session.recordingFrom ?? null;
  return (
    <section
      aria-labelledby={`${id}-title`}
      data-testid="pack-ip-camera"
      data-state={state}
      data-phase={phase ?? 'none'}
      className="space-y-3 rounded-lg border border-border bg-card p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id={`${id}-title`}
          className="flex items-center gap-2 text-sm font-semibold tracking-tight"
        >
          <Cctv aria-hidden className="size-4 text-muted-foreground" />
          {camera?.name ?? t('ps.camera.title')}
        </h2>
        <StatusBadge tone={CAMERA_STATE_TONE[state]}>
          {t(state === 'ready' ? 'ps.ip.ready' : state === 'off' ? 'ps.ip.off' : 'ps.ip.offline')}
        </StatusBadge>
      </div>
      {error === null ? null : (
        <p role="status" className="flex items-start gap-2 text-sm text-destructive-text">
          <VideoOff aria-hidden className="mt-0.5 size-4 shrink-0" />
          {t(`ps.ip.error.${error}` as ConsoleT)}
        </p>
      )}
      {phase === null ? null : phase === 'recording' && from !== null ? (
        <StatusBadge tone="danger">
          <span className="tabular-nums" data-testid="pack-ip-recording">
            {`${t('ps.ip.phase.recording')} ${formatElapsed(now - new Date(from).getTime())}`}
          </span>
        </StatusBadge>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t(phase === 'off' ? 'ps.camera.off' : (`ps.ip.phase.${phase}` as ConsoleT))}
        </p>
      )}
      {camera?.lastSegmentAt === null || camera === null ? null : (
        <p className="text-xs text-muted-foreground">
          {`${t('ps.ip.lastSeen')}: `}
          <DateTime value={camera.lastSegmentAt} />
        </p>
      )}
    </section>
  );
}

// --- the settings (org admins, D-669) ---------------------------------------------------------

const cameraFormSchema = z.object({
  name: cameraNameSchema,
  rtspUrl: rtspUrlSchema,
  username: cameraUsernameSchema,
  /** Empty keeps the stored password (or sets none on a new camera). */
  password: z.union([z.literal(''), cameraPasswordSchema]),
  removePassword: z.boolean(),
  enabled: z.boolean(),
});
type CameraForm = z.infer<typeof cameraFormSchema>;

/** The packing settings' "IP cameras": the brand's cameras, their state, add and edit. */
export function IpCamerasSettings() {
  const t = useT();
  const id = useId();
  const cameras = useQuery({ queryKey: CAMERAS_KEY, queryFn: packingCameras });
  const [editing, setEditing] = useState<PackCamera | 'new' | null>(null);
  const list = cameras.data?.cameras ?? [];
  return (
    <section aria-labelledby={`${id}-title`} className="space-y-3 border-t border-border pt-4">
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <h3 id={`${id}-title`} className="text-sm font-semibold tracking-tight">
            {t('ps.cams.title')}
          </h3>
          <p className="text-xs text-muted-foreground">{t('ps.cams.help')}</p>
        </div>
        {editing === null ? (
          <Button size="sm" variant="outline" onClick={() => setEditing('new')}>
            <Plus aria-hidden />
            {t('ps.cams.add')}
          </Button>
        ) : null}
      </div>
      {cameras.data?.credentialsKey === false ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('ps.cams.noKey')}
        </p>
      ) : null}
      {editing !== null ? (
        <CameraEditor camera={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
      ) : cameras.isPending ? (
        <Skeleton className="h-16" />
      ) : cameras.isError ? (
        <p role="alert" className="text-sm text-destructive-text">
          {cameras.error instanceof ApiError ? cameras.error.message : t('ps.failed')}
        </p>
      ) : list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('ps.cams.none')}</p>
      ) : (
        <ul
          className="divide-y divide-border rounded-md border border-border"
          data-testid="pack-cameras"
        >
          {list.map((camera) => (
            <li key={camera.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{camera.name}</p>
                <p className="truncate font-mono text-xs text-muted-foreground">{camera.rtspUrl}</p>
              </div>
              <StatusBadge tone={CAMERA_STATE_TONE[camera.state]}>
                {t(`ps.cams.state.${camera.state}`)}
              </StatusBadge>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`${t('ps.cams.edit')}: ${camera.name}`}
                onClick={() => setEditing(camera)}
              >
                <Pencil aria-hidden />
                {t('ps.cams.edit')}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CameraEditor({
  camera,
  onDone,
}: {
  readonly camera: PackCamera | null;
  readonly onDone: () => void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const form = useForm<CameraForm>({
    resolver: zodResolver(cameraFormSchema),
    defaultValues: {
      name: camera?.name ?? '',
      rtspUrl: camera?.rtspUrl ?? '',
      username: camera?.username ?? '',
      password: '',
      removePassword: false,
      enabled: camera?.enabled ?? true,
    },
  });
  const save = useMutation({
    mutationFn: (values: CameraForm) =>
      camera === null
        ? addPackingCamera(cameraInput(values, false))
        : updatePackingCamera(camera.id, cameraInput(values, true)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: CAMERAS_KEY });
      onDone();
    },
  });
  const passwordHint =
    camera === null
      ? undefined
      : camera.passwordSet === true
        ? `${t('ps.cams.passwordSet')} · ${camera.passwordFingerprint ?? ''} · ${t('ps.cams.passwordKeep')}`
        : t('ps.cams.passwordNone');
  return (
    <Form<CameraForm>
      form={form}
      onSubmit={(values) => save.mutate(values)}
      {...(save.error === null
        ? {}
        : { submitError: save.error instanceof ApiError ? save.error.message : t('ps.failed') })}
      className="rounded-md border border-border p-3"
    >
      <TextField<CameraForm> name="name" label={t('ps.cams.name')} required autoComplete="off" />
      <TextField<CameraForm>
        name="rtspUrl"
        label={t('ps.cams.url')}
        hint={t('ps.cams.urlHint')}
        required
        autoComplete="off"
        placeholder="rtsp://192.168.20.111:554/stream1"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField<CameraForm> name="username" label={t('ps.cams.username')} autoComplete="off" />
        <FormField<CameraForm, 'password'>
          name="password"
          label={t('ps.cams.password')}
          {...(passwordHint === undefined ? {} : { hint: passwordHint })}
        >
          {(field) => (
            <Input
              {...field}
              {...form.register('password')}
              id={field.id}
              type="password"
              autoComplete="new-password"
            />
          )}
        </FormField>
      </div>
      {camera?.passwordSet === true ? (
        <CheckboxRow
          registration={form.register('removePassword')}
          label={t('ps.cams.passwordRemove')}
        />
      ) : null}
      <CheckboxRow registration={form.register('enabled')} label={t('ps.cams.enabled')} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone}>
          {t('ps.cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={save.isPending}>
          {save.isPending ? t('ps.saving') : t('ps.cams.saveCamera')}
        </Button>
      </div>
    </Form>
  );
}

function CheckboxRow({
  registration,
  label,
}: {
  readonly registration: UseFormRegisterReturn;
  readonly label: string;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className={cn('flex items-center gap-2 text-sm')}>
      <input
        id={id}
        type="checkbox"
        {...registration}
        className="size-4 rounded border-border accent-primary focus-visible:ring-2 focus-visible:ring-ring"
      />
      {label}
    </label>
  );
}
