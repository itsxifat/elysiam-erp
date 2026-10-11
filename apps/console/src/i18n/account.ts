import { en } from '@elysium/i18n/locales/sections/account.en';

import { registerSection } from './catalogue.js';

/**
 * My account, Settings → Security and the Staff screen's sign-out and turn-off (M40, D-607's
 * pattern). Imported for its effect by those screens' message modules, so the
 * strings travel in their lazy chunks rather than in the first download. Registering twice is
 * harmless.
 */
registerSection({ en });
