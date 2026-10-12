import { en } from '@elysium/i18n/locales/sections/alive.en';

import { registerSection } from './catalogue.js';

/**
 * The live layer's strings (M44a, D-607's pattern): sounds, desktop alerts, relative times and
 * presence. Imported for its effect by the account menu, the work dock and the inbox, all lazy
 * chunks, so the strings stay out of the first download. Registering twice is harmless.
 */
registerSection({ en });
