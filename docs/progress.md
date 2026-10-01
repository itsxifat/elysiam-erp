# Progress log

Add one entry per session, with the newest at the bottom. Keep entries short; git history holds the detail.

## Entry template

```
### <YYYY-MM-DD> · <Milestone ID> · <title> · <done | partial | blocked>
- Delivered: <what now works, in user terms>
- Verification: pnpm verify exit 0; acceptance checks 1..n PASS (see report); e2e: <flows>
- Auditors: ledger-auditor <0 critical / n/a>; acceptance-auditor <READY>
- Decisions/assumptions: <D-0xx added or changed>
- New dependencies: <package — reason>
- Deviations from the milestone spec: <none | what and why>
- Follow-ups: <item> (owner: claude | human)
- Next: <next milestone, or a fix session>
```

---

### Kit installed · pre-M00 · done

- Delivered: the build kit (CLAUDE.md, docs/, .claude/). No code yet.
- Next: kickoff session, then M00.

### 2026-09-20 · kickoff · Orientation and doc adjustments · done

- Delivered: read the full architecture, milestones, decisions and the client's 9-page Bangla spec; compared them; adjusted the docs. Repo initialized (`main`), kit committed, pnpm 12.5.1 installed. No product code yet.
- Environment: node v24.21.0, pnpm 12.5.1, git 2.55.0, Claude Code 2.1.278. **Docker is missing** and so are WSL2, Hyper-V and podman — gate G0 is not clear.
- Gaps found vs the client spec: no per-org branding anywhere in the architecture (five brands, identical invoices); no branded per-org login though the client asked for "আলাদা লগইন"; no stated default UI language; §7 back-dating and §9 settlement import did not reconcile.
- Decisions/assumptions: D-033 design system (RESOLVED), D-034 per-org branding, D-035 branded login, D-036 UI default language (RESOLVED), D-037 settlement in a closed period, D-038 milestone split (RESOLVED).
- Milestone edits: M02 → M02a/M02b and M14 → M14a/M14b (D-038). M00 gains the design token foundation, `.gitattributes` and a benchmark harness. M05 gains five UI-quality acceptance checks (contrast, keyboard, theme parity, bn/en typography, review screenshots). M02b gains a continuous route-matrix CI gate, so M30 confirms rather than discovers. M10 gains an exchange-flow check, M11 a fraud badge slot, M12 the D-037 settlement date rule, M15 a stuck-parcel queue. M06/M13/M22/M29 perf and audit checks now pin their measurement method.
- Deviations from the milestone spec: none — the kit's own kickoff flow.
- Follow-ups: install Docker Desktop + WSL2 (owner: human, blocks M01); explain D-001 and D-002 to the client, since the spec recommended ERPNext/Odoo and schema-per-tenant (owner: human); collect the five brands' logos and accent colours for D-034 (owner: human, needed by M05).
- Next: M00.

### 2026-09-20 · M00 · Repo bootstrap and toolchain · done

- Delivered: a pnpm + Turborepo monorepo where `pnpm verify` is the single gate. Six apps and nine packages compile; the API answers `/health/live`, the worker logs `ready`, and all four front ends serve. `pnpm verify` runs format check, lint, typecheck, 91 tests, build and the migration-immutability check, and exits 0.
- The design token foundation (D-033) landed here rather than in M05, so no screen in this repo's history was ever written against a hard-coded colour. OKLCH semantic roles in light and dark, per-org brand accent derived from a hue/chroma pair (D-034), 36 px rows, hairline borders, motion at 120–200 ms, and Inter + Hind Siliguri vendored with a computed `size-adjust: 108.1%` so mixed bn/en strings share one baseline.
- Per-app configuration is validated at **build** time, not in the browser: Vite inlines `import.meta.env`, so a check that only ran in the bundle would ship the broken config first. An invalid `VITE_API_URL` fails the console build and an invalid `NEXT_PUBLIC_API_URL` fails the sites build, both with a readable report.
- Verification: `pnpm verify` exit 0 (26 s locally, 36 s on a genuine fresh clone). Checks 2–7 PASS with evidence in the Verification Report; check 1 passes in full. **Closed 2026-09-21** once Docker was installed: `docker compose -f infra/docker-compose.dev.yml up -d --wait` brought postgres, valkey and gotenberg up Healthy in 92 s, and the whole sequence (`pnpm i` → `pnpm setup:env` → compose up → `pnpm verify`) exits 0. Verified against the running containers: PostgreSQL 17.11 with ICU collation (`datlocprovider: i`, `datlocale: en-US`), Valkey 8.1.10 answering PONG, Gotenberg `/health` 200. e2e: 3 Playwright specs (mount and token paint, theme repaint, keyboard reachability).
- The acceptance-auditor found four blocking gaps that I had missed, and all four are now fixed and re-verified. Two were genuinely broken rather than cosmetic: pnpm had written an unanswered `allowBuilds: esbuild: set this to true or false` placeholder into `pnpm-workspace.yaml` during install, so **a fresh clone's `pnpm i` exited 1** and both CI jobs would have died at their install step; and WXT's dev server defaults to port 3000, the API's port, so under `pnpm dev` `http://localhost:3000/health/live` returned 404 and **every `.env.example` pointed the front ends at the extension**. The other two: `pnpm fonts:fetch` emitted unformatted CSS that broke `pnpm verify` until someone ran `pnpm format`, and check 1's own sequence omitted `pnpm setup:env`. My earlier claim that checks 1 and 2 passed was wrong on both counts; this entry replaces it.
- Auditors: ledger-auditor n/a (M00 touches no money, stock, tenancy or permission code); acceptance-auditor NOT READY on its first pass with 4 blocking gaps, all closed and re-verified since.
- Decisions/assumptions: D-039 (TypeScript pinned to 6.0.3, not 7.x), D-040 (packages compiled via project references, tests aliased to source).
- New dependencies, with reasons: `concurrently` — the server dev script runs `tsc -b --watch` alongside two `node --watch` processes, and tsx/esbuild cannot emit the decorator metadata NestJS DI needs. `@eslint/js` — the flat-config base ruleset. `happy-dom` — the DOM environment for the Vitest `dom` project. Everything else is named in architecture §3.
- Two Build-list items were half done on the first pass and were closed before the report: "per-app config validated with Zod" covered only the server, and "path aliases" existed only in apps/sites. Two more defects surfaced while checking the docs were true — `pnpm api:client` pointed at a script that did not exist, and the Next-generated `next-env.d.ts` failed `format:check` on the first site build.
- Deviations from the milestone spec: TypeScript is pinned to 6.0.3 rather than the latest stable 7.0.2 (D-039) — TypeScript 7 removed the classic compiler API, so type-aware linting would stop working. The token test also asserts WCAG contrast, slightly beyond check 5's wording, because the OKLCH values are M00's deliverable and picking them by eye would not be verifiable; it found three real failures in the first draft.
- Follow-ups:
  - ~~Install Docker Desktop + WSL2~~ **DONE 2026-09-21.** The blocker was firmware, not software: this machine's CPU supports virtualization but `HyperVRequirementVirtualizationFirmwareEnabled` was False, so SVM Mode had to be enabled in BIOS before `wsl --install` could work. Now on Docker 29.8.0 / Compose v5.5.1 / WSL2, engine healthy.
  - Chart and dataviz tokens deliberately omitted; M24 picks them with the `dataviz` skill rather than inheriting unvalidated placeholders (owner: claude, M24).
  - A lint rule banning `toFixed` / `parseFloat` outside `packages/domain/src/money` (owner: claude, M03, once that module exists to scope it against).
  - Production sourcemaps are off in the Vite builds; M14b turns them back on wired to Sentry upload (owner: claude, M14b).
  - The three SPA placeholder pages are scaffolding; M05 replaces them with the real console shell (owner: claude, M05).
  - Writing the regression tests the plan promised for `check-migrations.mjs` found a real bug: deleting the _last_ migration removed its directory, and an `existsSync` short-circuit reported PASS instead of catching the deletion. Fixed, and the script now resolves its repository from the working directory so it also works in a worktree.
  - CI has never executed: `git remote -v` is empty, nothing has been pushed. The workflow is actionlint-clean and its install step is now fixed, but it is unproven until the repo has a remote (owner: human).
  - Hind Siliguri ships four Bangla weights at ~72 KB each (286 KB total). `unicode-range` means they load only when Bangla renders and only for the weights used, but Bangladesh is a 4G market — trim to 400/600 in M05 if the type scale does not need four (owner: claude, M05).
- Next: M01, once Docker is available.

### 2026-09-21 · M01 · Database core and multi-org isolation · done

- Delivered: one brand cannot see another brand's data, proved by 60 adversarial tests against real PostgreSQL. Three database roles, the `org` and `ref` schemas, RLS with ENABLE and FORCE on every tenant table, `withOrg`/`withAnalytics`/`withSystem`, a Testcontainers harness, and an idempotent seed of the five brands plus Bangladesh geography.
- **Two things in the architecture did not hold as written, and I found both by probing the running database before designing around it.**
  - `erp_owner` was the dev container's superuser, and a superuser bypasses `FORCE ROW LEVEL SECURITY` entirely. Verified live: an insert the policy should have rejected succeeded, and a select that should have returned 0 rows returned 1. **Every isolation test written against that role would have passed while proving nothing.** Fixed by making `postgres` the container superuser and creating erp_owner NOSUPERUSER (D-042).
  - §5's policy SQL raised `invalid input syntax for type uuid: ""` instead of returning zero rows on any reused connection, because a transaction-local `set_config` reverts to the empty string rather than to unset. That is every pooled connection in production after its first request. Fixed with `nullif`, and §5 corrected (D-043).
- The tests are written adversarially, not confirmatively. Every isolation assertion is a negative — "org A sees nothing of org B's" — and a negative passes just as happily when the query is broken or the table is empty. So the suite builds a table whose policy is deliberately weakened to match every row, and another with RLS off, and asserts the same method observes the leak. Rejections are matched against PostgreSQL's own error through the `.cause` chain, not Drizzle's "Failed query" wrapper, which would have passed for a typo.
- Verification: `pnpm verify` exit 0 (17 s warm, 154 tests). Acceptance checks 1–6 all PASS; see the Verification Report. Database tests run in ~6 s on a Testcontainer or ~2 s against the compose server.
- **Tooling interruption:** Windows Smart App Control began enforcing mid-milestone and blocked `pnpm.exe`, `esbuild.exe` and rolldown's native binding, so the suite could not run for a stretch. Being forced to run built output instead of `tsx` found a genuine production bug: `tsc` does not copy `.sql` files, so `node dist/cli/bootstrap.js` failed with ENOENT — exactly how it runs in a container. The build now copies sql assets. Resolved by turning Smart App Control off; everything below was re-run afterwards.
- Auditors: **ledger-auditor found 3 critical and 8 warnings, then 1 more critical on re-audit — all fixed.** The worst was one I had not considered: PostgreSQL runs referential-integrity checks with row security bypassed, so `locations.branch_id references branches(id)` let org A insert a row pointing at org B's branch. I reproduced it before fixing — cross-org referential corruption, a denial of service where org B could not delete its own branch because of a referencing row it cannot see, and a working existence oracle on any uuid in any org. Fixed with a composite `(org_id, branch_id)` reference (D-047), and it was the template every future intra-tenant FK would have copied. The other two: the guard was an allowlist containing only `org`, so `sales`, `inventory` and `ledger` would each have shipped unguarded; and it counted policies rather than checking them, so `using (true)` passed. Both fixed and now opt-out (D-048). **acceptance-auditor returned NOT READY with 3 gaps, all closed:** the guard skipped partitioned parents (`relkind = 'r'`), which would have hidden M03's journals while every leaf looked clean; check 4's "analytics reads all orgs" was only ever exercised against the global org list, because `erp_analytics` holds no read grant on any tenant table until M24 (now stated as D-049 rather than implied); and this entry's own numbers were stale. The re-audit then caught one I had introduced: I hand-wrote migration 0002 without updating the Drizzle schema, so schema and snapshot agreed with each other and both disagreed with the database. `db:generate` said "no schema changes", which looked like evidence and was the opposite — a false baseline that could have emitted a migration reopening D-047. Fixed by regenerating 0002 from a corrected schema, and `scripts/check-schema-drift.mjs` now fails the gate if they ever diverge again. It also flagged three smaller things, all fixed: `locations` and `feature_flags` had no isolation test despite the plan promising "per tenant table and per verb"; `resetTenantData` was exported but never called; and D-047 had only a structural check, not the behavioural assertion for the exploit that was actually reproduced.
- Decisions/assumptions: D-041 (`ref` schema), D-042 (erp_owner not a superuser, four connection URLs), D-043 (`nullif` in the policy), D-044 (`TEST_DATABASE_URL` or Testcontainers), D-045 (vendored Bangladesh geography with provenance), D-046 (`org.locations`, not `inventory.locations`).
- New dependencies, with reasons: `@testcontainers/postgresql` — real Postgres for tests, since RLS is a database behaviour a mock cannot have. `fast-check` — property testing, required by the architecture's test strategy for later milestones. `tsx` — runs the db CLI entrypoints without a build step, which matters because `db:bootstrap` has to run before anything is built.
- Deviations from the milestone spec: the Build list says the bootstrap creates the roles "with default privileges"; it deliberately grants none, and a test asserts `pg_default_acl` is empty. A default privilege silently grants every future table to a role, which is the opposite of what the tenancy guard is for. Otherwise none in scope — though two architecture corrections (D-043, D-046) and one infra change (D-042) were needed before the stated acceptance checks were testable at all.
- Follow-ups:
  - The harness reset shared role passwords when pointed at a live server, breaking the dev database mid-session. Fixed to reuse ambient passwords — but worth remembering that anything which ALTERs a role affects the whole server, not one database (owner: claude, done).
  - Branch-level scoping (`branch_id` filtering) is not enforced anywhere yet. The column exists; enforcing it is a permissions concern for M02b (owner: claude, M02b).
  - `ref.thanas` carries 494 upazilas from the official portals, but a courier's own coverage list is the authority for where it will actually deliver. M12 reconciles the two (owner: claude, M12).
  - Pin the assumption that `/api/auth/sign-in/email/` 404s. The rate-limit rules match exact paths, and they are safe today only because better-call rejects a trailing-slash mismatch outright — a Better Auth upgrade, or anyone setting `skipTrailingSlashes`, makes them bypassable overnight (owner: claude, M02b).
  - CI still has never executed — the repo has no remote (owner: human).
- Next: M02a, identity, auth and request context.

### 2026-09-23 · M02a · Identity, auth and request context · done

- Delivered: a person signs in to a branded login, clears a second factor if their role needs one, and every request after that knows who they are, which of the five brands they are acting in and what they may be. Better Auth on our own tables, memberships with branch scope, an org switcher that does not appear for the four-in-five staff who only work in one brand, a user admin API that issues invites, CSRF, CORS, rate limiting, and the console screens for all of it.
- **The design was wrong in a way only running it revealed: §6 says 2FA is required for four roles, and I enforced it by refusing the session. That deadlocks the product.** Enrolling TOTP runs behind Better Auth's session middleware, so a brand-new `org_admin` could never enrol and therefore could never sign in — a control nobody can satisfy is a control nobody ships with. It is an enrolment wall on the request path now (D-051): the session is real and good for nothing but enrolling. Verified end to end in a browser against the live stack — signed in as an org_admin, was walled, enrolled with a real authenticator secret, and came out the other side with the wall lifted.
- Verification: `pnpm verify` exit 0 (273 tests). `pnpm e2e` 13 passed. Checks 1–6 all PASS; see the Verification Report. Also driven by hand through Chrome against the real API and database: generic and branded login, org switch changing roles from `sales` to `warehouse`, the enrolment wall, and the second factor demanded on the next sign-in.
- **The auditors found nine things. Four were critical, and one of those was mine from this session.**
  - `POST /v1/users` was guarded by nothing but membership, with a comment saying M02b would add the check — but the route shipped. Reproduced: a `sales` user posts their own address with `role: "org_admin"`, the existing-identity branch reuses their row, and they hold full org admin in one request, then satisfy the 2FA wall by enrolling on their own account. `org_admin` is the role that posts journals from M03 (D-058).
  - `/api/auth/sign-up/email` was open to the internet. Anonymous POST, 200, rows in `iam.users` and `iam.accounts` (D-057).
  - Those two combined into account pre-hijacking: register the address of someone about to be hired, and the later invite attaches their role to your password. Reproduced end to end.
  - **Mine:** to make branded login work I had trusted `*.<APP_DOMAIN>` in CORS, the CSRF origin check and Better Auth at once, and argued in a comment that it granted nothing the parent-domain cookie did not already. That reasoning was wrong and the auditor was right to push back: the cookie scope lets a sibling host _read_ the CSRF token; CORS was the control stopping it _using_ the token with `credentials: true`. Full authenticated API access from any subdomain — and the subdomains are not all ours, since D-026 puts landing sites on Vercel and §16 puts Chatwoot there. The list is enumerated from `org.organizations` at boot now, with no pattern anywhere (D-054).
  - Also fixed: `erp_analytics` could read `iam.accounts` (password hashes), `iam.two_factors` (TOTP secrets, backup codes) and `iam.sessions` — the generator granted analytics SELECT on every global table unconditionally. Verified live before and after: five tables readable, then none. The guard now enumerates analytics reads the way it enumerates writes (D-060). And the whole request path was connecting as `erp_owner`, the DDL-owning role, when `erp_app` already held every grant it needed (D-059).
- **A control I had written down did not exist.** §6 and a code comment both claimed rate limits were "per identifier as well as per IP". Better Auth keys on `${ip}|${path}` — per IP only — so credential stuffing from a botnet got the full allowance per address, and the existing test proved nothing because vitest pins the IP to 127.0.0.1 and every request landed in one bucket. Built for real (D-056), with both buckets counted and either able to reject, and tested by varying address and identifier independently. Its own test then caught a bypass while I wrote it: `email ?? phoneNumber` treats `''` as present, so `{email: '', phoneNumber: '+880…'}` walked straight past the identifier bucket.
- Auditors: **ledger-auditor 4 critical, 10 warnings — all four criticals fixed, plus W1 (the 2FA hatch covered all of `/api/auth`, so a walled admin could still call `update-user`), W4 (Better Auth's `*` matches dots, so my "same inputs, same answer" comment was false — removed with the wildcard), W5 (the shared Zod schemas existed but the controller hand-rolled its own checks; a cross-org branch id surfaced as a 500), W6 (`withGlobal` cleared `app.org_id` but not `app.user_id`, which drives the D-050 self policy) and W9 (`baseUrl` built from the `0.0.0.0` bind address).** **acceptance-auditor NOT READY with 9 gaps:** check 5 was the real one; the others were the phone-OTP provider having no functional test at all, the user admin API producing accounts that could never sign in, and check 4 asserting against all `Set-Cookie` headers joined into one string rather than the session cookie by name. Both auditors ran while I was still editing and said so, which is worth knowing for next time — their reports mix HEAD and working tree.
- Decisions/assumptions: D-050 (memberships self policy, which was referenced in code but had no row), D-051 (enrolment wall), D-052 (branding reads the caller's hostname), D-053 (console and API share a registrable domain), D-054 (trusted origins enumerated, never patterned), D-055 (i18n and contracts seeded early), D-056 (rate limits, both buckets), D-057 (no self-service registration), D-058 (user admin is org_admin only), D-059 (no owner role on the request path), D-060 (analytics reads nothing in `iam`).
- New dependencies, with reasons: `@fastify/cors` — the console is a separate origin sending cookies, and without CORS it could never talk to the API at all. `react-hook-form` + `@hookform/resolvers` — the declared stack for forms; starting the first real form off-stack is the kind of thing that sticks. `@better-auth/utils` (devDependency) — the TOTP URI carries base32 and the server-side generator wants the raw secret, so the test decodes with Better Auth's own base32 rather than reimplementing it.
- Deviations from the milestone spec: the Build list says "an org_admin creates **or invites** users". Both halves are the same flow here — creating a user issues an invite token — because there is no email adapter until M16, so the token is returned to the admin rather than sent. Branded login cannot be exercised on `*.localhost` in development: Chrome rejects `Domain=localhost`, verified in the browser, so the cookie the console must read is never shared. Development uses `lvh.me` or a hosts entry; noted in `apps/server/.env.example` and D-053. Production is unaffected.
- Follow-ups:
  - The rate limiter is in memory, so the effective threshold multiplies by the replica count. The store is behind an interface; M04 moves it to Valkey, which is already in the compose stack (owner: claude, M04).
  - `two_factors.failed_verification_count` and `locked_until` are columns nothing reads or writes — they imply a TOTP lockout that does not exist. Either wire them or drop them (owner: claude, M02b).
  - No `serializeFor()` and no audit entries on the two mutations M02a ships, which are the two that grant roles and change acting org. M02b owns both, but these are the first rows anyone will want in the audit log (owner: claude, M02b).
  - `GET /api/auth/get-session` returns the raw session token in the body. The auditor could not confirm it is replayable and neither could I; worth settling (owner: claude, M02b).
  - A missing `Origin` header skips the origin check, leaving only the double-submit token. Browsers send it on cross-site POSTs, so this is defence in depth — consider requiring `Sec-Fetch-Site` (owner: claude, M02b).
  - The CSRF token is bound to nothing. Binding it to the session with an HMAC removes token fixation independently of the origin rule (owner: claude, M02b).
  - The tenancy guard checks the one policy it expects by name and counts the rest. `iam.memberships` is the first table with two, and a future `using (true)` would pass — the same failure mode D-048 closed, one level up (owner: claude, M03).
  - The console still has provisional UI primitives; M05's shadcn kit replaces them (owner: claude, M05).
  - CI still has never executed — the repo has no remote (owner: human).
- **The re-audit found one more, and it was mine from the fix commit.** `refuseUnclaimedAccount` — the guard that stops an invite adopting a squatter's account — read `iam.memberships` inside `withGlobal()`, which clears `app.user_id` as well as `app.org_id`. Both policies then evaluate `col = NULL`, so the membership count came back zero for everyone and the guard collapsed to "refuse anyone who has a password". A colleague joining a second brand was rejected outright — the exact case §5 exception 4 and D-050 exist for, and the reason `iam.users` is global at all. Confirmed against the database: a user with two memberships counted as zero. It reads through `withUser` now, the same lens `mustEnrolTwoFactor` already used for the same shape of question. The test written alongside the original fix could not see it, because it invited twice before the invitee ever redeemed; the new one redeems first and fails with the old code. `withGlobal`'s own doc comment warns about this exact failure mode, which I wrote in the same commit that tripped over it.
- Next: M02b, permissions, audit and approvals.

### 2026-09-24 · M02b · Permissions, audit and approvals · done

- Delivered:
  - **Permissions:** one declarative CASL matrix, a global guard that refuses anything undeclared, and a mandatory row scope for `own` and `branch` rules.
  - **Cost protection:** `serializeFor` runs on every response through an interceptor, so cost fields cannot leave the process for a role without `read:cost`.
  - **Audit:** every mutation writes a redacted audit row. That includes the org switch and Better Auth's credential events.
  - **Maker-checker:** the database refuses self-approval, freezes a request's terms from the moment it is raised, and refuses to auto-approve a control action. It also has per-org thresholds, per-type rights on both the maker and the checker side, and the `approval.requested` and `approval.decided` events.
  - **Route gate:** `check-route-matrix` in `pnpm verify` fails any route without a declared ability, and any non-public route missing from the generated route-matrix suite.
- **Maker-checker took five audit rounds, and the auditors were right every time.** Each round found a way to get a second person's approval without a second person. The fixes are in commits 6acbf3a, 36590a8, d9cda15 and the final commit.
  - An approved request could be edited afterwards: approve 500 taka, then update `amount_poisha` to 5 crore.
  - A showroom branch manager could approve a payroll run.
  - An org admin could set a threshold of 1 on `period_reopen` and have the reopen auto-approved.
  - A pending request could be re-attributed to someone else and then approved by its real maker.
  - An org admin could raise a threshold, auto-approve their own request, then lower it again.
  - A caller holding `hr` plus `branch_manager@A` could approve branch B's write-off. Their scopes were unioned across roles.
  - A caller holding `branch_manager@A` plus `warehouse` could raise a branch B wallet adjustment. That too was scopes unioned across roles, on the maker side.
  - An org admin could create a second "org admin", receive that user's invite token, and approve their own requests through the new account.

  The lesson generalises: every permission question has to be answered by the _same_ role and the same membership. That covers type right, branch scope and who granted it. A union across roles is a privilege escalation waiting for its first two-role user.

- **The first version of row scope did nothing at all.** The guard asks CASL "may this caller read ApprovalRequest", which for a scoped rule means "on _some_ row". So every `own` and `branch` rule was org-wide on the request path, and a branch manager could read every branch's approvals with amounts.
  - The fix: one typed `ScopeCondition` feeds both CASL (for single rows) and the SQL filter (for lists). A property test checks they agree on 2,000 random rows.
  - `ScopeInterceptor` refuses to send a scoped response when the handler never applied the scope. This is detection rather than prevention for mutations, and D-061 says so.
- Verification:
  - `pnpm verify` exits 0: 18 test files and 505 tests, plus format, lint, typecheck, build, migrations, schema drift and the route-matrix gate, with 13 routes, 11 of them matrix-tested and 2 public.
  - Acceptance checks 1–7 are in the Verification Report.
  - The generated route-matrix suite drives every non-public route as every role. It asserts the guard admits exactly what the matrix grants, and that every successful mutation leaves an audit row for its actor.
  - Check 6 was demonstrated by removing a route from the manifest. The gate failed with "has no matrix test" and passed again after the revert.
- Auditors:
  - **acceptance-auditor:** NOT READY on the first pass with eight gaps. The real ones were the check 1 loop asserting only `org` and `null` cells, and the first org switch not being audited at all. It was READY on re-audit.
  - **`/security-review` (check 7):** no HIGH findings. Two MEDIUMs and five LOWs, all fixed. The MEDIUMs were that branch scope was never enforced and that a branch manager could decide at any amount. Two LOWs were cost recorded in the audit log before the serializer ran, and `GET /v1/approvals` returning 500 for every caller.
  - **ledger-auditor round 1:** 4 critical, all fixed in 6acbf3a.
  - **ledger-auditor round 2:** 2 critical and 6 warnings, all fixed in d9cda15.
  - **ledger-auditor final pass:** confirmed all eight of round 2's fixes were real, and found 1 critical, 4 warnings and 8 notes. All are fixed in the final commit, with tests.
- Decisions/assumptions: D-061 to D-078.
  - **Row scope and per-role branch scope:** D-061 makes row scope mandatory. D-075 keeps branch scope per role; it is required on every context and fails closed.
  - **Checker and maker authority:** D-062 gives checkers per-type rights and a branch tier. D-072 does the same for makers, and typed amounts no longer decide anything. D-077 stops anyone approving for whoever granted them their role.
  - **Approvals list and amounts:** D-063 narrows the list by relevance. D-074 withholds WAC-valued amounts from roles without `read:cost`.
  - **Audit:** D-064 records where audit rows are written and which of them are atomic. D-066 audits credential events into each of the user's orgs.
  - **Thresholds:** D-065 makes them org_admin-only. D-068 auto-approves below the threshold. D-073 makes relaxing a threshold maker-checker.
  - **Events and hardening:** D-067 holds events in memory until M04. D-069 strips the session token and refuses cross-site fetches.
  - **Route gate:** D-070 defines what it enforces.
  - **Approval safeguards:** D-071 never auto-approves the four control types. D-076 holds branch items for a branch-tier checker. D-078 says executors act on the approved amount and nothing else.
- New dependencies:
  - `@casl/ability`: the matrix engine architecture §6 names.
  - `fast-check`, now used by `contracts` and `domain`: the property tests for scope agreement, redaction and thresholds.
- Deviations from the milestone spec:
  - **Check 5:** "below and above behave differently" became auto-approval below the threshold (D-068), with more exceptions than the spec implies. The four control types, branch items and typed server-derived amounts are always held.
  - **Sales lost `request ApprovalRequest`.** §6 gives sales nothing that goes through maker-checker (D-072). This is a matrix change.
  - **The route gate goes beyond the Build item:** it also fails contradictory declarations and stale manifest entries.
- Follow-ups:
  - Two CHECK constraints were added `NOT VALID` so a database already holding bad rows can still migrate: `approval_requests_never_auto_approved` (0011) and `approval_requests_branch_items_never_auto_approved` (0012). Before go-live, review any rows that violate them, then run `alter table approvals.approval_requests validate constraint …` for each (owner: human, M14b).
  - **Client question (D-068, D-076):** may small branch items skip the branch manager entirely? Today they may not, and every branch item waits for a checker (owner: human).
  - Events are held in memory. M04 replaces `ApprovalsService.publish` with `enqueue(tx, …)` and the outbox (owner: claude, M04).
  - The M02a rate limiter moves to Valkey, as already planned (owner: claude, M04).
  - M02a follow-ups closed here: session token stripped, `Sec-Fetch-Site` refused, trailing-slash sign-in pinned, branch scoping enforced, and both M02a mutations audited.
  - M02a follow-ups moved to M04: the unused `two_factors.failed_verification_count` / `locked_until` columns (wire them with Valkey or drop them), and binding the CSRF token to the session with an HMAC (owner: claude, M04).
  - The owning modules must raise their approval types with a derived amount and a per-type payload schema. M07 covers stock write-offs and gains, M12 settlements, M19 payroll, M21 payout batches and M23 closing variances (owner: claude, those milestones).
  - D-077's grant-lineage rule exists because the admin receives the invite token. Revisit it once M16 emails invites directly to the invitee (owner: claude, M16).
  - Delete the `demo` schema and move the matrix suite onto the real catalog (owner: claude, M06).
  - D-066 audits sign-ins into each of the user's orgs. A global security-event log, if the client wants one, belongs with M04 (owner: claude, M04).
- Next: M03, ledger core.

### 2026-09-25 · M03 · Ledger core · done

- _Entry written on 2026-09-30 from the commit history. The session that built M03 closed without one._
- Delivered: a double-entry ledger the database refuses to corrupt. Branded integer poisha, a no-float-money lint rule, deferred balance constraints, journals immutable by grant and by trigger, the period lock, deterministic idempotency keys, a chart of accounts per org, reversal journals, and the reports the business reads: trial balance, day book, account ledger, cash book and party balances.
- Verification: `pnpm verify` exit 0 at the merge `05f7176`: 27 test files, 17 migrations, 24 routes all declared and 22 matrix-tested.
- Auditors: two acceptance audits, a ledger audit, an adversarial review and a security review standing in for `/security-review`, which cannot run without a git remote. No criticals. Two HIGH findings, both attacks on the audit trail, were fixed in `a532048`: a key named like a phone switched secret redaction off for its subtree, and a deeply nested body suppressed the audit row. `serializeFor` failing open through a `toJSON` chain was fixed in the same commit.
- Decisions/assumptions: D-079 to D-094.
- New dependencies: none recorded.
- Deviations from the milestone spec: M03 was built on M02b's closeout branch, so the two merged together.
- Follow-ups: none left open that a later milestone did not pick up.
- Next: M04.

### 2026-09-25 · M04 · Platform services · done

- _Entry written on 2026-09-30 from the commit history. The session that built M04 closed without one._
- Delivered: the plumbing later modules reuse. The transactional outbox with `emit(tx, …)`, pg-boss jobs with `enqueue(tx, …)` in the caller's transaction, retries, dead-letter queues and Asia/Dhaka cron; the `/rt` realtime gateway with server-assigned rooms; file storage with presigned upload and authorize-then-sign download; Gotenberg PDFs with Bangla fonts; OpenAPI and the generated api-client with a drift gate; problem+json; `Idempotency-Key`; the rate limiter on Valkey; bn/en i18n with a missing-key gate; feature flags.
- Verification: `pnpm verify` exit 0 at `11a3594`: 47 test files, 30 routes all declared and 26 matrix-tested.
- Auditors: each of the five slices was reviewed adversarially. Three HIGH findings fixed on the way in: a socket was authorized once and never again, `Idempotency-Key` was unreachable from every browser because the CORS preflight did not list it, and a failed `complete()` left an idempotency key claimed for 24 hours.
- Decisions/assumptions: D-104.
- Deviations from the milestone spec: none recorded.
- **Found later, on 2026-09-30:** the outbox dispatcher built here had never delivered an event in any environment. It claimed rows with no org context against a FORCE RLS table and saw none, while every suite drained the outbox by another route. Fixed with D-131 and D-132 and migration 0072. See the M11/M15 entry.
- Next: M05.

### 2026-09-26 · M05–M13, M19, M25 · Parallel build of eleven milestones, then integration · partial

- Delivered: the console shell and UI kit (M05); catalog (M06); stock ledger with WAC costing (M07); wallets, cash, transfers and daily closings (M08); suppliers and purchasing (M09); the order core with its state machine, reservation, Bangla invoices and delivery/return/exchange postings (M10); courier booking, status sync and COD settlement (M12); cross-org fraud check (M13); HR, attendance and payroll (M19); investors (M25). Built by parallel agents in dependency waves, then integrated and verified together. Committed one stacked branch per milestone, `m05-console-shell` → … → `m25-investors` → `integration-m05-m25`; only the integration tip builds on its own.
- Verification: `pnpm verify` exit 0 — 88 test files, 1,572 tests (1 skipped: the Steadfast live sandbox smoke test, no credentials); 183 routes, 178 driven as every membership role; 816 i18n keys in bn and en; schema drift checked across all 19 schemas. The production API boots and serves (`/health/live` 200, `/v1/me` 401 without a session).
- Auditors: ledger-auditor ran on M06–M10 (2 critical, both fixed with mutation-tested regressions), on M12 (4 critical, fixed), M19 (3 critical, fixed) and M25 (5 critical, fixed). **acceptance-auditor: NOT READY for all ten** (2026-09-28): 24 checks PARTIAL or MISSING. The ones that matter for money: no test could tell a return valued at dispatch cost from one at current WAC; the courier status-mapping test was circular (it took the vocabulary from the map itself); no scheduler or dead-letter path was exercised (courier booking, stock reconciliation, fraud refresh); the supplier statement check compared two copies of the same SQL; nothing swept every endpoint for cost fields. M05's axe, keyboard, screenshot and bundle-size checks are unbuilt, and several Build-list screens are missing (M08 reports and period close, M12 courier screens, M25 investor portal). Being closed now; no milestone in this batch is declared done until its gaps are.
- Gates found passing on nothing, all repaired: `check:schema` compared 3 of 19 schemas and its generator was dying on a snapshot-id collision while exiting 0; `COST_FIELDS` missed two cost columns so purchase cost reached the order desk; the fraud gate was bound under the wrong Symbol so orders kept a permissive default; the API could not start at all (Fastify 5 `loggerInstance`) with every test green, because nothing executed `main.api.ts`.
- Money defects found in review and fixed: an exchange that gave goods away free; a partial delivery that booked the buyer's prepayment as income; a zero-revenue delivery that could never post; every courier webhook booked at full COD; a polling cron that could never see an org through its own RLS; settlements and payroll runs under the approval threshold that could never post; a rejected investor withdrawal that permanently reduced the investor's headroom.
- Incident: a crashed background run left four M09 files at their correct size but entirely NUL. Rebuilt from the applied migrations and call sites; two restored byte-exact from `.turbo/cache`.
- Decisions/assumptions: D-095 to D-130 and D-186 to D-192 (M19's ids, cited in code). Unverified integrations: the Steadfast fraud provider and the Steadfast courier adapter, both off by default.
- New dependencies: none.
- Deviations from the milestone spec: one branch per milestone was produced retroactively from a single integrated tree. M11 (order desk UI, buyer list, public intake) is not built yet. D-117: investor withdrawals post at `paid`, not at every step as §15 says.
- Follow-ups: acceptance-auditor for each milestone (owner: claude); Playwright coverage of the console flows and M05's axe/keyboard/screenshot checks (owner: claude); **one HR user can disburse a staff loan they typed with no second person — §6 names no approval for staff loans** (owner: human decision); no refund path for a customer advance, and one advance per order (owner: claude, M16/M17); `ApprovalsService` runs executors only on approval, so rejected investor and settlement requests need manual `/reject` routes (owner: claude); **no git remote, so CI has never run** (owner: human).
- Next: M11, M15 and M23 in parallel, then M16, M18, M20 and M14a.

### 2026-10-01 · M11, M15, M23, M05's checks, M08's screens · Integration, audits and the money screens · partial

- Delivered:
  - **M11**, the order desk, buyer list and signed public order intake, integrated. **M15**, Pathao and RedX adapters, zone rules, bulk booking, public tracking, settlement fetch and the stuck-parcel queue, integrated.
  - **M23**, the showroom POS: an offline till that syncs each sale exactly once, holds anything it cannot post for a manager, prints an 80 mm Bangla receipt, and closes the branch day through M08's closing. Integrated with its ports bound to the real inventory, catalog and closing services; branch dashboards in the console.
  - **M05's deferred quality checks** built and passing against the real stack (navigation per role and org, URL filters, axe in both themes, keyboard traversal, 22 review screenshots, bundle budget in `pnpm verify`).
  - **M08's missing money screens**: transfers, a cash book per wallet, statements (P&L for any range and branch, balance sheet, aging), the ledger (trial balance, day book, account ledger), periods (close, request reopen) and the all-brands view.
  - Plan files for every built milestone, and the M03 and M04 progress entries that were never written.
- Verification:
  - `pnpm verify` was **not run in one piece**. The full run was stopped by the system for low memory and has not been restarted; it needs the user's go-ahead. Every gate was run separately instead:
  - format, lint (24 tasks), typecheck (24), build (15), `check:bundle` (221.2 KB of 250 KB), `check:migrations`, `check:schema` (schema, snapshot and 73 migrations agree), `check:routes` (248 routes, all declared, 241 matrix-tested, 7 public), `check:i18n` (1,669 keys in bn and en) and `check:api-client` (after regenerating the client: 248 operations). All pass.
  - Tests in four batches with two workers each: 116 files and about 1,965 tests, all passing after the fixes listed below.
  - Browser, real stack: 10 of 10 (M11 check 1 in 934 ms, check 4 in 96 ms; M05 checks 1, 2, 6, 7 and 10; the three money checks). Till offline spec: 3 of 3. Console stubbed specs: 13 of 13.
- Auditors: ledger-auditor on M23: 0 critical, 6 warnings. W1 to W4 fixed, each with a regression test that fails when its fix is reverted; W5 documented; W6 tests added. **acceptance-auditor has not been run** for M05, M08, M11, M15 or M23 in this wave.
- Found and fixed, beyond the audit:
  - The accounts screen was never routed, so the Accounts link opened a placeholder.
  - The UI kit's stylesheet never scanned the kit, so every dialog opened off screen on a long page.
  - Better Auth's limiter allowed five sign-ins a minute per address, locking out the sixth person in an office (D-168).
  - The two-factor enrolment screen raced two secrets in a development build.
  - The login screen and org switcher ignored the chosen language.
  - The first page shipped both languages; Bangla now loads on demand.
  - Four property tests could generate an invalid date; the portal's tracking test imported tables that no longer existed; the cost sweep did not cover intake or the POS.
  - `check:routes` printed PASS and never exited: intake's Valkey client, still connecting when the app closed, kept retrying for ever. The same would have stalled an API shutdown. It disconnects now.
  - The generated API client was stale by the whole wave's routes; regenerated.
- Decisions/assumptions: D-161 to D-169, D-173 to D-175, D-177. **D-161 is OPEN**: only org admin, accounts and a branch manager can operate a till.
- New dependencies: `@playwright/test` in `apps/pos`, from the catalog, for the till's browser spec.
- Deviations from the milestone spec: M23 check 1's browser half runs against a stub API; its stock and wallet half runs against real Postgres. M25's investor portal pages are still not built.
- Follow-ups: acceptance-auditor for M05, M08, M11, M15, M23 and a re-audit of M06-M13, M19, M25 (owner: claude); a UI-kit date field (owner: claude); party names in aging beyond suppliers (owner: claude); who operates a till, D-161 (owner: human); the three POS policy questions in decisions.md (owner: human); **no git remote, so CI has never run** (owner: human).
- Next: the acceptance audits, then M16, M18, M20 and M14a.

### 2026-10-01 · M05, M08, M12, M15, M23 · Closing the acceptance audit's gaps · partial

- Delivered, against the acceptance-auditor's report (M11 READY; M05, M08, M15 and M23 NOT READY, ten gaps):
  - **M08 check 2 and 6.** A petty-cash receipt now uploads from the "Record cash" dialog through the real ticket flow — private, purpose `petty-cash-receipt` — offered on every movement and required for petty cash. `money.stack.ts` records a ৳250 cash out with a receipt and finds it in the day book and the P&L.
  - **A wallet setup screen** at `/accounts/wallets`: add a wallet, edit its provider, its daily-count flag and whether it is in use. The list endpoint learned `includeInactive=true`, without which a closed wallet vanished from every screen and could not be reopened.
  - **Aging by open item** (D-193). It had bucketed every ledger line by its own date, so a ৳1,000 bill forty days old, part-paid ৳400 three days ago, read as ৳1,000 at 31–60 and −৳400 at 0–7: the right total and a report nobody could chase a debt from. A settlement now clears the oldest open amount first, and money paid ahead is shown apart and never aged.
  - **M23's till contract.** The sale, return and sync schemas moved to `packages/contracts`; the till imports their types and its offline stub validates every sync body with the same schema the real endpoint uses. An exchange now pairs only with its own branch's unpaired return, and a sale that names any other is kept and held as `exchange_mismatch` (D-195) rather than refused — the customer has already paid.
  - **Invariant 12, repaired** (D-199). The courier module joined `sales.couriers` — M10's table — in eight queries for a display name. It now asks `OrdersApi.courierParties` through its existing port. `module-boundaries.test.ts` then put every module under the same rule as a ratchet: today's cross-module reads are recorded as named debt and the list can only shrink, in both directions — a new one fails, and so does an entry that has been fixed but left behind. Eight modules are on it; the courier module is on none of it. Enum casts are excluded, because a cast names a type, not rows.
  - **M05 checks 1, 7 and 9** now prove what they claim: the catalog data follows an org switch, the keyboard run covers login and a data table with each primary action named, and the Bangla `size-adjust` is measured as applied rather than declared.
- Found while closing them, each worse than the gap that led to it:
  - **The API refused every cross-origin PUT, PATCH and DELETE.** `@fastify/cors` allows only GET, HEAD and POST unless told otherwise, so the catalog's price and image-order PUTs, the image and payroll-input DELETEs and the upload PUT had been failing their preflight in every browser — while every server test passed, because `inject` never preflights.
  - A receipt uploaded for an abandoned entry stayed in the form and would have posted as the evidence for the next one (ledger audit W1); one receipt could back any number of petty-cash entries, each under the approval threshold (W2, D-197); a wallet still holding money could be closed with one checkbox, stranding the cash off every screen while the balance sheet still counted it (W3, D-198).
  - Removing `courier_name` from the row types found a parcel list that mapped it into an inferred response: it would have become `undefined` at runtime with nothing failing.
  - **RedX's status vocabulary has no source** (D-200). Re-checked rather than assumed: the developer page 301s to a 404, the portal needs a merchant session, and the `redx-for-woocommerce` plugin was downloaded and has no status handling at all — it is also a community plugin, not RedX's own SDK, which the code had called it.
- Verification: `pnpm verify` was **again not run in one piece** — the earlier full run was stopped for low memory and still needs the user's go-ahead. Gates run separately, all passing: `check:schema` (75 migrations), `check:migrations`, `check:routes` (248 routes), `check:i18n`, `check:api-client`, format and lint. Tests by module: wallets 36, POS db 21, tenancy + POS e2e 84, courier + orders 204, domain courier 113, console unit 17. Browser: console real stack 14 of 14 (M05, M08 and M11 checks), till offline 3 of 3, console stubbed 13 of 13.
- Auditors: acceptance-auditor run on M05, M08, M11, M15 and M23 — its ten gaps are what this entry closes. ledger-auditor on the M08 gap work: 0 critical, 4 warnings, all four fixed with regression tests. **Both are owed a re-run** now the gaps are closed.
- Decisions/assumptions: D-193 to D-200. D-200 is OPEN and needs a RedX merchant account.
- New dependencies: `@radix-ui/react-popover` in `packages/ui`, from the catalog, for the notifications panel.
- Deviations from the milestone spec: M15 check 1 excludes RedX, for the reason D-200 gives. M25's investor portal pages are still not built.
- Still landing: the M05 notifications inbox (header bell, panel, `inbox.ts` reducer and its tests) is written but not yet committed, with its own plan update.
- Follow-ups: re-run both auditors (owner: claude); work down the module-boundary debt list — eight modules still read another's tables, each one a port waiting to be written (owner: claude); a UI-kit date field (owner: claude); party names in aging beyond suppliers (owner: claude); who operates a till, D-161 (owner: human); a RedX sandbox to close D-200 (owner: human); **no git remote, so CI has never run** (owner: human).
- Next: M16, then M18, M20 and M14a.
