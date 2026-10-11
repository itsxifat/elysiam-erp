import { en } from '@elysium/i18n/locales/sections/workflow.en';

import { registerSection } from './catalogue.js';

/**
 * The order workflow's strings (M41, D-607's pattern): ownership, presence, offers, the desk's
 * and the hub's queues, the team board and their settings. Imported for its effect by the
 * screens and the shell's lazy work dock that render them, so the strings travel in those
 * chunks rather than in the first download. Registering twice is harmless.
 */
registerSection({ en });
