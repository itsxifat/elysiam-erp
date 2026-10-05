import {
  Button,
  EmptyState,
  ErrorState,
  FileUpload,
  PageHeader,
  PermissionGate,
  Skeleton,
  cn,
  controlClassName,
  type UploadTicket,
  type UploadedFile,
} from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from '@tanstack/react-router';
import { ArrowDown, ArrowUp, ImageOff } from 'lucide-react';
import { useState, type ComponentProps, type ReactNode } from 'react';

import { api, ApiError } from '../../api.js';
import { useAbility } from '../../auth/session.js';
import { previewUrl } from './api.js';
import { useWebsiteT } from './messages.js';
import { visibleWebsiteTabs, type WebsiteTab } from './tabs.js';

/**
 * The Website section's frame and the pieces its screens share (M33).
 *
 * Laid out like Settings (D-454): the section's screens down the left, the one open beside
 * them. A screen the caller's role cannot open is not listed; reached by a pasted link, it
 * shows the permission-denied state.
 */

export type WebsitePath = ComponentProps<typeof Link>['to'];
export const websitePath = (path: string): WebsitePath => path;

export const control = `${controlClassName} w-full disabled:opacity-50`;

export function WebsitePage({
  tab,
  children,
  wide = false,
}: {
  readonly tab: WebsiteTab['path'];
  readonly children: ReactNode;
  /** A grid editor needs more than a form's measure. */
  readonly wide?: boolean;
}) {
  const t = useWebsiteT();
  const ability = useAbility();
  const tabs = visibleWebsiteTabs(ability);
  const allowed = tabs.some((entry) => entry.path === tab);
  const itemClass = cn(
    'flex h-8 items-center rounded-md px-2.5 text-sm text-muted-foreground',
    'motion-safe:duration-fast hover:bg-accent hover:text-foreground motion-safe:transition-colors',
    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
    'aria-[current=page]:bg-selected aria-[current=page]:font-medium aria-[current=page]:text-selected-foreground',
  );

  return (
    <div className="space-y-6">
      <PageHeader title={t('web.title')} description={t('web.description')} />
      <div className="grid gap-8 md:grid-cols-[13rem_minmax(0,1fr)]">
        {tabs.length === 0 ? null : (
          <nav aria-label={t('web.title')} className="md:sticky md:top-20 md:self-start">
            <ul className="flex gap-1 overflow-x-auto md:flex-col">
              {tabs.map((entry) => (
                <li key={entry.path} className="shrink-0">
                  <Link to={websitePath(entry.path)} className={itemClass}>
                    {t(entry.labelKey)}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className={cn('min-w-0 space-y-5', wide ? 'max-w-5xl' : 'max-w-form')}>
          <PermissionGate
            allowed={allowed}
            explain={{ title: t('web.deniedTitle'), detail: t('web.deniedDetail') }}
          >
            {children}
          </PermissionGate>
        </div>
      </div>
    </div>
  );
}

/** `/website` itself: the first screen this caller may open, or the denied state. */
export function WebsiteIndexPage() {
  const t = useWebsiteT();
  const ability = useAbility();
  const [first] = visibleWebsiteTabs(ability);
  if (first !== undefined) return <Navigate to={websitePath(first.path)} replace />;
  return (
    <div className="space-y-6">
      <PageHeader title={t('web.title')} />
      <PermissionGate
        allowed={false}
        explain={{ title: t('web.deniedTitle'), detail: t('web.deniedDetail') }}
      >
        {null}
      </PermissionGate>
    </div>
  );
}

/** Loading, failed or loaded, the same way on every screen. */
export function Loadable<T>({
  query,
  children,
}: {
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error: unknown;
    readonly data: T | undefined;
    readonly refetch: () => unknown;
  };
  readonly children: (data: T) => ReactNode;
}) {
  const t = useWebsiteT();
  if (query.isPending) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label={t('web.loading')}>
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.isError || query.data === undefined) {
    return (
      <ErrorState
        title={t('web.errorTitle')}
        detail={query.error instanceof ApiError ? query.error.message : t('web.errorDetail')}
        action={
          <Button size="sm" variant="outline" onClick={() => void query.refetch()}>
            {t('web.retry')}
          </Button>
        }
      />
    );
  }
  return <>{children(query.data)}</>;
}

export function Empty() {
  const t = useWebsiteT();
  return <EmptyState title={t('web.empty')} />;
}

/** A labelled control, the label tied to it by id. */
export function Field({
  id,
  label,
  hint,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly hint?: string | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div className="space-y-1.5 text-sm">
      <label htmlFor={id} className="block font-medium">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

/** The error a save came back with, in words. */
export function messageOf(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function Problem({ error }: { readonly error: unknown }) {
  const t = useWebsiteT();
  if (error === null || error === undefined) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {messageOf(error, t('web.errorDetail'))}
    </p>
  );
}

/** A stored image, through a short-lived signed address. */
export function Preview({
  fileId,
  alt,
  className,
}: {
  readonly fileId: string | null;
  readonly alt: string;
  readonly className?: string;
}) {
  const url = useQuery({
    queryKey: ['files', 'url', fileId],
    queryFn: () => previewUrl(fileId ?? ''),
    enabled: fileId !== null,
    staleTime: 4 * 60_000,
  });
  return (
    <div
      className={cn(
        'flex items-center justify-center overflow-hidden rounded-md border border-border bg-muted',
        className ?? 'h-16 w-28',
      )}
    >
      {url.data === undefined ? (
        <ImageOff aria-hidden className="size-5 text-muted-foreground" />
      ) : (
        <img src={url.data.url} alt={alt} className="size-full object-cover" />
      )}
    </div>
  );
}

/**
 * Upload one public image for the website and hand back its file id. The purpose decides
 * which permission reads it and that the media path may serve it (D-507).
 */
export function ImagePicker({
  purpose,
  onUploaded,
  disabled,
}: {
  readonly purpose: 'storefront-image' | 'category-image';
  readonly onUploaded: (fileId: string) => void;
  readonly disabled?: boolean;
}) {
  const t = useWebsiteT();
  const [round, setRound] = useState(0);
  return (
    <FileUpload
      key={round}
      accept="image/webp,image/jpeg,image/png"
      disabled={disabled === true}
      createTicket={(input) =>
        api.post<UploadTicket>('/v1/files', { ...input, visibility: 'public', purpose })
      }
      finalize={(fileId) => api.post<UploadedFile>(`/v1/files/${fileId}/finalize`)}
      onUploaded={(file) => {
        onUploaded(file.id);
        setRound((current) => current + 1);
      }}
      labels={{
        choose: t('web.upload.choose'),
        uploading: t('web.upload.uploading'),
        uploaded: t('web.upload.uploaded'),
        remove: t('web.upload.remove'),
        failed: t('web.upload.failed'),
        tooLarge: t('web.upload.tooLarge'),
      }}
    />
  );
}

/** Move-up and move-down buttons: the keyboard's way to reorder what a pointer drags. */
export function MoveButtons({
  index,
  count,
  disabled,
  onMove,
  label,
}: {
  readonly index: number;
  readonly count: number;
  readonly disabled?: boolean;
  readonly onMove: (from: number, to: number) => void;
  readonly label: string;
}) {
  const t = useWebsiteT();
  return (
    <span className="inline-flex gap-1">
      <Button
        size="sm"
        variant="ghost"
        aria-label={`${t('web.moveUp')}: ${label}`}
        disabled={disabled === true || index === 0}
        onClick={() => onMove(index, index - 1)}
      >
        <ArrowUp aria-hidden />
      </Button>
      <Button
        size="sm"
        variant="ghost"
        aria-label={`${t('web.moveDown')}: ${label}`}
        disabled={disabled === true || index === count - 1}
        onClick={() => onMove(index, index + 1)}
      >
        <ArrowDown aria-hidden />
      </Button>
    </span>
  );
}

/** A list moved from one place to another, as a new array. */
export function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return next;
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item);
  return next;
}

/**
 * Native drag and drop for a list's rows, no library: the row being dragged and the row
 * it is dropped on. Pointer users drag; keyboard users use `MoveButtons`.
 */
export function useDragReorder(onMove: (from: number, to: number) => void) {
  const [dragging, setDragging] = useState<number | null>(null);
  return (index: number) => ({
    draggable: true,
    onDragStart: (event: React.DragEvent) => {
      setDragging(index);
      event.dataTransfer.effectAllowed = 'move';
    },
    onDragOver: (event: React.DragEvent) => {
      if (dragging !== null) event.preventDefault();
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      if (dragging !== null && dragging !== index) onMove(dragging, index);
      setDragging(null);
    },
    onDragEnd: () => setDragging(null),
    'data-dragging': dragging === index ? 'true' : undefined,
  });
}
