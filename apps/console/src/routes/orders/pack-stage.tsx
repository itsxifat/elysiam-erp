import { StatusBadge, cn } from '@elysium/ui';
import { Check, CheckCircle2, Film, Info, Loader2, Tag, VideoOff, XOctagon } from 'lucide-react';
import { useId } from 'react';

import { useT, type ConsoleT } from '../../i18n/locale.js';
import '../../i18n/pack-station.js';
import {
  formatElapsed,
  lotVideoPhase,
  outcomeTone,
  type LotVideoPhase,
  type RecordingFacts,
} from './pack-logic.js';
import './pack-station.css';

/**
 * The parts the packing station and the return station share (M51, D-930 to D-934): what the
 * packer does next, each lot's state and video, the last scan's answer, and the timeline of
 * scans. Built on the stations' own stylesheet, so none of it reaches the first download.
 */

export type StepState = 'done' | 'current' | 'todo';

/** Label → pieces → label again, with the step the packer is on. */
export function StepRail({
  steps,
}: {
  readonly steps: readonly {
    readonly state: StepState;
    readonly title: string;
    readonly detail: string;
  }[];
}) {
  const t = useT();
  return (
    <ol className="ps-steps" aria-label={t('ps.steps.label')} data-testid="pack-steps">
      {steps.map((step, index) => (
        <li
          key={step.title}
          className="ps-step"
          data-state={step.state}
          aria-current={step.state === 'current' ? 'step' : undefined}
        >
          <span className="ps-step-mark" aria-hidden>
            {step.state === 'done' ? <Check className="size-4" /> : String(index + 1)}
          </span>
          <span className="ps-step-text">
            <strong>{step.title}</strong>
            {step.detail}
          </span>
        </li>
      ))}
    </ol>
  );
}

export type LotState = 'done' | 'recording' | 'open' | 'waiting';

/** Each lot (bag): done, being filled and filmed, next, or waiting; its pieces and video. */
export function LotRail({
  lots,
}: {
  readonly lots: readonly {
    readonly lot: number;
    readonly state: LotState;
    readonly pieces: number;
    readonly video: LotVideoPhase | null;
  }[];
}) {
  const t = useT();
  if (lots.length <= 1) return null;
  return (
    <ul className="ps-lots" aria-label={t('ps.lots.label')} data-testid="pack-lot-rail">
      {lots.map((entry) => (
        <li key={entry.lot} className="ps-lot" data-state={entry.state}>
          <span className="ps-lot-dot" aria-hidden />
          <strong>{`${t('ps.stage.lot')} ${String(entry.lot)}`}</strong>
          <span>{`${String(entry.pieces)} ${t('ps.pieces')}`}</span>
          <span className="sr-only">{t(`ps.lots.state.${entry.state}` as ConsoleT)}</span>
          {entry.video === null ? null : <VideoMark phase={entry.video} />}
        </li>
      ))}
    </ul>
  );
}

function VideoMark({ phase }: { readonly phase: LotVideoPhase }) {
  const t = useT();
  const label = t(`ps.lotVideo.${phase}` as ConsoleT);
  const Icon =
    phase === 'saved'
      ? CheckCircle2
      : phase === 'processing'
        ? Loader2
        : phase === 'off'
          ? VideoOff
          : Film;
  return (
    <span title={label} className="inline-flex items-center">
      <Icon aria-hidden className={cn('size-3.5', phase === 'processing' ? 'animate-spin' : '')} />
      <span className="sr-only">{label}</span>
    </span>
  );
}

export type Answer = {
  readonly tone: 'success' | 'danger' | 'neutral' | 'info';
  readonly text: string;
} | null;

/** The last scan's answer, big: green for a piece taken, red (and a buzz) for a refusal. */
export function AnswerBanner({ answer }: { readonly answer: Answer }) {
  if (answer === null) return null;
  const Icon =
    answer.tone === 'danger'
      ? XOctagon
      : answer.tone === 'info'
        ? Tag
        : answer.tone === 'neutral'
          ? Info
          : CheckCircle2;
  return (
    <div
      key={answer.text}
      role={answer.tone === 'danger' ? 'alert' : 'status'}
      data-testid="pack-answer"
      data-tone={answer.tone}
      className={cn(
        'ps-answer flex items-center gap-3 rounded-lg border-2 px-4 py-3 text-base font-semibold',
        answer.tone === 'danger'
          ? 'border-destructive bg-destructive-subtle text-destructive-subtle-foreground'
          : answer.tone === 'success'
            ? 'border-success bg-success-subtle text-success-subtle-foreground'
            : answer.tone === 'info'
              ? 'border-border bg-info-subtle text-info-subtle-foreground'
              : 'border-border bg-muted text-foreground',
      )}
    >
      <Icon aria-hidden className="size-6 shrink-0" />
      <span>{answer.text}</span>
    </div>
  );
}

/** A line's progress, a hairline bar in tenths. */
export function ProgressBar({
  value,
  of,
  state,
}: {
  readonly value: number;
  readonly of: number;
  readonly state: string;
}) {
  const tenths = of <= 0 ? 0 : Math.max(0, Math.min(10, Math.round((value / of) * 10)));
  return (
    <span className="ps-bar" data-state={state} aria-hidden>
      <span data-w={String(tenths)} />
    </span>
  );
}

/** Each lot's video at the station: how long it runs, in how many stretches, and where it is. */
export function LotVideos({
  recordings,
  videos,
  lotCount,
}: {
  readonly recordings: readonly RecordingFacts[];
  readonly videos: readonly { readonly recordingId?: string | null; readonly state: string }[];
  readonly lotCount: number;
}) {
  const t = useT();
  const id = useId();
  if (recordings.length === 0) return null;
  return (
    <section aria-labelledby={id} className="rounded-lg border border-border bg-card">
      <h2 id={id} className="border-b border-border px-4 py-3 text-sm font-semibold tracking-tight">
        {t('ps.lotVideo.title')}
      </h2>
      <ul className="divide-y divide-border" data-testid="pack-lot-videos">
        {recordings.map((recording) => {
          const phase = lotVideoPhase(recording, videos);
          return (
            <li
              key={recording.id}
              className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
              data-phase={phase}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Film aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">
                  {lotCount > 1
                    ? `${t('ps.stage.lot')} ${String(recording.lot)}`
                    : t('ps.lotVideo.one')}
                </span>
              </span>
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground tabular-nums">
                  {formatElapsed(recording.recordedMs)}
                </span>
                <StatusBadge
                  tone={
                    phase === 'saved'
                      ? 'success'
                      : phase === 'recording'
                        ? 'danger'
                        : phase === 'processing'
                          ? 'warning'
                          : 'neutral'
                  }
                >
                  {t(`ps.lotVideo.${phase}` as ConsoleT)}
                </StatusBadge>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Every scan at the table, newest first, with its lot. */
export function ScanTimeline({
  scans,
  lotCount,
}: {
  readonly scans: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string | null;
    readonly variant: string | null;
    readonly outcome: string;
    readonly at: string;
    readonly lot?: number;
  }[];
  readonly lotCount: number;
}) {
  const t = useT();
  const id = useId();
  return (
    <section aria-labelledby={id} className="rounded-lg border border-border bg-card">
      <h2 id={id} className="border-b border-border px-4 py-3 text-sm font-semibold tracking-tight">
        {t('ps.log.title')}
      </h2>
      {scans.length === 0 ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">{t('ps.log.none')}</p>
      ) : (
        <ol className="max-h-80 divide-y divide-border overflow-y-auto" data-testid="pack-log">
          {scans.slice(0, 60).map((entry) => (
            <li key={entry.id} className="space-y-0.5 px-4 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <StatusBadge tone={entry.outcome === 'label' ? 'info' : outcomeTone(entry.outcome)}>
                  {t(`ps.log.${entry.outcome}` as ConsoleT)}
                </StatusBadge>
                <span className="text-muted-foreground tabular-nums">
                  {lotCount > 1 && entry.lot !== undefined
                    ? `${t('ps.stage.lot')} ${String(entry.lot)} · `
                    : ''}
                  {new Date(entry.at).toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka' })}
                </span>
              </div>
              <p className="truncate">
                {entry.name === null ? (
                  <span className="font-mono">{entry.code}</span>
                ) : (
                  `${entry.name}${entry.variant === null || entry.variant === '' ? '' : `, ${entry.variant}`}`
                )}
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
