/**
 * Notifications (architecture §10, M16; invariant 11): quiet hours and the
 * template rendering rules. The `@elysium/domain/notify` subpath.
 */
export * from './quiet-hours.js';
export * from './templates.js';
// M34: the website's emails, bn and en (D-529).
export * from './emails.js';
