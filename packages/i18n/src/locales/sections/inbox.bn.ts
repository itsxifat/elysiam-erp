import { en, type InboxKey } from './inbox.en.js';

/**
 * The unified inbox (M42): the Bangla section, a copy of the English. The product is English
 * only (M43 removes Bangla); this file exists because the catalogue's types ask for both locales
 * and goes when the Bangla locale does.
 */
const bn: Record<InboxKey, string> = { ...en };

export { bn };
