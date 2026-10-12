import { en } from '@elysium/i18n/locales/sections/voice.en';

import { registerSection } from './catalogue.js';

/**
 * Voice messages and calls in the inbox (M45, D-607's pattern): the player, the recorder, the
 * call bar and the call entries. Imported for its effect by those components, so the strings
 * travel in their lazy chunks rather than in the first download. Registering twice is harmless.
 */
registerSection({ en });
