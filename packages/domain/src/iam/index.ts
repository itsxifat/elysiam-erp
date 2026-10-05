/**
 * Staff accounts (gaps-users-auth): who may reset whose sign-in, the link lifetimes
 * and limits, the reset log's lifecycle, and what a role change changes.
 *
 * Pure functions only; the tables, Better Auth and the approvals live in the server's
 * `iam` module.
 */
export * from './credentials.js';
export * from './owner-link.js';
