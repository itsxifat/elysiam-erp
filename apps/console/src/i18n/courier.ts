import { en } from '@elysium/i18n/locales/sections/courier.en';

import { registerSection } from './catalogue.js';

/**
 * The courier screens' strings (M12, M15; D-607's pattern, D-906): parcels, the stuck-parcel
 * queue, performance, settlements, returns and the order page's parcel panel. Imported for its
 * effect by `routes/courier/messages.ts`, which every one of them reads its strings through, so
 * the strings travel in those lazy chunks rather than in the first download. Registering twice
 * is harmless.
 */
registerSection({ en });
