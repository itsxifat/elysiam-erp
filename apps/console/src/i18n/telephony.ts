import { en } from '@elysium/i18n/locales/sections/telephony.en';

import { registerSection } from './catalogue.js';

/**
 * Phone calls through Envo (M47, D-607's pattern): Settings → Calls, the Calls page, the Call
 * buttons, the console's phone and an order's phone calls. Imported for its effect by those
 * screens, so the strings travel in their lazy chunks rather than in the first download.
 * Registering twice is harmless.
 */
registerSection({ en });
