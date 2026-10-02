# Gaps: staff accounts and sign-in

Branch: `gaps-users-auth` (from `integration-wave2` at `09c36d1`) · Effort MAX · Architecture §6, §25 · Builds on M02a, M02b

> Planned on 2026-10-02 under continuous build mode (no approval pause; the plan is still
> written first). The owner wants the ERP working, previewable and testable by a human before
> it is hosted. M30's paused plan lists these as the admin gaps a human would hit first: only
> `POST /v1/users` exists, there is no accept-invite screen, no password reset and nothing to
> reset a lost phone's two-step verification.

## Scope

1. **Staff screen** (`/users`): a brand's people with name, email, roles, branch scope,
   two-step status, last sign-in and invite state. An admin invites (the existing
   `POST /v1/users`), changes roles and branch scope, and deactivates a leaver: their
   memberships in the brand switch off, their sessions end at once, their open links and
   resets are cancelled, and every row they wrote stays.
2. **Accept-invite screen** (`/accept-invite#token=…`): the link an admin already receives
   (D-057, D-212) opens a page where the new person sets a password, then signs in and meets
   the existing 2FA wall if their role needs it.
3. **Password reset without email**: an admin-issued, one-time, short-lived link shown to the
   admin, the same pattern as invites. Issuing it ends the person's sessions and voids their
   old password at once; redeeming it ends any session again. Rate-limited and audited.
4. **2FA reset after a lost phone**: an admin resets another person's second factor (never
   their own); their sessions end and trusted devices are forgotten, so they re-enrol at next
   sign-in.

Out of scope: emailing links (D-212 stays), self-service "forgot password", a platform-wide
account kill switch screen (`iam.users.is_active` stays an operator setting), and hashing reset
tokens at rest (a follow-up).

## Rules (decisions D-400 to D-409)

- Who: `read User` lists, `update User` changes (org_admin in the brand; super admin through
  `manage all`). Nobody changes their own access or resets their own sign-in. Only a super
  admin touches a super admin. Branch managers still need at least one branch.
- D-077 holds: every role granted or reshaped through the screen, and every re-issued invite,
  records the admin as the granter, so that person can never approve the admin's requests.
- **Second person**: a password or 2FA reset of someone who can act as an org-level checker
  (org_admin, accounts, hr) needs another org admin's approval through the approvals service
  (new type `credential_reset`, never auto-approved, raised only by the iam module, and never
  decided by the person being reset). A super admin acts alone. An approved password reset is
  collected by the admin who asked, within 24 hours.
- **Cross-brand people**: only a super admin resets the sign-in of someone who belongs to more
  than one brand, because the link opens every brand they work in.
- **Sign-in needs an active account with at least one active membership** (or super admin),
  enforced where Better Auth creates a session, so a deactivated leaver cannot sign in again.
- Links: invites last 72 hours, resets 1 hour; a new link voids the person's earlier ones; the
  token rides in the URL fragment, never a query string. Better Auth's public
  `request-password-reset` path is disabled: every link comes from an audited admin action.
- Limits: 20 resets an hour per admin and 5 a day per person, per brand, counted in the
  database so every replica agrees.

## Approach

- **Data** (two migrations): `iam.users.last_sign_in_at`; `iam.credential_resets` (tenant
  table: who asked to reset whose password, invite or second factor, its approval and outcome;
  RLS, no DELETE, a transition trigger, one open reset per person and kind, requester ≠ target);
  `credential_reset` in `approvals.approval_type` and in the never-auto-approve CHECKs.
- **Server**: `UsersService` in the iam module: list, set roles, deactivate, password link,
  2FA reset, and the `credential_reset` executor and rejection handler. Better Auth config:
  `revokeSessionsOnPasswordReset`, `disabledPaths`, and a `session.create.before` hook that
  refuses an inactive account. The auth bridge stamps `last_sign_in_at`.
- **Console**: `/users` (table, invite, edit roles, reset dialogs, link dialog, review of a
  pending reset for a second admin), and a set-password screen served before the session
  check for `/accept-invite` and `/reset-password`.
- **Tests**: real-Postgres API tests for every permission edge (who may change whose roles,
  self-escalation, cross-brand, super admin protection, deactivated users and sessions, tokens
  single-use and expiring, resets audited and session-revoking, approvals for privileged
  targets, rate limits); the route matrix; a Playwright stack spec for invite → sign in,
  password reset and 2FA reset with axe in both themes.

## Risks

- **A reset is an account takeover tool.** The admin holds the token. Mitigated by the second
  person for checker-capable roles, the cross-brand rule, the lineage record and the audit;
  what remains (an admin can take over a sales agent they reset) is the D-077 W4 risk that
  exists until links are emailed to the person.
- **Refusing sessions can lock people out.** The hook fails closed only on an inactive account
  or no active membership; super admins pass; the existing 2FA wall is unchanged.
- **Shared files**: `en.ts`/`bn.ts`, `errors.ts`, the route manifest, the router and the stack
  provisioner are edited by sibling branches; edits are kept to appended, self-contained
  blocks.

## Tasks

1. Plan (this file).
2. Contracts: schemas, error codes, the approval type; migrations.
3. Better Auth config and the session hook; the auth bridge's last sign-in.
4. `UsersService`, controller, executor; route matrix fixtures; OpenAPI catalog; api client.
5. API tests (permissions, sessions, tokens, approvals, limits, audit).
6. Console: set-password screen, `/users`, i18n bn + en.
7. Stack spec with axe in both themes.
8. Decisions, progress entry, plans index; `pnpm verify`; ledger-auditor; fixes.

## Status on 2026-10-02: planned
