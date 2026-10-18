import { Button, StatusBadge } from '@elysium/ui';
import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ApiError } from '../../api.js';
import type { PhoneCallView } from './api.js';
import { recordingBlob } from './api.js';
import { useTelT } from './messages.js';

/**
 * A call's recording (M47, D-841): fetched on request as a blob from the Calls route, signed in
 * (never a public link), and played in place with the browser's own controls. Only a person who
 * may see the call gets it; the server says why when there is none.
 */
export function RecordingPlayer({ call }: { readonly call: PhoneCallView }) {
  const t = useTelT();
  const [url, setUrl] = useState<string | null>(null);
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(
    () => () => {
      if (url !== null) URL.revokeObjectURL(url);
    },
    [url],
  );

  if (!call.recording.playable) {
    const label =
      call.recording.status === 'pending'
        ? t('tel.rec.pending')
        : call.recording.status === 'expired'
          ? t('tel.rec.expired')
          : call.recording.status === 'failed'
            ? t('tel.rec.failed')
            : t('tel.rec.none');
    return (
      <StatusBadge tone={call.recording.status === 'pending' ? 'info' : 'neutral'}>
        {label}
      </StatusBadge>
    );
  }
  if (url !== null) {
    return (
      <audio
        controls
        autoPlay
        src={url}
        className="h-8 w-full max-w-xs"
        aria-label={t('tel.rec.play')}
      />
    );
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={state === 'loading'}
        onClick={() => {
          setState('loading');
          setProblem(null);
          void recordingBlob(call.id).then(
            (blob) => {
              setUrl(URL.createObjectURL(blob));
              setState('idle');
            },
            (error: unknown) => {
              setProblem(error instanceof ApiError ? error.message : t('tel.failed'));
              setState('error');
            },
          );
        }}
      >
        <Play aria-hidden="true" />
        {state === 'loading' ? t('tel.rec.loading') : t('tel.rec.play')}
      </Button>
      {problem === null ? null : (
        <span role="alert" className="text-xs text-destructive">
          {problem}
        </span>
      )}
    </span>
  );
}
