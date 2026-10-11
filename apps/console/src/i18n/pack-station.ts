import { en } from '@elysium/i18n/locales/sections/pack-station.en';

import { registerSection } from './catalogue.js';

/**
 * The packing station's, the packing video's and the order page's packing strings (M38b,
 * D-607's pattern). Imported for its effect by the modules that render them,
 * so the strings travel in the orders chunks rather than in the first download. Registering
 * twice is harmless.
 */
registerSection({ en });
