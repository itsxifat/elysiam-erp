/**
 * A voice message's waveform and clock (M45, D-780): computed in the browser from the decoded
 * audio, cheaply. The samples are split into `bars` equal buckets and each bar is the bucket's
 * peak, scaled so the loudest bar is full height; a silent recording draws a flat low line rather
 * than nothing. Pure, so the shape is tested without a browser.
 */

/** The minimum height a bar is drawn at, as a fraction of the full height. */
export const MIN_BAR = 0.08;

export function peaks(samples: Float32Array, bars: number): number[] {
  const count = Math.max(1, Math.floor(bars));
  if (samples.length === 0) return new Array<number>(count).fill(MIN_BAR);
  const size = samples.length / count;
  const raw: number[] = [];
  for (let bar = 0; bar < count; bar += 1) {
    const start = Math.floor(bar * size);
    const end = Math.max(start + 1, Math.floor((bar + 1) * size));
    let peak = 0;
    // Every sample would be wasteful on a long clip; a stride keeps it to ~200 reads a bar.
    const stride = Math.max(1, Math.floor((end - start) / 200));
    for (let index = start; index < end && index < samples.length; index += stride) {
      const value = Math.abs(samples[index] ?? 0);
      if (value > peak) peak = value;
    }
    raw.push(peak);
  }
  const loudest = Math.max(...raw);
  if (loudest === 0) return raw.map(() => MIN_BAR);
  return raw.map((value) => Math.max(MIN_BAR, Math.min(1, value / loudest)));
}

/** "1:05" for a voice message's length or position, from seconds. */
export function clock(seconds: number): string {
  const total = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${String(Math.floor(total / 60))}:${String(total % 60).padStart(2, '0')}`;
}

/** The playback speeds the player cycles through. */
export const SPEEDS = [1, 1.5, 2] as const;
export type Speed = (typeof SPEEDS)[number];

export function nextSpeed(current: Speed): Speed {
  const index = SPEEDS.indexOf(current);
  return SPEEDS[(index + 1) % SPEEDS.length] ?? 1;
}

/** Where a click or key lands on the waveform, as a fraction of the clip, clamped. */
export function seekFraction(offsetX: number, width: number): number {
  if (!(width > 0)) return 0;
  return Math.min(1, Math.max(0, offsetX / width));
}
