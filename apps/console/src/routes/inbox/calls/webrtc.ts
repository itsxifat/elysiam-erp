/**
 * Answering a call in the browser over WebRTC (M45, D-787), as Meta's calling pages describe:
 *
 * - **WhatsApp** gives an SDP offer in its connect webhook. "For a consumer to business call …
 *   the WebRTC agent within the browser should generate an SDP answer, not an offer. This SDP
 *   answer should be supplied back to us using the accept call endpoint" (Calling FAQ). Meta's
 *   side is ICE-lite with public relay addresses and takes the controlled role, so the browser's
 *   full ICE agent needs no STUN or TURN server of ours: it starts the checks from where it is.
 *   Media must not flow before Meta's 200 to `accept`, so the microphone stays muted until then.
 * - **Messenger** gives no offer: the business sends its own with `accept` and receives Meta's
 *   answer (and maybe a renegotiation offer to apply after it).
 *
 * The SDP is sent whole (no trickle): the browser waits for its candidates to be gathered first.
 */

export interface CallMedia {
  readonly pc: RTCPeerConnection;
  readonly microphone: MediaStream;
  /** The browser's session description, to send to Meta through the server. */
  readonly sdp: string;
}

export async function openMicrophone(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
}

/** Wait until ICE has gathered every candidate it will, or `timeoutMs`, whichever is first. */
export function gathered(pc: RTCPeerConnection, timeoutMs = 3_000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const done = () => {
      window.clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const timer = window.setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

/** Wait until the media path is up (or `timeoutMs`): Meta accepts best once ICE has connected. */
export function connected(pc: RTCPeerConnection, timeoutMs = 8_000): Promise<boolean> {
  const up = () => pc.connectionState === 'connected' || pc.iceConnectionState === 'connected';
  if (up()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const check = () => {
      if (up()) finish(true);
      else if (pc.connectionState === 'failed') finish(false);
    };
    const finish = (value: boolean) => {
      window.clearTimeout(timer);
      pc.removeEventListener('connectionstatechange', check);
      pc.removeEventListener('iceconnectionstatechange', check);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(up()), timeoutMs);
    pc.addEventListener('connectionstatechange', check);
    pc.addEventListener('iceconnectionstatechange', check);
  });
}

function peer(microphone: MediaStream, onRemote: (stream: MediaStream) => void): RTCPeerConnection {
  // One audio stream and one track, as WhatsApp requires; bundled, so one transport.
  const pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
  for (const track of microphone.getAudioTracks()) {
    // Silent until Meta has accepted (D-787): early audio would be cut off on the other end.
    track.enabled = false;
    pc.addTrack(track, microphone);
  }
  pc.ontrack = (event) => {
    onRemote(event.streams[0] ?? new MediaStream([event.track]));
  };
  return pc;
}

/** WhatsApp: answer Meta's offer. */
export async function answerOffer(
  offerSdp: string,
  microphone: MediaStream,
  onRemote: (stream: MediaStream) => void,
): Promise<CallMedia> {
  const pc = peer(microphone, onRemote);
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc);
  return { pc, microphone, sdp: pc.localDescription?.sdp ?? '' };
}

/** Messenger: make the offer Meta answers. */
export async function makeOffer(
  microphone: MediaStream,
  onRemote: (stream: MediaStream) => void,
): Promise<CallMedia> {
  const pc = peer(microphone, onRemote);
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc);
  return { pc, microphone, sdp: pc.localDescription?.sdp ?? '' };
}

/** Messenger: apply Meta's answer, then its renegotiation offer when it sent one. */
export async function applyAnswer(
  pc: RTCPeerConnection,
  answerSdp: string,
  renegotiation: string | null,
): Promise<void> {
  await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  if (renegotiation !== null && renegotiation !== '') {
    await pc.setRemoteDescription({ type: 'offer', sdp: renegotiation });
    await pc.setLocalDescription(await pc.createAnswer());
  }
}

/** The microphone on or off (mute), once the call is through. */
export function setMicrophone(media: CallMedia, on: boolean): void {
  for (const track of media.microphone.getAudioTracks()) track.enabled = on;
}

export function closeMedia(media: CallMedia | null): void {
  if (media === null) return;
  for (const track of media.microphone.getTracks()) track.stop();
  media.pc.close();
}
