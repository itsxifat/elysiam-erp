# M40 (mother): brands on the server only; My account

Wave 3 · Depends on: M32, D-690 · Architecture §30 "The mother ERP (M32)" · Decisions D-700 to
D-705 · Branch `m40-mother-accounts` from `integration-wave2` (75dbe8e2)

> The owner, 2026-10-11: "for mother erp there might not be the option to add brands, that
> will be fixed as we do manually" and "we need better account management, two factor
> management, user friendly and more options".

## What this is, in plain words

1. **Brands are the operator's, on the server.** Adding a brand, changing how the mother
   reaches it and making or replacing the key that signs an owner into it are done only with
   the CLI on the mother's server. The console's Brands screen says so and keeps what an owner
   may still change: the name, the staff console address, whether the brand is read, a
   connection test and a read on demand.
2. **My account.** Each owner manages their own sign-in: name, password, two-step sign-in
   (required, never off: moved to a new phone, new recovery codes) and the devices signed in as
   them.

## Built

- API: `POST /v1/brands` and `POST /v1/brands/:id/owner-link-key` removed (404); the brand
  update's body is strict (no `readConnection`, 400). CLI: `brands list`, `add` (now also tests
  the connection), `set-connection` (`MOTHER_BRAND_READ_URL`), `rotate-key`, `test`; a
  connection is printed and audited only as its fingerprint (`brand.connection_changed`).
- `/v1/account`: `GET`, `PATCH` (name), `POST password`, `POST two-factor/new-app`,
  `POST two-factor/new-app/confirm`, `POST two-factor/backup-codes`, `GET sessions`,
  `POST sessions/:id/sign-out`, `POST sessions/sign-out-others`
  (`apps/mother-server/src/account/account.ts`). The password change, the new phone and new
  recovery codes all ask for the password and a code held now. Better Auth's own account
  routes closed (`DISABLED_AUTH_PATHS`), and its factor routes walled from an enrolled
  session. Lockout after five wrong answers in fifteen minutes, under the person's lock.
- Migration `0002_session_last_active` (`auth.sessions.last_active_at`).
- `packages/mother-shared`: account schemas and wire shapes, `describeUserAgent`,
  `maskAddress`, three error codes (`INVALID_PASSWORD`, `INVALID_CODE`,
  `TWO_FACTOR_SETUP_EXPIRED`).
- Console: `/account` (header name and Settings → My account), Brands reworked, bn + en,
  activity labels; the stack tour visits My account.
- Docs: D-700 to D-705, architecture §30, `docs/runbooks/mother-deploy.md` §5 and §7.

## Checks

1. The removed routes answer 404; a `readConnection` in a brand update is a 400 and the
   fingerprint is unchanged (`http.db.test.ts`).
2. The CLI lists, re-points, re-keys and tests a brand, audited as the operator, and never
   prints or audits the connection (`http.db.test.ts`).
3. Each My account action works and is audited, and refuses what it should: a wrong password
   or code, no code, a confirmation from another session, a spent key, another person's
   session, this device; Better Auth's own routes answer 404 and its factor routes 404 for an
   enrolled session, changing nothing; twenty parallel wrong guesses give exactly five answers
   (`http.db.test.ts`); an escaped account path meets its limit (`rate-limit.test.ts`).
4. The screens: two-step sign-in shown as required with no way off; this device marked and not
   offered a sign-out; the password checked before it is sent; codes shown once behind
   "saved"; Brands offers no add, re-point or new key (`account.test.tsx`, `brands.test.tsx`).

## Status on 2026-10-11 — built, audited and tested; not merged, not deployed

The ledger-auditor's review (2 critical, 4 warnings, 7 notes) is fixed in cdc4be3e: both
factors for every sign-in change (C1, W3), the factor routes walled from an enrolled session
(C2), the checks serialised per person (W1), the limiter on the routed path (W2), the tests
(W4), and the notes N1, N2, N4 to N7 (N3, auditing a wrong code at confirm, left out: the
caller already holds the new key). Mother suites 162/162 (13 files), typecheck and eslint
(mother workspaces), prettier, check:i18n, check:migrations, check:schema: PASS. Not run: the mother stack spec
(`pnpm --filter @elysium/mother-console e2e:stack`, which now also tours My account) and a
look at the screens in a browser. Deploying needs the usual mother deploy from a commit the
brands share; the migration is additive.
