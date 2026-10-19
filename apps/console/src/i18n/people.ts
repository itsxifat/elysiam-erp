import { en } from '@elysium/i18n/locales/sections/people.en';

import { registerSection } from './catalogue.js';

/**
 * Customer numbers and people (M48, D-607's pattern): the Numbers card, Merge, the desk's chooser
 * and "For someone else", the order page's buyer and recipient and the caller panel's numbers.
 * Imported for its effect by those screens, so the strings travel in their lazy chunks rather
 * than in the first download. Registering twice is harmless.
 */
registerSection({ en });
