/**
 * @elysium/mother-shared
 *
 * The mother ERP's contracts and its arithmetic (D-480, D-495): the request schemas, the
 * response shapes, the error codes and the pure functions that add brands together. Used
 * by `apps/mother-server` and `apps/mother-console` and by nothing else: no brand app and
 * no shared package may depend on it (`mother-separation.test.ts`), so nothing here
 * reaches a brand's image or bundle.
 */
export * from './devices.js';
export * from './errors.js';
export * from './schemas.js';
export * from './figures.js';
export * from './wire.js';
