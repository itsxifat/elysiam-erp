/**
 * Test-only surface for @elysium/db.
 *
 * Separate from the package root so application code cannot reach
 * `configureDatabase` — which repoints every pool at an arbitrary URL — or
 * `closeDatabase`, by importing the package it already depends on.
 */

export { closeDatabase, configureDatabase } from '../client.js';
export {
  resetTenantData,
  startTestDatabase,
  stopSharedContainer,
  type TestDatabase,
} from './harness.js';
export {
  findCrossOrgForeignKeys,
  findDefaultPrivileges,
  findPrivilegeProblems,
  findTenancyOffenders,
  type ForeignKeyOffender,
  type Offender,
  type PrivilegeOffender,
} from './guard.js';
