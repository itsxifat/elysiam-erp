import { en } from '@elysium/i18n/locales/sections/manage.en';

import { registerSection } from './catalogue.js';

/**
 * The delete-and-archive strings (M39a, D-607's pattern).
 *
 * Imported for its effect by every module that renders one of these keys (the shared dialog
 * and the screens that manage rows), so the strings travel in those chunks rather than in the
 * first download. Registering twice is harmless.
 */
registerSection({ en });
