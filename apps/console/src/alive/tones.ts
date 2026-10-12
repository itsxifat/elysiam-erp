import { soundPrefs, type SoundVolume } from './sound-prefs.js';

/**
 * The console's sounds (M44a, D-766), made in the browser with the Web Audio API: no audio
 * files, nothing to license, nothing downloaded. Each tone is a few short notes with a soft
 * attack and an exponential fade, quiet on purpose: a desk hears them all day.
 *
 * - `message`: two soft bell notes a fifth apart. A customer wrote.
 * - `offer`: a brighter three-note rise, played twice. Work is waiting for an answer.
 * - `sent`: one short upward glide. The reply left.
 * - `error`: two low notes falling. It did not go.
 * - `ring`: two short two-tone bursts, a phone's ring. A call (M45, D-786); the call bar plays it
 *   every few seconds while the call rings, so muting stops it and the volume applies at once.
 *
 * Browsers start audio only after the person has used the page, so the context is created on
 * the first key or click and resumed whenever a tone plays. Muted, nothing is created at all.
 */

export type Tone = 'message' | 'offer' | 'sent' | 'error' | 'ring';

export interface Note {
  /** Seconds after the tone starts. */
  readonly at: number;
  readonly frequency: number;
  /** Where the pitch glides to by the note's end, if it glides. */
  readonly glideTo?: number;
  readonly seconds: number;
  readonly wave: OscillatorType;
  /** 0 to 1, before the person's volume. */
  readonly level: number;
}

const C6 = 1046.5;
const E6 = 1318.51;
const G6 = 1567.98;

/** A phone's two-tone burst (440 and 480 Hz together), as M45's call bar first rang. */
const burst = (start: number): Note[] =>
  [440, 480].map((frequency) => ({
    at: start,
    frequency,
    seconds: 0.4,
    wave: 'sine' as const,
    level: 0.6,
  }));

const rise = (start: number): Note[] =>
  [C6, E6, G6].map((frequency, index) => ({
    at: start + index * 0.11,
    frequency,
    seconds: 0.22,
    wave: 'triangle' as const,
    level: 0.7,
  }));

export const TONES: Readonly<Record<Tone, readonly Note[]>> = {
  message: [
    { at: 0, frequency: 880, seconds: 0.34, wave: 'sine', level: 0.9 },
    { at: 0.09, frequency: E6, seconds: 0.46, wave: 'sine', level: 0.7 },
  ],
  offer: [...rise(0), ...rise(0.6)],
  sent: [{ at: 0, frequency: 620, glideTo: 940, seconds: 0.14, wave: 'sine', level: 0.45 }],
  error: [
    { at: 0, frequency: 392, seconds: 0.18, wave: 'triangle', level: 0.8 },
    { at: 0.16, frequency: 293.66, seconds: 0.28, wave: 'triangle', level: 0.8 },
  ],
  ring: [...burst(0), ...burst(0.6)],
};

/** The master level for each volume setting. */
export const VOLUME_GAIN: Readonly<Record<SoundVolume, number>> = {
  low: 0.08,
  medium: 0.16,
  high: 0.3,
};

/** The least time between two of the same tone: a burst of messages rings once. */
export const MIN_GAP_MS: Readonly<Record<Tone, number>> = {
  message: 1500,
  offer: 2500,
  sent: 250,
  error: 800,
  ring: 2500,
};

/** Whether a tone may play now, given when it last did. Pure, for the test. */
export function mayPlay(tone: Tone, lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= MIN_GAP_MS[tone];
}

type AudioContextClass = typeof AudioContext;

let context: AudioContext | null = null;
const lastPlayed = new Map<Tone, number>();

function audioContextClass(): AudioContextClass | null {
  if (typeof window === 'undefined') return null;
  const scope = window as unknown as {
    AudioContext?: AudioContextClass;
    webkitAudioContext?: AudioContextClass;
  };
  return scope.AudioContext ?? scope.webkitAudioContext ?? null;
}

function ensureContext(): AudioContext | null {
  if (context !== null) return context;
  const Context = audioContextClass();
  if (Context === null) return null;
  try {
    context = new Context();
  } catch {
    context = null;
  }
  return context;
}

/** Create or wake the context inside a user gesture, so later tones are allowed to play. */
function unlock(): void {
  if (soundPrefs().muted) return;
  const audio = ensureContext();
  if (audio?.state === 'suspended') void audio.resume().catch(() => undefined);
}

if (typeof window !== 'undefined') {
  for (const name of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(name, unlock, { capture: true, passive: true });
  }
}

function schedule(audio: AudioContext, notes: readonly Note[], master: number): void {
  const output = audio.createGain();
  output.gain.value = master;
  output.connect(audio.destination);
  const start = audio.currentTime + 0.01;
  let end = start;
  for (const note of notes) {
    const at = start + note.at;
    const oscillator = audio.createOscillator();
    const envelope = audio.createGain();
    oscillator.type = note.wave;
    oscillator.frequency.setValueAtTime(note.frequency, at);
    if (note.glideTo !== undefined) {
      oscillator.frequency.exponentialRampToValueAtTime(note.glideTo, at + note.seconds);
    }
    envelope.gain.setValueAtTime(0.0001, at);
    envelope.gain.linearRampToValueAtTime(note.level, at + 0.008);
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + note.seconds);
    oscillator.connect(envelope);
    envelope.connect(output);
    oscillator.start(at);
    oscillator.stop(at + note.seconds + 0.02);
    end = Math.max(end, at + note.seconds + 0.05);
  }
  // Let go of the graph once the last note has faded.
  window.setTimeout(() => output.disconnect(), Math.ceil((end - audio.currentTime) * 1000) + 50);
}

/**
 * Play a tone, unless this person muted sounds or the same tone just played. `preview` plays it
 * regardless: the account menu's volume choice, so the person hears what they picked.
 */
export function playTone(tone: Tone, options: { readonly preview?: boolean } = {}): void {
  const prefs = soundPrefs();
  if (prefs.muted && options.preview !== true) return;
  const now = Date.now();
  if (options.preview !== true && !mayPlay(tone, lastPlayed.get(tone), now)) return;
  const audio = ensureContext();
  if (audio === null) return;
  lastPlayed.set(tone, now);
  try {
    if (audio.state === 'suspended') void audio.resume().catch(() => undefined);
    schedule(audio, TONES[tone], VOLUME_GAIN[prefs.volume]);
  } catch {
    // Audio refused (no output device, a policy): the screen still says everything.
  }
}
