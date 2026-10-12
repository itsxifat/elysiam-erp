import { Button } from '@elysium/ui';
import { Phone, PhoneIncoming, PhoneMissed, PhoneOff } from 'lucide-react';
import { useState, type ReactNode } from 'react';

import { ApiError } from '../../../api.js';
import { callbackDone, type CallEntry, type MediaAttachment } from './api.js';
import { useVoiceT } from './messages.js';
import { KeptImage, VoicePlayer } from './voice-player.js';
import { clock } from './waveform.js';

/**
 * Whether `InboxAttachment` draws this attachment; when it does not, the thread shows M42's own
 * attachment line (a video, a file, a picture Meta's link still serves).
 */
export function drawsAttachment(attachment: MediaAttachment): boolean {
  if (attachment.type === 'call') return attachment.call !== undefined;
  if (attachment.type !== 'audio' && attachment.type !== 'image') return false;
  const state = attachment.media ?? (attachment.fileId === undefined ? undefined : 'stored');
  if (state === undefined) return false;
  if (attachment.type === 'image') {
    return state === 'pending' || (state === 'stored' && attachment.fileId !== undefined);
  }
  return true;
}

/**
 * How a thread shows M45's attachments (D-780, D-784): a voice message as a player, a kept
 * picture as the picture, and a call as an entry with its outcome and, when missed, the
 * call-back. Anything else gives null, so the thread shows M42's own attachment line.
 */
export function InboxAttachment({
  attachment,
  guard,
  onChanged,
}: {
  readonly attachment: MediaAttachment;
  /** The thread's owner check (D-737), for the call-back on someone else's conversation. */
  readonly guard: (action: (acknowledged: boolean) => Promise<unknown>) => Promise<void>;
  readonly onChanged: () => Promise<void> | void;
}): ReactNode {
  const t = useVoiceT();
  if (attachment.type === 'call' && attachment.call !== undefined) {
    return <CallEntryView call={attachment.call} guard={guard} onChanged={onChanged} />;
  }
  if (attachment.type !== 'audio' && attachment.type !== 'image') return null;
  const state = attachment.media ?? (attachment.fileId === undefined ? undefined : 'stored');
  if (state === undefined) return null;
  if (state === 'pending') {
    return (
      <p className="text-xs text-muted-foreground">
        {attachment.type === 'audio' ? t('voice.player.pending') : t('voice.image.pending')}
      </p>
    );
  }
  if (state === 'failed' || state === 'expired' || attachment.fileId === undefined) {
    // Meta's own link (M42) may still work for a while; the thread's line shows it.
    if (attachment.type === 'image') return null;
    return (
      <p className="text-xs text-muted-foreground">
        {state === 'expired' ? t('voice.player.expired') : t('voice.player.failed')}
      </p>
    );
  }
  if (attachment.type === 'image') {
    return <KeptImage fileId={attachment.fileId} alt={t('voice.image.label')} />;
  }
  const durationMs = Number(attachment.durationMs ?? NaN);
  return (
    <VoicePlayer
      source={{ fileId: attachment.fileId }}
      durationMs={Number.isFinite(durationMs) ? durationMs : undefined}
    />
  );
}

function CallEntryView({
  call,
  guard,
  onChanged,
}: {
  readonly call: CallEntry;
  readonly guard: (action: (acknowledged: boolean) => Promise<unknown>) => Promise<void>;
  readonly onChanged: () => Promise<void> | void;
}) {
  const t = useVoiceT();
  const [error, setError] = useState<string | null>(null);
  const length = clock(call.durationSeconds ?? 0);
  const label =
    call.status === 'completed'
      ? t('voice.event.completed', { length })
      : call.status === 'failed'
        ? t('voice.event.failed', { length })
        : t(`voice.event.${call.status}`);
  const Icon =
    call.status === 'missed'
      ? PhoneMissed
      : call.status === 'declined' || call.status === 'failed'
        ? PhoneOff
        : call.status === 'ringing' || call.status === 'answering'
          ? PhoneIncoming
          : Phone;
  const done = async () => {
    setError(null);
    try {
      await guard(async (acknowledged) => {
        await callbackDone(call.id, acknowledged);
        await onChanged();
      });
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : String(cause));
    }
  };
  return (
    <div className="space-y-1 text-sm">
      <p className="flex items-center gap-2 font-medium">
        <Icon
          aria-hidden
          className={
            call.status === 'missed'
              ? 'size-4 text-destructive-text'
              : 'size-4 text-muted-foreground'
          }
        />
        {label}
      </p>
      {call.answeredBy === null ? null : (
        <p className="text-xs text-muted-foreground">
          {t('voice.event.answeredBy', { name: call.answeredBy.name ?? '' })}
        </p>
      )}
      {call.declinedBy === null ? null : (
        <p className="text-xs text-muted-foreground">
          {t('voice.event.declinedBy', { name: call.declinedBy.name ?? '' })}
        </p>
      )}
      {call.callbackNeeded ? (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {call.callbackPhone === null ? (
            <span className="text-xs font-medium">{t('voice.event.callBack')}</span>
          ) : (
            <a
              href={`tel:${call.callbackPhone}`}
              className="text-xs font-medium underline underline-offset-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              {t('voice.event.callBackPhone', { phone: call.callbackPhone })}
            </a>
          )}
          <Button size="sm" variant="outline" onClick={() => void done()}>
            {t('voice.event.callBackDone')}
          </Button>
        </div>
      ) : call.callbackDoneBy === null ? null : (
        <p className="text-xs text-muted-foreground">
          {t('voice.event.callBackDoneBy', { name: call.callbackDoneBy.name ?? '' })}
        </p>
      )}
      {error === null ? null : (
        <p role="alert" className="text-xs text-destructive-text">
          {error}
        </p>
      )}
    </div>
  );
}
