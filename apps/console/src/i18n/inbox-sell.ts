import { en } from '@elysium/i18n/locales/sections/inbox-sell.en';

import { registerSection } from './catalogue.js';

/**
 * Selling from the chat: the inbox panel's side card, product picker and draft order (M44b,
 * D-607's pattern). Imported for its effect by the panel's message module, so the strings travel
 * in the inbox's lazy chunk. Registering twice is harmless.
 */
registerSection({ en });
