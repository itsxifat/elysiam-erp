import { bn } from '@elysium/i18n/locales/sections/packing.bn';
import { en } from '@elysium/i18n/locales/sections/packing.en';

import { registerSection } from './catalogue.js';

/**
 * Orders → Scan's and the label sheet's strings (M35b, D-607's pattern), in both locales.
 * Imported for its effect by the modules that render them (the orders screens' shared tabs
 * name the Scan page), so the strings travel in the orders chunks rather than in the first
 * download. Registering twice is harmless.
 */
registerSection({ en, bn });
