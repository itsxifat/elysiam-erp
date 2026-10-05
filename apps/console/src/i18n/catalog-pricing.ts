import { bn } from '@elysium/i18n/locales/sections/catalog-pricing.bn';
import { en } from '@elysium/i18n/locales/sections/catalog-pricing.en';

import { registerSection } from './catalogue.js';

/**
 * Variant prices, buying prices and product management (M39b), in both locales (D-607).
 *
 * Imported for its effect by every module that renders one of these keys (the new-product
 * form, the product page, the product list, the receive dialog, Supply → Entries and Supply
 * → Buying prices), so the strings travel in those screens' chunks rather than in the first
 * download. Registering twice is harmless.
 */
registerSection({ en, bn });
