/**
 * Staff accounts (gaps-users-auth): who may reset whose sign-in, the link lifetimes
 * and limits, the reset log's lifecycle, and what a role change changes. One brand per
 * deployment and the owner sign-in link (M31). The admins' trust votes (D-654), and super
 * admins making super admins (D-659).
 *
 * Pure functions only; the tables, Better Auth and the approvals live in the server's
 * `iam` module.
 */
export * from './credentials.js';
export * from './owner-link.js';
export * from './brand-deployment.js';
export * from './trust.js';
export * from './super-admin.js';
