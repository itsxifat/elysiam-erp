/**
 * @elysium/domain
 *
 * Pure business logic: money arithmetic, the order state machine, posting
 * rules, approval thresholds and audit redaction (architecture §4,
 * invariant 11).
 *
 * Everything here is a function of its arguments. That is what lets the same
 * rule answer identically in the API, in a worker, in a preview screen and in
 * a test — and it is why `requiresApproval` lives here rather than inside the
 * approvals service, where the preview and the enforcement could drift apart.
 */
export const PACKAGE_NAME = '@elysium/domain' as const;

export * from './money/index.js';
export * from './dates/index.js';
export * from './ledger/index.js';
export * from './posting/index.js';

export {
  canDecide,
  requiresApproval,
  type ApprovalDecisionInput,
  type Threshold,
} from './approvals/index.js';

export {
  changedFields,
  maskPhone,
  maskPhonesInText,
  redact,
  REDACTED,
  REDACTED_FIELD_PATTERNS,
} from './audit/index.js';
