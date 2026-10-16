import { en } from '@elysium/i18n/locales/sections/labels.en';

import { registerSection } from './catalogue.js';

/**
 * Labels and Packaging (M46, D-607's pattern): the label desks, the packing terminals, the
 * print station, lots and the handover. Imported for its effect by those screens, so the
 * strings travel in their lazy chunks rather than in the first download. Registering twice is
 * harmless.
 */
registerSection({ en });
