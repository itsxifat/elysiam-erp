import { bn } from '@elysium/i18n/locales/sections/web-marketing.bn';
import { en } from '@elysium/i18n/locales/sections/web-marketing.en';

import { registerSection } from './catalogue.js';

/**
 * Website → Campaign links, Tracking and Marketplace's strings (M35b, D-607's pattern), in both
 * locales. Imported for its effect by the modules that render them, so the strings travel in
 * those screens' chunks rather than in the first download. Registering twice is harmless.
 */
registerSection({ en, bn });
