/**
 * The console's live layer (M44a, D-765, D-766): sounds, desktop alerts, relative times and
 * presence, shared by the shell's account menu, the work dock and the inbox (D-607's section
 * pattern: shipped with those chunks rather than in the first download). English only (D-750).
 */
const en = {
  'alive.sound.title': 'Sounds',
  'alive.sound.play': 'Play sounds',
  'alive.sound.volume': 'Sound volume',
  'alive.sound.low': 'Quiet',
  'alive.sound.medium': 'Normal',
  'alive.sound.high': 'Loud',

  'alive.notify.ask':
    'Get a desktop alert when a customer writes or work is offered to you while this tab is in the background.',
  'alive.notify.allow': 'Turn on alerts',
  'alive.notify.later': 'Not now',
  'alive.notify.message': 'New message on {channel}',
  'alive.notify.messageFrom': '{name} on {channel}',
  'alive.notify.orderOffer': 'An order is offered to you',
  'alive.notify.chatOffer': 'A conversation is offered to you',
  'alive.notify.someone': 'A customer',
  'alive.channel.messenger': 'Messenger',
  'alive.channel.instagram': 'Instagram',
  'alive.channel.whatsapp': 'WhatsApp',

  'alive.time.now': 'Just now',
  'alive.time.minutes': '{n} min ago',
  'alive.time.hours': '{n} h ago',
  'alive.day.today': 'Today',
  'alive.day.yesterday': 'Yesterday',

  'alive.presence.you': 'You',
} as const;

/** The keys of this section. */
export type AliveKey = keyof typeof en;

export { en };
