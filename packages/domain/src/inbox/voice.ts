import type { InboxChannelKind } from './window.js';

/**
 * Voice messages and the media the inbox keeps (M45, D-780 to D-783).
 *
 * What each channel accepts, from Meta's pages read 2026-10-12:
 *
 * - **WhatsApp** (Cloud API, "Audio messages"): a voice message is `type: audio` with
 *   `audio.voice: true`, and "Voice messages require .ogg files encoded with the OPUS codec";
 *   "The play icon will only appear if the file is 512KB or smaller". The supported audio list
 *   gives `audio/ogg` as "OPUS codecs only; base audio/ogg not supported; mono input only".
 * - **Messenger** (Send API, "Saving assets" and the Attachment Upload API): an `audio`
 *   attachment, "Content-Type header must use type audio", up to 25 MB.
 * - **Instagram** (Messenger API for Instagram, "Send a Message"): audio as "aac, m4a, wav,
 *   mp4", up to 25 MB.
 *
 * So a recording leaves as Ogg/Opus mono for WhatsApp and as an M4A (AAC in MP4) for Messenger
 * and Instagram, the one format both name. The browser records WebM/Opus (Chrome, Firefox) or
 * MP4/AAC (Safari); the server transcodes with ffmpeg.
 */

export interface VoiceFormat {
  /** The type Meta is told. */
  readonly mime: 'audio/ogg' | 'audio/mp4';
  /** ffmpeg's muxer. */
  readonly container: 'ogg' | 'ipod';
  readonly extension: 'ogg' | 'm4a';
  /** WhatsApp's `audio.voice: true`: shown as a voice note, with the play icon and transcript. */
  readonly voiceNote: boolean;
}

export const VOICE_FORMATS: Readonly<Record<InboxChannelKind, VoiceFormat>> = {
  whatsapp: { mime: 'audio/ogg', container: 'ogg', extension: 'ogg', voiceNote: true },
  messenger: { mime: 'audio/mp4', container: 'ipod', extension: 'm4a', voiceNote: false },
  instagram: { mime: 'audio/mp4', container: 'ipod', extension: 'm4a', voiceNote: false },
};

export function voiceFormatFor(channel: InboxChannelKind): VoiceFormat {
  return VOICE_FORMATS[channel];
}

/**
 * The longest recording the composer takes (D-781): two minutes. At WhatsApp's voice-note
 * bitrate (24 kbit/s Opus) that is about 360 KB, under the 512 KB above which WhatsApp shows a
 * download arrow instead of the play button.
 */
export const MAX_VOICE_MS = 120_000;
/** Shorter than this is a slip of the finger, not a message. */
export const MIN_VOICE_MS = 500;

/** The recording types the composer may upload: what MediaRecorder writes. */
export const RECORDING_MIMES = ['audio/webm', 'audio/ogg', 'audio/mp4'] as const;
export type RecordingMime = (typeof RECORDING_MIMES)[number];

export function isRecordingMime(mime: string): mime is RecordingMime {
  return (RECORDING_MIMES as readonly string[]).includes(mime);
}

/**
 * What an attachment is, for keeping (D-780): audio and pictures are downloaded and kept with the
 * conversation; everything else (a video, a file, a sticker, a shared post) keeps Meta's link,
 * which expires.
 */
export type KeptMediaKind = 'audio' | 'image';

export function keptMediaKind(type: string): KeptMediaKind | null {
  if (type === 'audio') return 'audio';
  if (type === 'image') return 'image';
  return null;
}

/**
 * The largest attachment the inbox downloads, by kind (D-782). WhatsApp's own ceiling for audio
 * is 16 MB and Messenger's 25 MB; a voice note is a few hundred kilobytes, so 16 MiB keeps every
 * real one and refuses a stranger's 100 MB "audio". Pictures as the files module's images.
 */
export const MAX_KEPT_BYTES: Readonly<Record<KeptMediaKind, number>> = {
  audio: 16 * 1024 * 1024,
  image: 12 * 1024 * 1024,
};

/**
 * How long kept media stays (D-783): with its conversation, for a year after the message. A
 * customer's complaint about what was said is raised within weeks; a year covers a season's
 * returns and disputes, and the text of the thread stays regardless.
 */
export const MEDIA_RETENTION_DAYS = 365;

export function mediaExpired(occurredAt: Date, now: Date, days = MEDIA_RETENTION_DAYS): boolean {
  return now.getTime() - occurredAt.getTime() > days * 24 * 60 * 60 * 1000;
}
