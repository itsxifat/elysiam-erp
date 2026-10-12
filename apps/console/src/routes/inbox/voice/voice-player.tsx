import { Button, cn } from '@elysium/ui';
import { useQuery } from '@tanstack/react-query';
import { Pause, Play } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';

import { fetchMedia } from './api.js';
import { useVoiceT } from './messages.js';
import { clock, nextSpeed, peaks, seekFraction, type Speed } from './waveform.js';

/**
 * A voice message's player (M45, D-780): play and pause, a waveform that is also the progress
 * bar (click or arrow keys to move through it), the position and length in tabular numerals, and
 * the speed (1×, 1.5×, 2×). The waveform is computed here from the decoded audio; a clip the
 * browser cannot decode still plays, with a flat line.
 *
 * The bytes come from the inbox's own media route as a blob (signed in, never a public link), or
 * straight from the recorder for a preview.
 */

const BARS = 40;

/** A bar's height in tenths, as classes the design system's Tailwind build can see. */
const HEIGHTS = [
  'h-[8%]',
  'h-[10%]',
  'h-[20%]',
  'h-[30%]',
  'h-[40%]',
  'h-[50%]',
  'h-[60%]',
  'h-[70%]',
  'h-[80%]',
  'h-[90%]',
  'h-full',
] as const;

type AudioContextClass = typeof AudioContext;

function audioContextClass(): AudioContextClass | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextClass;
    webkitAudioContext?: AudioContextClass;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** The waveform and length of a clip, decoded once. Null while it decodes or when it cannot. */
function useDecoded(blob: Blob | null): { bars: number[]; seconds: number } | null {
  const [decoded, setDecoded] = useState<{ bars: number[]; seconds: number } | null>(null);
  useEffect(() => {
    if (blob === null) return;
    const Context = audioContextClass();
    if (Context === null) return;
    let live = true;
    const context = new Context();
    void blob
      .arrayBuffer()
      .then((buffer) => context.decodeAudioData(buffer))
      .then((audio) => {
        if (live)
          setDecoded({ bars: peaks(audio.getChannelData(0), BARS), seconds: audio.duration });
      })
      .catch(() => undefined)
      .finally(() => void context.close().catch(() => undefined));
    return () => {
      live = false;
    };
  }, [blob]);
  return decoded;
}

export function VoicePlayer({
  source,
  durationMs,
  className,
}: {
  readonly source: { readonly fileId: string } | { readonly blob: Blob };
  /** The length the server knows (a recording's), shown before the clip decodes. */
  readonly durationMs?: number | undefined;
  readonly className?: string;
}) {
  const t = useVoiceT();
  const fileId = 'fileId' in source ? source.fileId : null;
  const fetched = useQuery({
    queryKey: ['inbox', 'media', fileId],
    queryFn: ({ signal }) => fetchMedia(fileId ?? '', signal),
    enabled: fileId !== null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: 1,
  });
  const blob = 'blob' in source ? source.blob : (fetched.data ?? null);
  const decoded = useDecoded(blob);
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [elementSeconds, setElementSeconds] = useState(0);
  const [speed, setSpeed] = useState<Speed>(1);
  const [failed, setFailed] = useState(false);

  // The element plays the blob through an object URL, made here and let go with the blob.
  useEffect(() => {
    const audio = audioRef.current;
    if (blob === null || audio === null) return;
    const url = URL.createObjectURL(blob);
    audio.src = url;
    return () => {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
    };
  }, [blob]);

  useEffect(() => {
    if (audioRef.current !== null) audioRef.current.playbackRate = speed;
  }, [speed, blob]);

  const seconds =
    decoded?.seconds ??
    (Number.isFinite(elementSeconds) && elementSeconds > 0
      ? elementSeconds
      : (Number(durationMs ?? 0) || 0) / 1000);
  const bars = decoded?.bars ?? new Array<number>(BARS).fill(0.3);
  const played = seconds > 0 ? position / seconds : 0;

  const toggle = () => {
    const audio = audioRef.current;
    if (audio === null) return;
    if (audio.paused) {
      void audio.play().catch(() => setFailed(true));
    } else {
      audio.pause();
    }
  };
  const seekTo = (fraction: number) => {
    const audio = audioRef.current;
    if (audio === null || !(seconds > 0)) return;
    audio.currentTime = fraction * seconds;
    setPosition(audio.currentTime);
  };
  const onClick = (event: MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    seekTo(seekFraction(event.clientX - box.left, box.width));
  };
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = 5 / Math.max(seconds, 1);
    const keys: Record<string, number> = {
      ArrowRight: played + step,
      ArrowUp: played + step,
      ArrowLeft: played - step,
      ArrowDown: played - step,
      Home: 0,
      End: 1,
    };
    const next = keys[event.key];
    if (next === undefined) return;
    event.preventDefault();
    seekTo(Math.min(1, Math.max(0, next)));
  };

  if (fetched.isError || failed) {
    return <p className="text-xs text-muted-foreground">{t('voice.player.error')}</p>;
  }
  const ready = blob !== null;

  return (
    <div
      className={cn('flex min-w-56 items-center gap-2', className)}
      role="group"
      aria-label={t('voice.player.label', { length: clock(seconds) })}
    >
      <Button
        type="button"
        size="icon-sm"
        variant="secondary"
        className="shrink-0 rounded-full"
        disabled={!ready}
        aria-label={playing ? t('voice.player.pause') : t('voice.player.play')}
        onClick={toggle}
      >
        {playing ? (
          <Pause aria-hidden className="size-4" />
        ) : (
          <Play aria-hidden className="size-4" />
        )}
      </Button>
      <div
        role="slider"
        tabIndex={ready ? 0 : -1}
        aria-label={t('voice.player.position')}
        aria-valuemin={0}
        aria-valuemax={Math.round(seconds)}
        aria-valuenow={Math.round(position)}
        aria-valuetext={`${clock(position)} / ${clock(seconds)}`}
        aria-busy={!ready}
        onClick={onClick}
        onKeyDown={onKey}
        className="flex h-8 flex-1 cursor-pointer items-center gap-px rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {bars.map((height, index) => (
          <span
            key={index}
            aria-hidden
            className={cn(
              'w-full min-w-0.5 flex-1 rounded-full',
              HEIGHTS[Math.min(HEIGHTS.length - 1, Math.round(height * (HEIGHTS.length - 1)))],
              index / bars.length < played ? 'bg-primary' : 'bg-border',
            )}
          />
        ))}
      </div>
      <span className="w-20 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {ready ? `${clock(position)} / ${clock(seconds)}` : t('voice.player.loading')}
      </span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="shrink-0 px-2 text-xs tabular-nums"
        aria-label={t('voice.player.speed', { speed: `${String(speed)}×` })}
        onClick={() => setSpeed((current) => nextSpeed(current))}
      >
        {`${String(speed)}×`}
      </Button>
      <audio
        ref={audioRef}
        preload="metadata"
        className="hidden"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setPosition(0);
        }}
        onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
        onLoadedMetadata={(event) => setElementSeconds(event.currentTarget.duration)}
        onError={(event) => {
          if (event.currentTarget.getAttribute('src') !== null) setFailed(true);
        }}
      />
    </div>
  );
}

/** A picture the customer sent, kept and shown from the inbox's media route. */
export function KeptImage({ fileId, alt }: { readonly fileId: string; readonly alt: string }) {
  const t = useVoiceT();
  const fetched = useQuery({
    queryKey: ['inbox', 'media', fileId],
    queryFn: ({ signal }) => fetchMedia(fileId, signal),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 10 * 60_000,
    retry: 1,
  });
  const link = useRef<HTMLAnchorElement>(null);
  const image = useRef<HTMLImageElement>(null);
  // Shown through an object URL, made here and let go with the bytes.
  useEffect(() => {
    if (fetched.data === undefined || link.current === null || image.current === null) return;
    const url = URL.createObjectURL(fetched.data);
    link.current.href = url;
    image.current.src = url;
    return () => URL.revokeObjectURL(url);
  }, [fetched.data]);
  if (fetched.isError) {
    return <p className="text-xs text-muted-foreground">{t('voice.image.failed')}</p>;
  }
  if (fetched.data === undefined) {
    return (
      <div
        className="h-32 w-48 rounded-md bg-muted motion-safe:animate-pulse"
        aria-label={t('voice.image.pending')}
      />
    );
  }
  return (
    <a
      ref={link}
      target="_blank"
      rel="noreferrer noopener"
      className="block rounded-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <img ref={image} alt={alt} className="max-h-60 max-w-full rounded-md border border-border" />
    </a>
  );
}
