import { Button, Dialog, type UploadTicket, type UploadedFile } from '@elysium/ui';
import { ArrowLeft, ArrowRight, Crop, ImagePlus, Star, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

import { api } from '../../api.js';
import { useT } from '../../i18n/locale.js';
import '../../i18n/stock-tools.js';
import {
  centredView,
  clampOffset,
  cropRect,
  cropScale,
  zoomAboutCentre,
  type CropView,
} from './photo-crop.js';

/**
 * Product photos in the new-product form (M38a, D-601): several at once, dragged (or moved
 * with the arrow buttons) into order, the first one the cover, each optionally cropped to the
 * shop's shape. Nothing is uploaded until the product is saved, so a crop or a removal costs
 * no upload; `uploadPhoto` then sends each through §22's three-step ticket.
 */

export interface PendingPhoto {
  readonly key: string;
  readonly file: File;
  /** An object URL for the preview; let go when the photo leaves the list. */
  readonly url: string;
}

let photoKey = 0;

export function pendingPhoto(file: File): PendingPhoto {
  photoKey += 1;
  return { key: `photo-${String(photoKey)}`, file, url: URL.createObjectURL(file) };
}

/** Upload one photo: ticket, PUT straight to storage, finalize (§22). */
export async function uploadPhoto(file: File): Promise<UploadedFile> {
  const ticket = await api.post<UploadTicket>('/v1/files', {
    contentType: file.type === '' ? 'application/octet-stream' : file.type,
    sizeBytes: file.size,
    originalName: file.name,
    visibility: 'public',
    purpose: 'product-image',
  });
  if (file.size > ticket.maxBytes) throw new PhotoTooLargeError();
  const response = await fetch(ticket.url, {
    method: ticket.method,
    headers: { ...ticket.headers },
    body: file,
  });
  if (!response.ok) throw new Error('The photo could not be stored.');
  return api.post<UploadedFile>(`/v1/files/${ticket.fileId}/finalize`);
}

export class PhotoTooLargeError extends Error {
  constructor() {
    super('That photo is larger than a product photo may be.');
    this.name = 'PhotoTooLargeError';
  }
}

const ACCEPT = 'image/webp,image/jpeg,image/png';

export function PhotoPicker({
  photos,
  onChange,
  disabled,
}: {
  readonly photos: readonly PendingPhoto[];
  readonly onChange: (next: PendingPhoto[]) => void;
  readonly disabled?: boolean;
}) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [cropping, setCropping] = useState<PendingPhoto | null>(null);
  const [rejected, setRejected] = useState(0);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= photos.length || from === to) return;
    const next = [...photos];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return;
    next.splice(to, 0, moved);
    onChange(next);
  };

  const remove = (photo: PendingPhoto) => {
    URL.revokeObjectURL(photo.url);
    onChange(photos.filter((entry) => entry.key !== photo.key));
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={input}
          id={id}
          type="file"
          accept={ACCEPT}
          multiple
          // Out of the tab order and the accessibility tree: the Add photos button opens it.
          className="hidden"
          disabled={disabled === true}
          onChange={(event) => {
            const files = [...(event.target.files ?? [])];
            const images = files.filter((file) => ACCEPT.split(',').includes(file.type));
            setRejected(files.length - images.length);
            onChange([...photos, ...images.map(pendingPhoto)]);
            event.target.value = '';
          }}
        />
        <Button
          type="button"
          variant="outline"
          disabled={disabled === true}
          onClick={() => input.current?.click()}
        >
          <ImagePlus aria-hidden="true" />
          {t('st.photos.add')}
        </Button>
        <p className="text-xs text-muted-foreground">{t('st.photos.help')}</p>
      </div>
      {rejected > 0 ? (
        <p role="alert" className="text-sm text-destructive">
          {t('st.photos.notImage')}
        </p>
      ) : null}

      {photos.length === 0 ? null : (
        <ol className="flex flex-wrap gap-3" aria-label={t('st.photos.order')}>
          {photos.map((photo, index) => (
            <li
              key={photo.key}
              draggable={disabled !== true}
              onDragStart={(event) => {
                setDragging(photo.key);
                event.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(event) => {
                if (dragging === null) return;
                event.preventDefault();
              }}
              onDrop={(event) => {
                event.preventDefault();
                const from = photos.findIndex((entry) => entry.key === dragging);
                setDragging(null);
                move(from, index);
              }}
              onDragEnd={() => setDragging(null)}
              className={
                dragging === photo.key
                  ? 'w-28 space-y-1 opacity-50'
                  : 'w-28 cursor-grab space-y-1 active:cursor-grabbing'
              }
            >
              <div className="relative aspect-[3/4] overflow-hidden rounded-lg border border-border bg-muted">
                <img
                  src={photo.url}
                  alt={`${t('st.photos.photo')} ${String(index + 1)}`}
                  className="size-full object-cover"
                />
                {index === 0 ? (
                  <span className="absolute inset-x-0 bottom-0 bg-foreground/80 py-0.5 text-center text-xs text-background">
                    {t('st.photos.cover')}
                  </span>
                ) : null}
              </div>
              <div className="flex justify-center gap-0.5">
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${t('st.photos.moveLeft')} ${String(index + 1)}`}
                  disabled={disabled === true || index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowLeft aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${t('st.photos.makeCover')} ${String(index + 1)}`}
                  disabled={disabled === true || index === 0}
                  onClick={() => move(index, 0)}
                >
                  <Star aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${t('st.photos.crop')} ${String(index + 1)}`}
                  disabled={disabled === true}
                  onClick={() => setCropping(photo)}
                >
                  <Crop aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${t('st.photos.moveRight')} ${String(index + 1)}`}
                  disabled={disabled === true || index === photos.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowRight aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`${t('st.photos.remove')} ${String(index + 1)}`}
                  disabled={disabled === true}
                  onClick={() => remove(photo)}
                >
                  <Trash2 aria-hidden="true" />
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      {cropping === null ? null : (
        <CropDialog
          photo={cropping}
          onClose={() => setCropping(null)}
          onCropped={(file) => {
            const replacement = pendingPhoto(file);
            URL.revokeObjectURL(cropping.url);
            onChange(photos.map((entry) => (entry.key === cropping.key ? replacement : entry)));
            setCropping(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Crop to the shop's 3 : 4 shape: drag the photo (or use the arrow keys) and zoom until the
 * part that should show sits in the frame. Drawn onto a canvas and saved as a JPEG.
 */
function CropDialog({
  photo,
  onClose,
  onCropped,
}: {
  readonly photo: PendingPhoto;
  readonly onClose: () => void;
  readonly onCropped: (file: File) => void;
}) {
  const t = useT();
  const frame = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [view, setView] = useState<CropView | null>(null);
  const [failed, setFailed] = useState(false);

  const start = () => {
    const element = image.current;
    const box = frame.current?.getBoundingClientRect();
    if (element === null || box === undefined || box.width === 0) return;
    setView(centredView(box.width, box.height, element.naturalWidth, element.naturalHeight));
  };

  // A photo already in the cache fires no load event after its element exists.
  useEffect(() => {
    const element = image.current;
    const box = frame.current?.getBoundingClientRect();
    if (element?.complete !== true || element.naturalWidth === 0 || box === undefined) return;
    setView(centredView(box.width, box.height, element.naturalWidth, element.naturalHeight));
  }, []);

  // The preview is drawn, not styled: the frame is a canvas the photo is painted onto at
  // the current pan and zoom, at the screen's pixel density.
  useEffect(() => {
    const target = canvas.current;
    const element = image.current;
    if (target === null || element === null || view === null) return;
    const density = globalThis.devicePixelRatio || 1;
    target.width = Math.round(view.frameWidth * density);
    target.height = Math.round(view.frameHeight * density);
    const context = target.getContext('2d');
    if (context === null) return;
    const scale = cropScale(view);
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(
      element,
      view.offsetX * density,
      view.offsetY * density,
      view.imageWidth * scale * density,
      view.imageHeight * scale * density,
    );
  }, [view]);

  const pan = (dx: number, dy: number) =>
    setView((current) =>
      current === null
        ? current
        : {
            ...current,
            ...clampOffset({
              ...current,
              offsetX: current.offsetX + dx,
              offsetY: current.offsetY + dy,
            }),
          },
    );

  const save = async () => {
    const element = image.current;
    if (view === null || element === null) return;
    const rect = cropRect(view);
    const canvas = document.createElement('canvas');
    canvas.width = rect.width;
    canvas.height = rect.height;
    const context = canvas.getContext('2d');
    if (context === null) {
      setFailed(true);
      return;
    }
    context.drawImage(element, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, rect.width, rect.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.9),
    );
    if (blob === null) {
      setFailed(true);
      return;
    }
    const name = photo.file.name.replace(/\.[^.]+$/, '') || 'photo';
    onCropped(new File([blob], `${name}-3x4.jpg`, { type: 'image/jpeg' }));
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      title={t('st.photos.cropTitle')}
      description={t('st.photos.cropHelp')}
      closeLabel={t('st.close')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('st.cancel')}
          </Button>
          <Button disabled={view === null} onClick={() => void save()}>
            {t('st.photos.cropSave')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div
          ref={frame}
          tabIndex={0}
          role="application"
          aria-label={t('st.photos.cropFrame')}
          className="relative mx-auto aspect-[3/4] w-64 cursor-move touch-none overflow-hidden rounded-lg border border-border bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          onKeyDown={(event) => {
            const step = event.shiftKey ? 20 : 5;
            const moves: Record<string, [number, number]> = {
              ArrowLeft: [step, 0],
              ArrowRight: [-step, 0],
              ArrowUp: [0, step],
              ArrowDown: [0, -step],
            };
            const delta = moves[event.key];
            if (delta === undefined) return;
            event.preventDefault();
            pan(delta[0], delta[1]);
          }}
          onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
            if (view === null) return;
            event.currentTarget.setPointerCapture(event.pointerId);
            drag.current = {
              x: event.clientX,
              y: event.clientY,
              ox: view.offsetX,
              oy: view.offsetY,
            };
          }}
          onPointerMove={(event) => {
            const from = drag.current;
            if (from === null) return;
            setView((current) =>
              current === null
                ? current
                : {
                    ...current,
                    ...clampOffset({
                      ...current,
                      offsetX: from.ox + event.clientX - from.x,
                      offsetY: from.oy + event.clientY - from.y,
                    }),
                  },
            );
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
        >
          <canvas ref={canvas} aria-hidden="true" className="size-full" />
          <img
            ref={image}
            src={photo.url}
            alt=""
            onLoad={start}
            onError={() => setFailed(true)}
            className="hidden"
          />
        </div>
        <label className="mx-auto flex w-64 items-center gap-3 text-sm">
          {t('st.photos.zoom')}
          <input
            type="range"
            min={1}
            max={4}
            step={0.05}
            value={view?.zoom ?? 1}
            disabled={view === null}
            onChange={(event) =>
              setView((current) =>
                current === null ? current : zoomAboutCentre(current, Number(event.target.value)),
              )
            }
            className="flex-1 accent-primary"
          />
        </label>
        {failed ? (
          <p role="alert" className="text-sm text-destructive">
            {t('st.photos.cropFailed')}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
