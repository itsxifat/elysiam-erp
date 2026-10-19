import { Button } from '@elysium/ui';
import { Mic, Send, Square, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { sendVoice, uploadRecording } from './api.js';
import { useVoiceT } from './messages.js';
import { VoicePlayer } from './voice-player.js';
import { clock } from './waveform.js';

/**
 * The composer's voice message (M45, D-781): click to record, click to stop (it stops by itself
 * at two minutes), hear it back, then send or discard. Recorded by the browser's MediaRecorder
 * (WebM/Opus in Chrome and Firefox, MP4/AAC in Safari); the server converts it to each channel's
 * format. The microphone is released the moment recording stops.
 */

export const MAX_RECORDING_MS = 120_000;
export const MIN_RECORDING_MS = 500;

const PREFERRED = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4', 'audio/webm'];

function recorderType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return PREFERRED.find((type) => MediaRecorder.isTypeSupported(type)) ?? '';
}

type State =
  | { readonly kind: 'idle' }
  | { readonly kind: 'recording'; readonly startedAt: number }
  | { readonly kind: 'preview'; readonly blob: Blob; readonly durationMs: number }
  | { readonly kind: 'sending'; readonly blob: Blob; readonly durationMs: number };

export function VoiceRecorder({
  disabled,
  onSend,
  onError,
}: {
  readonly disabled: boolean;
  /** Upload and send; resolves once the message is queued (or the owner question is asked). */
  readonly onSend: (blob: Blob, durationMs: number) => Promise<void>;
  readonly onError: (message: string) => void;
}) {
  const t = useVoiceT();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);

  const release = () => {
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
  };

  // Let go of the microphone if the conversation closes mid-recording.
  useEffect(
    () => () => {
      if (recorder.current?.state === 'recording') recorder.current.stop();
      release();
    },
    [],
  );

  const recording = state.kind === 'recording';
  useEffect(() => {
    if (!recording) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 200);
    return () => window.clearInterval(timer);
  }, [recording]);

  const stop = () => {
    if (recorder.current?.state === 'recording') recorder.current.stop();
  };

  useEffect(() => {
    if (state.kind === 'recording' && now - state.startedAt >= MAX_RECORDING_MS) stop();
  }, [now, state]);

  const start = async () => {
    const type = recorderType();
    if (type === null || navigator.mediaDevices?.getUserMedia === undefined) {
      onError(t('voice.record.unsupported'));
      return;
    }
    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
      });
    } catch {
      onError(t('voice.record.noMic'));
      return;
    }
    stream.current = media;
    const chunks: Blob[] = [];
    const next = new MediaRecorder(media, {
      ...(type === '' ? {} : { mimeType: type }),
      audioBitsPerSecond: 32_000,
    });
    const startedAt = Date.now();
    next.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    next.onstop = () => {
      release();
      const durationMs = Math.min(MAX_RECORDING_MS, Date.now() - startedAt);
      const blob = new Blob(chunks, { type: next.mimeType || type || 'audio/webm' });
      if (durationMs < MIN_RECORDING_MS || blob.size === 0) {
        onError(t('voice.record.tooShort'));
        setState({ kind: 'idle' });
        return;
      }
      setState({ kind: 'preview', blob, durationMs });
    };
    recorder.current = next;
    next.start(1_000);
    setNow(startedAt);
    setState({ kind: 'recording', startedAt });
  };

  const send = async () => {
    if (state.kind !== 'preview') return;
    setState({ kind: 'sending', blob: state.blob, durationMs: state.durationMs });
    try {
      await onSend(state.blob, state.durationMs);
      setState({ kind: 'idle' });
    } catch (error) {
      onError(
        error instanceof Error && error.message !== '' ? error.message : t('voice.record.failed'),
      );
      setState({ kind: 'preview', blob: state.blob, durationMs: state.durationMs });
    }
  };

  if (state.kind === 'idle') {
    return (
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="rounded-full"
        disabled={disabled}
        aria-label={t('voice.record.start')}
        title={t('voice.record.limit')}
        onClick={() => void start()}
      >
        <Mic aria-hidden className="size-4" />
      </Button>
    );
  }

  if (state.kind === 'recording') {
    const elapsed = Math.max(0, now - state.startedAt);
    return (
      <div className="flex items-center gap-2" role="status" aria-live="polite">
        <span aria-hidden className="size-2 animate-pulse rounded-full bg-destructive" />
        <span className="text-sm tabular-nums">
          {t('voice.record.recording', { length: clock(elapsed / 1000) })}
        </span>
        <Button type="button" size="sm" variant="outline" onClick={stop}>
          <Square aria-hidden className="size-4" />
          {t('voice.record.stop')}
        </Button>
      </div>
    );
  }

  const busy = state.kind === 'sending';
  return (
    <div className="flex flex-wrap items-center gap-2" aria-label={t('voice.record.preview')}>
      <VoicePlayer source={{ blob: state.blob }} durationMs={state.durationMs} className="flex-1" />
      <Button
        type="button"
        size="icon"
        variant="ghost"
        disabled={busy}
        aria-label={t('voice.record.discard')}
        onClick={() => setState({ kind: 'idle' })}
      >
        <Trash2 aria-hidden className="size-4" />
      </Button>
      <Button type="button" disabled={busy} onClick={() => void send()}>
        <Send aria-hidden className="size-4" />
        {busy ? t('voice.record.sending') : t('voice.record.send')}
      </Button>
    </div>
  );
}

/**
 * The recorder as the thread's composer uses it: the recording uploaded first (a private
 * `inbox-media` file), then sent through the owner check (D-737) like a typed reply.
 */
export function ComposerVoice({
  conversationId,
  guard,
  disabled,
  onSent,
  onError,
}: {
  readonly conversationId: string;
  readonly guard: (action: (acknowledged: boolean) => Promise<unknown>) => Promise<void>;
  readonly disabled: boolean;
  readonly onSent: () => Promise<void> | void;
  readonly onError: (message: string) => void;
}) {
  return (
    <VoiceRecorder
      disabled={disabled}
      onError={onError}
      onSend={async (blob, durationMs) => {
        const fileId = await uploadRecording(blob);
        await guard(async (acknowledged) => {
          await sendVoice(
            conversationId,
            { id: crypto.randomUUID(), fileId, durationMs },
            acknowledged,
          );
          await onSent();
        });
      }}
    />
  );
}
