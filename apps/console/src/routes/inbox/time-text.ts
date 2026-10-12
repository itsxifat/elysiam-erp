import type { InboxT } from './messages.js';
import type { DayLabel, TimeLabel } from './thread-logic.js';

/** A relative time in words: "Just now", "2 min ago", "Yesterday", "12 Oct" (M44a, D-765). */
export function timeText(label: TimeLabel, t: InboxT): string {
  if ('text' in label) return label.text;
  if ('n' in label) return t(label.key, { n: String(label.n) });
  return t(label.key);
}

/** A day separator in words: "Today", "Yesterday", "Sat 10 Oct". */
export function dayText(label: DayLabel, t: InboxT): string {
  return 'text' in label ? label.text : t(label.key);
}
