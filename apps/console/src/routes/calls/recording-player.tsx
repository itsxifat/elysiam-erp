import { StatusBadge } from '@elysium/ui';
import { useState } from 'react';

import { ApiError } from '../../api.js';
import type { PhoneCallView } from './api.js';
import { recordingProblem, recordingUrl } from './api.js';
import { useTelT } from './messages.js';

/**
 * A call's recording (M47, D-841, D-858): the browser's own player streaming it from the Calls
 * route, which passes it on from Envo, so it can seek without loading the whole call first.
 * Nothing loads until it is played (`preload="none"`). Only a person who may see the call gets it;
 * when it does not play, a one-byte request asks the server why, and a recording Envo no longer
 * has says so.
 */
export function RecordingPlayer({ call }: { readonly call: PhoneCallView }) {
  const t = useTelT();
  const [problem, setProblem] = useState<{ readonly gone: boolean; readonly message: string }>();

  if (!call.recording.playable) {
    return <StatusBadge tone="neutral">{t('tel.rec.none')}</StatusBadge>;
  }
  if (problem?.gone === true) {
    return <StatusBadge tone="neutral">{t('tel.rec.gone')}</StatusBadge>;
  }
  return (
    <span className="inline-flex flex-col gap-1">
      <audio
        controls
        preload="none"
        src={recordingUrl(call.id)}
        className="h-8 w-full max-w-xs"
        aria-label={t('tel.rec.play')}
        onError={() => {
          void recordingProblem(call.id).then((error) => {
            setProblem({
              gone: error instanceof ApiError && error.code === 'TELEPHONY_RECORDING_UNAVAILABLE',
              message: error instanceof ApiError ? error.message : t('tel.failed'),
            });
          });
        }}
      />
      {problem === undefined ? null : (
        <span role="alert" className="text-xs text-destructive">
          {problem.message}
        </span>
      )}
    </span>
  );
}
