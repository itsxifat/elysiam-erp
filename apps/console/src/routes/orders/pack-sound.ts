/**
 * The station's sounds (M38b, D-610): a short high note when a piece is taken, a low double
 * buzz when one is refused, so the packer hears a wrong piece without looking at the screen.
 * Synthesised with Web Audio (no sound files to download); silent where the browser has none.
 */

let audio: AudioContext | null = null;

function context(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Context =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (Context === undefined) return null;
  try {
    audio ??= new Context();
    if (audio.state === 'suspended') void audio.resume();
    return audio;
  } catch {
    return null;
  }
}

function tone(ctx: AudioContext, frequency: number, start: number, length: number, volume: number) {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'square';
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, ctx.currentTime + start);
  gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + start + length);
  oscillator.connect(gain).connect(ctx.destination);
  oscillator.start(ctx.currentTime + start);
  oscillator.stop(ctx.currentTime + start + length);
}

export function playScanSound(kind: 'accepted' | 'refused' | 'done'): void {
  const ctx = context();
  if (ctx === null) return;
  try {
    if (kind === 'accepted') {
      tone(ctx, 1320, 0, 0.09, 0.08);
    } else if (kind === 'done') {
      tone(ctx, 988, 0, 0.1, 0.08);
      tone(ctx, 1319, 0.12, 0.16, 0.08);
    } else {
      tone(ctx, 196, 0, 0.22, 0.2);
      tone(ctx, 165, 0.28, 0.32, 0.2);
    }
  } catch {
    // A sound is a courtesy; the screen says the same thing.
  }
}
