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
  credentialResetSchema,
  deactivateUserSchema,
  roleGrantSchema,
  setPasswordSchema,
  setRolesSchema,
  userIdParamSchema,
  type Credentials,
  type CreateUser,
  type CredentialResetInput,
  type DeactivateUser,
  type RoleGrant,
  type SetPassword,
  type SetRoles,
  type MembershipRole,
  type RecoveryCode,
  type SwitchOrg,
  type TotpCode,
} from './iam.js';

export * from './approvals.js';
export * from './approvals-list.js';
export * from './events.js';
export * from './errors.js';
export * from './ledger.js';
export * from './permissions/index.js';
export * from './pos.js';
export * from './channels.js';
// M33: the brand's website, run from its ERP.
export * from './storefront.js';
