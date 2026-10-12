/**
 * Voice messages and calls in the inbox (M45, D-780 to D-788; D-607's section pattern): the
 * audio player, the recorder, the call bar and the call entries in a thread. Shipped with the
 * inbox's chunks and the shell's lazy call bar, not in the first download. No string names a
 * brand (M31). `{name}` placeholders are filled by the screen.
 */
const en = {
  'voice.player.play': 'Play voice message',
  'voice.player.pause': 'Pause voice message',
  'voice.player.position': 'Position in the voice message',
  'voice.player.speed': 'Playback speed {speed}',
  'voice.player.loading': 'Loading the voice message…',
  'voice.player.pending': 'Voice message arriving…',
  'voice.player.failed': 'This voice message could not be kept.',
  'voice.player.expired': 'This voice message was deleted under the retention rule.',
  'voice.player.error': 'This voice message could not be played.',
  'voice.player.label': 'Voice message, {length}',
  'voice.image.label': 'Picture from the customer',
  'voice.image.pending': 'Picture arriving…',
  'voice.image.failed': 'This picture could not be kept.',

  'voice.record.start': 'Record a voice message',
  'voice.record.stop': 'Stop recording',
  'voice.record.recording': 'Recording {length}',
  'voice.record.limit': 'Voice messages stop at two minutes.',
  'voice.record.preview': 'Your voice message',
  'voice.record.send': 'Send voice message',
  'voice.record.sending': 'Sending…',
  'voice.record.discard': 'Discard',
  'voice.record.noMic': 'The microphone could not be used. Allow it in the browser and try again.',
  'voice.record.unsupported': 'This browser cannot record voice messages.',
  'voice.record.tooShort': 'That recording is too short to send.',
  'voice.record.failed': 'The voice message could not be sent.',

  'voice.call.incoming': 'Incoming call',
  'voice.call.incomingFrom': 'Incoming {channel} call from {name}',
  'voice.call.unknown': 'Unknown caller',
  'voice.call.answer': 'Answer',
  'voice.call.decline': 'Decline',
  'voice.call.connecting': 'Connecting…',
  'voice.call.onCall': 'On a call with {name}',
  'voice.call.mute': 'Mute',
  'voice.call.unmute': 'Unmute',
  'voice.call.hangUp': 'Hang up',
  'voice.call.open': 'Open the conversation',
  'voice.call.taken': '{name} picked this call up.',
  'voice.call.ended': 'The call ended.',
  'voice.call.dismiss': 'Dismiss',
  'voice.call.failed': 'The call could not be connected.',
  'voice.call.noMic': 'The microphone could not be used, so the call was handed back.',
  'voice.call.channel.messenger': 'Messenger',
  'voice.call.channel.whatsapp': 'WhatsApp',
  'voice.call.channel.instagram': 'Instagram',

  'voice.event.ringing': 'Incoming call, ringing',
  'voice.event.answering': 'Incoming call, being picked up',
  'voice.event.connected': 'Call in progress',
  'voice.event.completed': 'Call, {length}',
  'voice.event.failed': 'Call dropped, {length}',
  'voice.event.missed': 'Missed call',
  'voice.event.declined': 'Declined call',
  'voice.event.answeredBy': 'Answered by {name}',
  'voice.event.declinedBy': 'Declined by {name}',
  'voice.event.callBack': 'Call back',
  'voice.event.callBackPhone': 'Call back on {phone}',
  'voice.event.callBackDone': 'Mark as called back',
  'voice.event.callBackDoneBy': 'Called back by {name}',
} as const;

export type VoiceKey = keyof typeof en;
export { en };
