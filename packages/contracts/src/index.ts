/**
 * @elysium/contracts
 *
 * Zod schemas and DTO types, the CASL permission matrix, error codes and event
 * types (architecture §4).
 *
 * M02a seeds it with the identity schemas, because the rule is that a form
 * validates against the same schema the server does — one definition, shared,
 * so a client-side rule can never drift looser than the server's. M02b adds the
 * permission matrix; M04 adds the error codes and event schemas.
 */
export const PACKAGE_NAME = '@elysium/contracts' as const;

export {
  credentialsSchema,
  membershipRoleSchema,
  MEMBERSHIP_ROLES,
  recoveryCodeSchema,
  switchOrgSchema,
  totpCodeSchema,
  createUserSchema,
  type Credentials,
  type CreateUser,
  type MembershipRole,
  type RecoveryCode,
  type SwitchOrg,
  type TotpCode,
} from './iam.js';

export * from './approvals.js';
export * from './errors.js';
export * from './ledger.js';
export * from './permissions/index.js';
