import { en } from '@elysium/i18n/locales/sections/order-edit.en';

import { registerSection } from './catalogue.js';

/**
 * The order editor's strings (M50, D-607's pattern): editing an order, changing a packed one,
 * returning items, the product picker and the offers panel. Imported for its effect by those
 * screens, so the strings travel in their lazy chunks rather than in the first download.
 * Registering twice is harmless.
 */
registerSection({ en });
