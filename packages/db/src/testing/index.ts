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
  type TestDatabaseOptions,
} from './harness.js';
export {
  findAnalyticsReadProblems,
  findAppendOnlyProblems,
  findCrossOrgForeignKeys,
  findDefaultPrivileges,
  findPrivilegeProblems,
  findTenancyOffenders,
  type ForeignKeyOffender,
  type Offender,
  type PrivilegeOffender,
} from './guard.js';

export {
  asUser,
  createTestUser,
  grantMembership,
  revokeMembership,
  type CreateUserInput,
  type TestUser,
} from '../iam/fixtures.js';

/** M14a: a seeded brand given the demo's set-up, so the sample files import into it. */
export { seedDemoSetUp } from '../seed/training.js';
