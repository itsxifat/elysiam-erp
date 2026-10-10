import { StatusBadge } from '@elysium/ui';
import { useEffect, useState } from 'react';

import { useT } from '../../i18n/locale.js';
import '../../i18n/pack-station.js';
import { cameraPreviewUrl } from './pack-station-api.js';

/**
 * The packing table's live view (M38c, D-683): an IP camera's picture, near-live, on the Pack
 * screen whenever the station's source is that camera. Browsers cannot play RTSP, so the
 * camera process writes a small JPEG three times a second and this asks for it every 400 ms
 * (each answer an object URL; the previous one is let go). Asking is what keeps the camera
 * process's preview running; the loop pauses while the tab is hidden.
 */

/** How often the station asks for the camera's newest frame while frames come. */
export const LIVE_PREVIEW_REFRESH_MS = 400;
/**
 * How often it asks while none comes (204, or no answer): enough to keep the preview wanted
 * and to notice it back, without asking 150 times a minute for nothing.
 */
export const LIVE_PREVIEW_IDLE_MS = 3_000;
/** Answers without a frame in a row before the view says the picture is not coming. */
const OFFLINE_AFTER = 3;

export type LiveState = 'waiting' | 'live' | 'offline';

export function CameraLivePreview({
  cameraId,
  label,
}: {
  readonly cameraId: string;
  /** The camera's name, for the picture's accessible label. */
  readonly label: string;
}) {
  const t = useT();
  const [src, setSrc] = useState<string | null>(null);
  const [state, setState] = useState<LiveState>('waiting');

  useEffect(() => {
    let stopped = false;
    let shown: string | null = null;
    let misses = 0;
    let timer: number | undefined;
    let asking = false;
    const url = cameraPreviewUrl(cameraId);

    const tick = async () => {
      timer = undefined;
      if (stopped || asking || document.visibilityState === 'hidden') return;
      asking = true;
      let framed = false;
      try {
        const response = await fetch(url, { credentials: 'include', cache: 'no-store' });
        // 204: no live frame yet (or any more); not an error, just nothing to show.
        if (response.status !== 200) throw new Error(String(response.status));
        const blob = await response.blob();
        if (stopped) return;
        const next = URL.createObjectURL(blob);
        if (shown !== null) URL.revokeObjectURL(shown);
        shown = next;
        misses = 0;
        setSrc(next);
        setState('live');
        framed = true;
      } catch {
        misses += 1;
        if (!stopped && misses >= OFFLINE_AFTER) setState('offline');
      } finally {
        asking = false;
      }
      if (!stopped) {
        timer = window.setTimeout(
          () => void tick(),
          framed ? LIVE_PREVIEW_REFRESH_MS : LIVE_PREVIEW_IDLE_MS,
        );
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && timer === undefined) void tick();
    };
    document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      stopped = true;
      if (timer !== undefined) window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (shown !== null) URL.revokeObjectURL(shown);
    };
  }, [cameraId]);

  return (
    <div
      data-testid="pack-live-preview"
      data-state={state}
      className="relative aspect-video w-full overflow-hidden rounded-md border border-border bg-muted"
    >
      {src !== null && state !== 'offline' ? (
        <img src={src} alt={`${t('ps.live.alt')}: ${label}`} className="size-full object-contain" />
      ) : (
        <p className="flex size-full items-center justify-center p-3 text-center text-xs text-muted-foreground">
          {t(state === 'offline' ? 'ps.live.offline' : 'ps.live.waiting')}
        </p>
      )}
      {state === 'live' ? (
        <span className="absolute top-2 left-2">
          <StatusBadge tone="danger">{t('ps.live.badge')}</StatusBadge>
        </span>
      ) : null}
    </div>
  );
}
