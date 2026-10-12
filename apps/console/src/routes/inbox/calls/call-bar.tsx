import { Button, Monogram, StatusBadge, cn } from '@elysium/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { MessageSquare, Mic, MicOff, Phone, PhoneOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { ApiError } from '../../../api.js';
import { useAbility, useSession } from '../../../auth/session.js';
import { useRealtime } from '../../../realtime/use-realtime.js';
import {
  answerCall,
  CALLS_KEY,
  claimCall,
  declineCall,
  hangUpCall,
  liveCalls,
  releaseCall,
  type LiveCall,
} from '../voice/api.js';
import { useVoiceT } from '../voice/messages.js';
import { clock } from '../voice/waveform.js';
import { createRingSound, type RingSound } from './ring-sound.js';
import {
  answerOffer,
  applyAnswer,
  closeMedia,
  connected,
  makeOffer,
  openMicrophone,
  setMicrophone,
  type CallMedia,
} from './webrtc.js';

/**
 * The call bar (M45, D-785 to D-787): loaded after the shell paints, for people who answer the
 * inbox. A call ringing for you is a full-width bar across the top of every screen with the
 * caller's name and channel, Answer and Decline, and a ring; answering it picks it up for you
 * alone (a colleague who clicked too is told), opens the microphone and connects your browser to
 * Meta over WebRTC; then the bar shows the call's clock, Mute and Hang up.
 *
 * The socket only says "look again"; what is ringing is always fetched (`GET /v1/inbox/calls/live`),
 * and fetched every few seconds while anything rings, so a dropped socket does not hide a call.
 */

const CALL_EVENTS = ['inbox.call_ringing', 'inbox.call_changed'] as const;

export function CallBar() {
  const ability = useAbility();
  const session = useSession();
  if (session.context === null || !ability.can('update', 'Conversation')) return null;
  return <Bar />;
}

type Phase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'connecting'; readonly callId: string; readonly since: number }
  | { readonly kind: 'on_call'; readonly callId: string; readonly since: number };

function Bar() {
  const t = useVoiceT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [notice, setNotice] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const media = useRef<CallMedia | null>(null);
  const remote = useRef<HTMLAudioElement>(null);
  const ring = useRef<RingSound | null>(null);
  const endedText = useRef(t('voice.call.ended'));

  useRealtime({
    events: CALL_EVENTS,
    onEvent: () => void queryClient.invalidateQueries({ queryKey: CALLS_KEY }),
  });
  const phaseNow = useRef<Phase>(phase);
  useEffect(() => {
    phaseNow.current = phase;
  }, [phase]);
  const live = useQuery({
    queryKey: CALLS_KEY,
    queryFn: async () => {
      const asked = Date.now();
      const answer = await liveCalls();
      // The call ended elsewhere (the caller hung up, Meta ended it): let the microphone go. Only
      // an answer asked for after this call was picked up can say so.
      const on = phaseNow.current;
      if (
        on.kind !== 'idle' &&
        asked > on.since &&
        !answer.items.some((call) => call.id === on.callId && call.mine)
      ) {
        closeMedia(media.current);
        media.current = null;
        phaseNow.current = { kind: 'idle' };
        setPhase({ kind: 'idle' });
        setMuted(false);
        setNotice(endedText.current);
      }
      return answer;
    },
    refetchInterval: (query) => ((query.state.data?.items.length ?? 0) > 0 ? 3_000 : 20_000),
  });
  const items = live.data?.items ?? [];
  const ringing = items.filter((call) => call.ringingForMe);
  const current =
    phase.kind === 'idle' ? null : (items.find((call) => call.id === phase.callId) ?? null);
  const shown = current ?? ringing[0] ?? null;

  // The ring: while something rings for me and I am not on a call.
  const shouldRing = phase.kind === 'idle' && ringing.length > 0;
  useEffect(() => {
    ring.current ??= createRingSound();
    if (shouldRing) ring.current.start();
    else ring.current.stop();
  }, [shouldRing]);
  useEffect(() => () => ring.current?.stop(), []);

  // The clock on a call.
  const onCall = phase.kind === 'on_call';
  useEffect(() => {
    if (!onCall) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [onCall]);

  // Let go of the microphone if the page goes away mid-call.
  useEffect(
    () => () => {
      closeMedia(media.current);
      media.current = null;
    },
    [],
  );

  const refresh = () => void queryClient.invalidateQueries({ queryKey: CALLS_KEY });
  const say = (error: unknown, fallback: string) =>
    setNotice(error instanceof ApiError && error.message !== '' ? error.message : fallback);

  const answer = async (call: LiveCall) => {
    setNotice(null);
    let claimed: LiveCall;
    try {
      claimed = await claimCall(call.id);
    } catch (error) {
      say(error, t('voice.call.failed'));
      refresh();
      return;
    }
    const since = Date.now();
    phaseNow.current = { kind: 'connecting', callId: call.id, since };
    setPhase({ kind: 'connecting', callId: call.id, since });
    let microphone: MediaStream;
    try {
      microphone = await openMicrophone();
    } catch {
      await releaseCall(call.id).catch(() => undefined);
      setPhase({ kind: 'idle' });
      setNotice(t('voice.call.noMic'));
      refresh();
      return;
    }
    const hear = (stream: MediaStream) => {
      if (remote.current !== null) remote.current.srcObject = stream;
    };
    let accepted = false;
    try {
      if (claimed.channel === 'whatsapp') {
        const offer = claimed.offerSdp ?? '';
        const session = await answerOffer(offer, microphone, hear);
        media.current = session;
        await answerCall(call.id, { step: 'pre_accept', sdp: session.sdp });
        await connected(session.pc);
        await answerCall(call.id, { step: 'accept', sdp: session.sdp });
        accepted = true;
      } else {
        const session = await makeOffer(microphone, hear);
        media.current = session;
        const result = await answerCall(call.id, { step: 'accept', sdp: session.sdp });
        accepted = true;
        if (result.sdpAnswer !== null) {
          await applyAnswer(session.pc, result.sdpAnswer, result.sdpRenegotiation);
        }
      }
      // Meta said 200: the microphone may speak now.
      if (media.current !== null) setMicrophone(media.current, true);
      setMuted(false);
      setPhase({ kind: 'on_call', callId: call.id, since: Date.now() });
      setNow(Date.now());
    } catch (error) {
      closeMedia(media.current);
      media.current = null;
      if (accepted) await hangUpCall(call.id).catch(() => undefined);
      else await releaseCall(call.id).catch(() => undefined);
      setPhase({ kind: 'idle' });
      say(error, t('voice.call.failed'));
    }
    refresh();
  };

  const decline = async (call: LiveCall) => {
    setNotice(null);
    try {
      await declineCall(call.id);
    } catch (error) {
      say(error, t('voice.call.failed'));
    }
    refresh();
  };

  const hangUp = async () => {
    if (phase.kind === 'idle') return;
    const callId = phase.callId;
    closeMedia(media.current);
    media.current = null;
    setPhase({ kind: 'idle' });
    setMuted(false);
    await hangUpCall(callId).catch(() => undefined);
    refresh();
  };

  const toggleMute = () => {
    if (media.current === null) return;
    setMicrophone(media.current, muted);
    setMuted(!muted);
  };

  const open = (conversationId: string) =>
    void navigate({ to: '/inbox', search: { c: conversationId } as never });

  if (shown === null && notice === null) return <audio ref={remote} autoPlay className="hidden" />;

  const name = shown?.contact.name ?? t('voice.call.unknown');
  const channel = shown === null ? '' : t(`voice.call.channel.${shown.channel}`);
  return (
    <>
      <audio ref={remote} autoPlay className="hidden" />
      <div
        role="region"
        aria-label={t('voice.call.incoming')}
        className={cn(
          'fixed inset-x-0 top-0 z-50 border-b border-border bg-card shadow-popover',
          'motion-safe:animate-in',
        )}
      >
        {shown === null ? null : (
          <div className="mx-auto flex max-w-screen-xl flex-wrap items-center gap-3 px-4 py-3">
            <Monogram name={name} size="md" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold" aria-live="assertive">
                {phase.kind === 'on_call'
                  ? t('voice.call.onCall', { name })
                  : t('voice.call.incomingFrom', { channel, name })}
              </p>
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <StatusBadge tone="neutral">{channel}</StatusBadge>
                {phase.kind === 'connecting' ? t('voice.call.connecting') : null}
                {phase.kind === 'on_call' ? (
                  <span className="tabular-nums">{clock((now - phase.since) / 1000)}</span>
                ) : null}
              </p>
            </div>
            <Button size="sm" variant="ghost" onClick={() => open(shown.conversationId)}>
              <MessageSquare aria-hidden className="size-4" />
              {t('voice.call.open')}
            </Button>
            {phase.kind === 'idle' ? (
              <>
                <Button size="sm" variant="outline" onClick={() => void decline(shown)}>
                  <PhoneOff aria-hidden className="size-4" />
                  {t('voice.call.decline')}
                </Button>
                <Button size="sm" onClick={() => void answer(shown)}>
                  <Phone aria-hidden className="size-4" />
                  {t('voice.call.answer')}
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  aria-pressed={muted}
                  disabled={phase.kind !== 'on_call'}
                  onClick={toggleMute}
                >
                  {muted ? (
                    <MicOff aria-hidden className="size-4" />
                  ) : (
                    <Mic aria-hidden className="size-4" />
                  )}
                  {muted ? t('voice.call.unmute') : t('voice.call.mute')}
                </Button>
                <Button size="sm" variant="destructive" onClick={() => void hangUp()}>
                  <PhoneOff aria-hidden className="size-4" />
                  {t('voice.call.hangUp')}
                </Button>
              </>
            )}
          </div>
        )}
        {notice === null ? null : (
          <p
            role="status"
            className="mx-auto flex max-w-screen-xl items-center justify-between gap-3 px-4 pb-2 text-sm text-muted-foreground"
          >
            {notice}
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t('voice.call.dismiss')}
              onClick={() => setNotice(null)}
            >
              <X aria-hidden className="size-4" />
            </Button>
          </p>
        )}
      </div>
    </>
  );
}
