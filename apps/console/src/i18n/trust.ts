import { en } from '@elysium/i18n/locales/sections/trust.en';

import { registerSection } from './catalogue.js';

/**
 * Staff → trust votes' strings (D-654 to D-656, D-607's pattern). Imported for
 * its effect by the Staff screen's message list, so the strings travel in that lazy chunk
 * rather than in the first download. Registering twice is harmless.
 */
registerSection({ en });
