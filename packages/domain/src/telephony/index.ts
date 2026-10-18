/**
 * Phone calls through Envo (M47; invariant 11): Envo's webhook and call-history payloads, its
 * signature header, the numbers it dials and sends, a call's statuses, linking a call to the
 * click that started it, and recordings' retention. The `@elysium/domain/telephony` subpath.
 */
export * from './calls.js';
export * from './envo.js';
