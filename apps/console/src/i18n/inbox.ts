import { bn } from '@elysium/i18n/locales/sections/inbox.bn';
import { en } from '@elysium/i18n/locales/sections/inbox.en';

import { registerSection } from './catalogue.js';

/**
 * The unified inbox, its customer panel, Settings → Inbox and the order desk's fraud warning
 * (M42, D-607's pattern). Imported for its effect by those screens' message modules, so the
 * strings travel in their lazy chunks rather than in the first download. Registering twice is
 * harmless.
 */
registerSection({ en, bn });
