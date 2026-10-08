import { Button, DateTime, StatusBadge } from '@elysium/ui';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useId, useState, type SyntheticEvent } from 'react';

import { ApiError } from '../../api.js';
import { useT, type ConsoleT } from '../../i18n/locale.js';
import '../../i18n/pack-station.js';
import { VIDEO_TONE, formatElapsed, formatMegabytes, outcomeTone } from './pack-logic.js';
import { orderPacking, videoUrl, type PackVideoPart, type PackView } from './pack-station-api.js';

/**
 * The order page's packing record (M38b, D-610, D-611): who packed it and when, every scan at
 * the table (refusals included), and the packing video for whoever handles a complaint. The
 * video plays from a short-lived signed address, asked for only when someone presses Play;
 * a role without `read PackingVideo` sees that a video exists, not the video. Shown only for an
 * order that went through the packing station.
 */
export function PackingPanel({ orderId }: { readonly orderId: string }) {
  const t = useT();
  const id = useId();
  const [showAll, setShowAll] = useState(false);
  const query = useQuery({
    queryKey: ['packing', 'order-page', orderId],
    queryFn: () => orderPacking(orderId),
  });
  const data = query.data;
  if (data === undefined) return null;
  if (data.session === null) return null;
  const view = data;
  const scans = showAll ? view.scans : view.scans.slice(0, 6);
  const packer = view.session.completedBy ?? view.session.startedBy;

  return (
    <section
      aria-labelledby={id}
      data-testid="packing-panel"
      className="space-y-4 rounded-lg border border-border bg-card p-5 text-sm"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id={id} className="text-base font-semibold tracking-tight">
          {t('ps.panel.title')}
        </h2>
        <StatusBadge tone={view.session.status === 'completed' ? 'success' : 'info'}>
          {t(`ps.session.${view.session.status}`)}
        </StatusBadge>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">
          {view.session.status === 'completed' ? t('ps.panel.packedBy') : t('ps.panel.startedBy')}
        </dt>
        <dd>{packer.name ?? '—'}</dd>
        <dt className="text-muted-foreground">{t('ps.panel.started')}</dt>
        <dd>
          <DateTime value={view.session.startedAt} />
        </dd>
        <dt className="text-muted-foreground">{t('ps.panel.finished')}</dt>
        <dd>
          {view.session.completedAt === null ? (
            t('ps.panel.open')
          ) : (
            <DateTime value={view.session.completedAt} />
          )}
        </dd>
      </dl>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-muted-foreground">{t('ps.panel.video')}</h3>
          <StatusBadge tone={VIDEO_TONE[view.video]}>
            {t(`ps.video.state.${view.video}`)}
          </StatusBadge>
        </div>
        <VideoNote view={view} />
        <ul className="space-y-3">
          {view.videos.map((part) => (
            <li key={part.id}>
              <VideoPart part={part} canPlay={view.canPlay} />
            </li>
          ))}
        </ul>
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t('ps.log.title')}</h3>
        {view.scans.length === 0 ? (
          <p className="text-muted-foreground">{t('ps.log.none')}</p>
        ) : (
          <ol className="divide-y divide-border" data-testid="packing-panel-log">
            {scans.map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-2 py-1.5">
                <span className="min-w-0">
                  <StatusBadge tone={outcomeTone(entry.outcome)}>
                    {t(`ps.log.${entry.outcome}` as ConsoleT)}
                  </StatusBadge>
                  <span className="ml-2 break-words">
                    {entry.name === null
                      ? entry.code
                      : `${entry.name}${entry.variant === null || entry.variant === '' ? '' : `, ${entry.variant}`}`}
                  </span>
                </span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  <DateTime value={entry.at} compact />
                </span>
              </li>
            ))}
          </ol>
        )}
        {view.scans.length > 6 && !showAll ? (
          <Button size="sm" variant="ghost" onClick={() => setShowAll(true)}>
            {t('ps.panel.showLog')}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

function VideoNote({ view }: { readonly view: PackView & { canPlay: boolean } }) {
  const t = useT();
  const note =
    view.video === 'off'
      ? t('ps.panel.off')
      : view.video === 'missing'
        ? t('ps.panel.missing')
        : view.video === 'pending'
          ? (view.session.cameraId ?? null) !== null && (view.session.recordingTo ?? null) !== null
            ? t('ps.panel.cutting')
            : t('ps.panel.waiting')
          : view.video === 'deleted'
            ? t('ps.panel.gone')
            : !view.canPlay
              ? t('ps.panel.noAccess')
              : null;
  return note === null ? null : <p className="text-muted-foreground">{note}</p>;
}

/**
 * A WebM written by a browser's recorder carries no duration, so the player cannot show its
 * length or seek until it is told to look: jump far ahead once, and come back to the start.
 */
function settleDuration(event: SyntheticEvent<HTMLVideoElement>): void {
  const video = event.currentTarget;
  if (Number.isFinite(video.duration)) return;
  const back = () => {
    video.removeEventListener('durationchange', back);
    video.currentTime = 0;
  };
  video.addEventListener('durationchange', back);
  video.currentTime = Number.MAX_SAFE_INTEGER;
}

function VideoPart({ part, canPlay }: { readonly part: PackVideoPart; readonly canPlay: boolean }) {
  const t = useT();
  const play = useMutation({ mutationFn: () => videoUrl(part.id) });
  const facts = [
    `${t('ps.panel.part')} ${String(part.part)}`,
    part.source === 'camera' ? t('ps.panel.camera') : null,
    part.durationMs === null ? null : formatElapsed(part.durationMs),
    part.sizeBytes === null ? null : formatMegabytes(part.sizeBytes),
  ].filter((fact): fact is string => fact !== null);
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="tabular-nums">{facts.join(' · ')}</span>
        {canPlay && part.state === 'uploaded' && play.data === undefined ? (
          <Button
            size="sm"
            variant="outline"
            disabled={play.isPending}
            onClick={() => play.mutate()}
          >
            <Play aria-hidden />
            {play.isPending ? t('ps.panel.loadingVideo') : t('ps.panel.play')}
          </Button>
        ) : null}
      </div>
      {play.error === null ? null : (
        <p role="alert" className="text-destructive-text">
          {play.error instanceof ApiError ? play.error.message : t('ps.failed')}
        </p>
      )}
      {play.data === undefined ? null : (
        <video
          src={play.data.url}
          controls
          autoPlay
          playsInline
          preload="metadata"
          data-testid="packing-video"
          aria-label={`${t('ps.panel.video')} · ${t('ps.panel.part')} ${String(part.part)}`}
          onLoadedMetadata={settleDuration}
          className="aspect-video w-full rounded-md border border-border bg-muted"
        />
      )}
    </div>
  );
}
