/**
 * The ring of an incoming call (M45, D-786), made in the browser with the Web Audio API: two
 * soft two-tone bursts, then a pause, again until stopped. No sound file to download.
 *
 * Behind a small interface so the shared sound utilities M44a builds (with the person's mute
 * switch) can take its place at the integration: anything with `start` and `stop` will do.
 */
export interface RingSound {
  start(): void;
  stop(): void;
}

type AudioContextClass = typeof AudioContext;

function contextClass(): AudioContextClass | null {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextClass;
    webkitAudioContext?: AudioContextClass;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

/** One burst: two sine tones under a soft envelope, so it neither clicks nor startles. */
function burst(context: AudioContext, at: number, length: number): void {
  const gain = context.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.07, at + 0.03);
  gain.gain.setValueAtTime(0.07, at + length - 0.05);
  gain.gain.linearRampToValueAtTime(0, at + length);
  gain.connect(context.destination);
  for (const frequency of [440, 480]) {
    const tone = context.createOscillator();
    tone.type = 'sine';
    tone.frequency.setValueAtTime(frequency, at);
    tone.connect(gain);
    tone.start(at);
    tone.stop(at + length);
  }
}

const CYCLE_MS = 3_000;

export function createRingSound(): RingSound {
  let context: AudioContext | null = null;
  let timer: number | null = null;

  const ring = () => {
    if (context === null) return;
    const at = context.currentTime + 0.02;
    burst(context, at, 0.4);
    burst(context, at + 0.6, 0.4);
  };

  return {
    start() {
      if (timer !== null) return;
      const Context = contextClass();
      if (Context === null) return;
      context = new Context();
      // A page nobody has touched yet may not play sound; the bar still shows.
      void context.resume().catch(() => undefined);
      ring();
      timer = window.setInterval(ring, CYCLE_MS);
    },
    stop() {
      if (timer !== null) window.clearInterval(timer);
      timer = null;
      void context?.close().catch(() => undefined);
      context = null;
    },
  };
}
