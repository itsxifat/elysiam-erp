/**
 * Telling a barcode scanner from a person typing (M38a, D-605).
 *
 * A USB or Bluetooth scanner is a keyboard: it types the code and presses Enter. What gives
 * it away is speed. A person types a key every 100 to 300 ms; a scanner sends the whole
 * code in a burst, a few milliseconds apart. So a scan is:
 *
 * - at least `minLength` printable characters (8: an EAN-8 is the shortest code we print
 *   or accept, and a short burst of fast typing is more likely a person),
 * - each within `maxGapMs` of the one before (35 ms: well under a fast typist's 60-80 ms
 *   between different keys, well over a scanner's 1-15 ms, with room for a busy main
 *   thread delaying an event),
 * - ended by Enter, itself within `maxGapMs` of the last character.
 *
 * Modifier keys (Shift for capitals, which some scanners send) are ignored rather than
 * breaking the burst. Any other non-character key (Tab, an arrow, Backspace) ends it: those
 * are a person.
 *
 * The detector is pure: it is handed key names and timestamps and says what it saw. Whether
 * a key event counts at all (not inside a text box, unless that box opted in) is the
 * caller's decision, because only the caller has the DOM.
 */

export interface ScanOptions {
  /** The longest pause between two keystrokes of one scan. */
  readonly maxGapMs: number;
  /** The fewest characters a scan has. */
  readonly minLength: number;
  /** The most characters a scan has; longer is a paste or a stuck key. */
  readonly maxLength: number;
}

export const DEFAULT_SCAN_OPTIONS: ScanOptions = { maxGapMs: 35, minLength: 8, maxLength: 64 };

export interface ScanKey {
  /** `KeyboardEvent.key`: `'5'`, `'A'`, `'Enter'`, `'Shift'`. */
  readonly key: string;
  /** Milliseconds, from any monotonic clock (`event.timeStamp`). */
  readonly at: number;
}

export type ScanStep =
  /** Nothing to report. */
  | { readonly kind: 'none' }
  /** A character joined a burst that could still become a scan. */
  | { readonly kind: 'pending'; readonly length: number }
  /** Enter ended a burst that is a scan. The caller should stop Enter's default action. */
  | { readonly kind: 'scan'; readonly code: string };

const MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'AltGraph', 'CapsLock']);

/** A printable character: one code point that is not a control character. */
function printable(key: string): boolean {
  if ([...key].length !== 1) return false;
  const point = key.codePointAt(0) ?? 0;
  return point >= 0x20 && point !== 0x7f;
}

export interface ScanDetector {
  /** Feed one keydown. */
  push(event: ScanKey): ScanStep;
  /** Forget the burst so far: focus moved into a text box, the page changed. */
  reset(): void;
}

export function createScanDetector(options: ScanOptions = DEFAULT_SCAN_OPTIONS): ScanDetector {
  let buffer = '';
  let last = Number.NEGATIVE_INFINITY;

  const reset = () => {
    buffer = '';
    last = Number.NEGATIVE_INFINITY;
  };

  return {
    reset,
    push(event) {
      if (MODIFIERS.has(event.key)) return buffer === '' ? { kind: 'none' } : pending();

      const gap = event.at - last;
      if (event.key === 'Enter') {
        const code = buffer;
        const quick = gap <= options.maxGapMs;
        reset();
        return quick && code.length >= options.minLength && code.length <= options.maxLength
          ? { kind: 'scan', code }
          : { kind: 'none' };
      }

      if (!printable(event.key)) {
        reset();
        return { kind: 'none' };
      }

      // A pause longer than a scanner ever takes: whatever came before was typing, and
      // this key may be the first of a scan.
      if (buffer !== '' && gap > options.maxGapMs) buffer = '';
      buffer += event.key;
      last = event.at;
      if (buffer.length > options.maxLength) {
        reset();
        return { kind: 'none' };
      }
      return pending();
    },
  };

  function pending(): ScanStep {
    return { kind: 'pending', length: buffer.length };
  }
}

/**
 * Run a whole sequence through a fresh detector and return the scans it found. For tests
 * and for anything replaying recorded input.
 */
export function detectScans(
  keys: readonly ScanKey[],
  options: ScanOptions = DEFAULT_SCAN_OPTIONS,
): string[] {
  const detector = createScanDetector(options);
  const found: string[] = [];
  for (const key of keys) {
    const step = detector.push(key);
    if (step.kind === 'scan') found.push(step.code);
  }
  return found;
}

/**
 * Normalise what a scanner or a person entered into the code to look up: trimmed, and with
 * the invisible prefix some scanners add (a leading `]E0` symbology identifier) removed.
 */
export function normaliseScannedCode(raw: string): string {
  const trimmed = raw.trim();
  return /^\][A-Za-z]\d/.test(trimmed) ? trimmed.slice(3) : trimmed;
}
