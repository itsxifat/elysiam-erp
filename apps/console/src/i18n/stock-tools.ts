import { en } from '@elysium/i18n/locales/sections/stock-tools.en';

import { registerSection } from './catalogue.js';

/**
 * The stickers, scanning and stock-in-hand strings (M38a, D-607).
 *
 * Imported for its effect by every module that renders one of these keys, so the strings
 * travel in that screen's chunk rather than in the first download. Registering twice is
 * harmless: the same keys are merged again with the same values.
 */
registerSection({ en });
