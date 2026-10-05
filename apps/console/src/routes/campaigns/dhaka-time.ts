/**
 * `datetime-local` text read and written as Asia/Dhaka wall time (D-545).
 *
 * A browser's `datetime-local` input has no zone: it is whatever the person typed. A flash
 * sale or a discount that "starts at 9 pm" starts at 9 pm in Dhaka, whatever the laptop's
 * clock is set to, so the text is read with Dhaka's offset. Bangladesh has kept +06:00 all
 * year since 2009, so the offset is a constant, not a lookup (architecture §7's dates).
 */

const DHAKA_OFFSET_MS = 6 * 60 * 60 * 1000;
const LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** `2026-10-05T21:00` → `2026-10-05T15:00:00.000Z`; null for anything else. */
export function dhakaLocalToIso(local: string): string | null {
  const match = LOCAL.exec(local.trim());
  if (match === null) return null;
  const [, year, month, day, hour, minute] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute) - DHAKA_OFFSET_MS;
  const date = new Date(utc);
  // 31 February rolls into March; refuse it rather than move the sale.
  const back = new Date(utc + DHAKA_OFFSET_MS);
  if (back.getUTCDate() !== day || back.getUTCMonth() !== month - 1) return null;
  return date.toISOString();
}

/** An instant as Dhaka `datetime-local` text, for an input's value. */
export function isoToDhakaLocal(iso: string | null): string {
  if (iso === null) return '';
  const time = new Date(iso).getTime();
  if (Number.isNaN(time)) return '';
  return new Date(time + DHAKA_OFFSET_MS).toISOString().slice(0, 16);
}

/** An instant as people read it in Dhaka: `5 Oct 2026, 21:00`. */
export function dhakaText(iso: string | null, locale: string): string {
  if (iso === null) return '';
  return new Intl.DateTimeFormat(locale === 'bn' ? 'bn-BD' : 'en-GB', {
    timeZone: 'Asia/Dhaka',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}
