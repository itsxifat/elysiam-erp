import { bn } from '@elysium/i18n/locales/sections/website.bn';
import { en } from '@elysium/i18n/locales/sections/website.en';

import { registerSection } from './catalogue.js';

/**
 * The website screens' strings (M33, M34), in both locales (D-607's pattern).
 *
 * Imported for its effect by every module that renders one of these keys, so the strings
 * travel in that screen's chunk rather than in the first download. The shell's own labels
 * (`web.nav.*`) stay in the core catalogue. Registering twice is harmless.
 */
registerSection({ en, bn });
