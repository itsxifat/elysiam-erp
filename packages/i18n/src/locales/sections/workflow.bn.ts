import { en, type WorkflowKey } from './workflow.en.js';

/**
 * The order workflow's second locale (M41). The product is English only from M43 (the owner's
 * decision of 2026-10-11), so this section carries the English strings until M43 removes the
 * Bangla locale altogether; it exists only because the catalogue is still typed for two.
 */
const bn: Record<WorkflowKey, string> = { ...en };

export { bn };
