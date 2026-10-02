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

### 2026-10-02 · M16 · Buyer profiles, notifications, basic promo codes · done

- Delivered:
  - **Promo codes.** Percent, flat and free delivery, with total and per-buyer limits,
    validity, channels, SKU or category scope, and personal codes. The order desk sends a
    code word, and the server prices it on its own lines after the agent's discount, then
    redeems in the order's transaction. A cancel before shipping gives the use back, and an
    order a code priced keeps its price.
  - **Notifications.** bn/en templates, opt-outs, quiet hours 21:00–09:00 Dhaka (checked when
    queued and again when sent), a delivery log, a fake gateway and an unverified BulkSMSBD
    adapter.
  - **CRM.** Nightly RFM segments, a daily birthday and anniversary greeting (one code and one
    message per buyer per occasion per year), the buyer profile with date capture, and the
    lapsed-buyer list with CSV/XLSX export, which leaves out opted-out numbers.
  - **Console.** `/customers` (search, profile, lapsed) and `/campaigns` (codes, templates,
    opt-outs, log), plus the desk's promo field.
- Verification: `pnpm verify` exits 0 at `3aaaa00` (5m22s; 133 test files, 2,188 tests). It also
  passed once before the acceptance-audit fixes (8m29s). The run at `a57e156` failed one pre-M16
  intake test, whose `now + 301` timestamp drifted into the signature window under load; that is
  fixed in `3aaaa00`. Acceptance checks 1–5 pass:
  1. `crm.test.ts` and `crm.db.test.ts`;
  2. `crm.db.test.ts` (run twice, a race, and a deterministic 23505);
  3. `promo.test.ts` and `promo.db.test.ts`;
  4. `notify.test.ts` and `notify.db.test.ts`;
  5. `order-desk.stack.ts`.

  Real-stack browser runs: `order-desk.stack.ts` 3/3 and `crm.stack.ts` 4/4 (axe in both themes,
  screenshots in `docs/review/M16/`).

- Auditors:
  - ledger-auditor: 2 critical and 8 warnings, all fixed with tests. The re-check found 0 and
    0, and its one "should not wait" item (`campaignId` without an FK) is fixed.
  - acceptance-auditor: NOT READY with 7 gaps, then 1 on re-audit, then **READY** at `3aaaa00`.
    The gaps were:
    - date capture in the console, with clearing;
    - BulkSMSBD tests against a local stub;
    - this entry;
    - D-210 to D-212;
    - architecture.md's CRM schema and jobs;
    - stale "arrives in M16" comments.
- Decisions/assumptions:
  - D-203 to D-212, and an update to D-202.
  - D-207 is a platform finding: a `singletonKey` was enforced on no queue, so courier
    booking could double-book. Its remedy sentence is corrected.
  - D-209 keeps the till on `NoPromoCodes`.
- New dependencies: none.
- Deviations from the milestone spec:
  - The till does not take promo codes (D-209).
  - The occasion offer is a constant (D-206).
  - OTPs and invites are not routed through notify (D-212).
- Also on this branch:
  - **A fresh `.env` now boots the API, and a failed boot prints why.** Empty dotenv values are
    read as unset, and Nest is set to `abortOnError: false`. The stack harness had been showing
    only "never came up".
  - Merged `m11-order-desk` (five commits, one decisions.md conflict).
  - A parallel session committed into this worktree once (676bbe8). It is reconciled, and that
    session moved to M14a in its own worktree.
- Follow-ups:
  - Run `docs/runbooks/queue-policy.md` on the shared dev database, whose courier queues are
    still `standard`. Do it before any pilot. (owner: human)
  - Promo code terms are frozen by the service only; add a trigger in a migration this branch
    can claim. (ledger audit N2; owner: claude)
  - Composite FKs for `promo.codes.campaign_id` when M18 lands, and the polymorphic
    `notify.messages.ref_id`. (N3; owner: claude)
  - Lock order between create and cancel for the same buyer and code. (N4; owner: claude)
  - A sending lease, so one SMS cannot go out twice on a redelivered job. (N5; owner: claude)
  - Sales can list every personal code and redemption, and resellers can read profiles; both
    are ids only. (N6; owner: claude)
  - Smaller edges: an FK 500 on a foreign `customerId`, `archived → active`, category scope
    without parents, and `limit_reached` reported on a concurrent pause. (N8; owner: claude)
  - The till's re-count must exclude its own sale when D-209 is built. (owner: claude)
  - Route OTPs and invites through notify once a gateway is verified. (D-212; owner: claude)
  - BulkSMSBD credentials, or the client's own gateway, to close D-012. (owner: human)
- Next: M18, then M20 and M14a, which a parallel session is doing in its own worktree.

### 2026-10-02 · scope · The owner narrows the ERP, and the fraud check is deleted · done

- Delivered:
  - **`docs/build-status.md`**: a plain-language view of how much is built, by business area and by milestone, with a percentage. Kept current every session.
  - **Scope cut by the owner** ("build the erp just"): the landing page builder (M29) and the Chatwoot inbox (M27) are out (D-290); the staff activity extension (M28) is out (D-292); the fraud check is out **and its code deleted** (D-291). 27 milestones remain in scope.
  - **The fraud removal** (`remove-fraud`): M13's module, domain rules, six tables, the three fraud columns on orders, two permission subjects, an event, a flag, a bench and the order desk's trust badge. Confirming an order is now the state machine alone. Migration 0080 drops it all. M17 keeps only its accounting half: advance payments and return reasons.
  - M14a and M16 had both taken D-208, and M14a's migration was numbered 0090; M14a now has D-213 and its migrations sit on top of the fraud removal.
- Verification: `pnpm verify` exits 0 on `remove-fraud` at `5741b44` (256 routes, 79 migrations, schema drift clean, i18n 1,944 keys, bundle 227.1 KB). The first run failed one test, a stock property whose coverage check depended on 30 random runs reaching a committed release; its seed is now pinned.
- Auditors: none run on the removal — it deletes a gate rather than adding one, and the full suite covers what remains. The ledger-auditor should still see the confirm path at the next integration.
- Decisions/assumptions: D-290, D-291, D-292.
- New dependencies: none.
- Deviations from the milestone spec: M13 removed after being built; M17 rewritten to its accounting half.
- Follow-ups: a machine-wide lock (`D:/Projects/erp-tools/heavy.mjs`, outside the repo) now serialises heavy runs between parallel builders (owner: claude); the `apps/sites`, `packages/landing-blocks` and `apps/extension` scaffolds are unused and can be deleted if the owner wants (owner: human).
- Next: M14a, M17, M18 and M20 in parallel, each on its own branch stacked on `remove-fraud`; then integration, M24, M26 and M25's investor pages.

### 2026-10-02 · M14a · Data migration and opening balances · done

- Delivered:
  - **Six importers**, each a dry run and an all-or-nothing commit, run by the
    implementation team with `pnpm migration` (D-214):
    - SKUs keep the brand's own codes (D-219), and customers arrive with their delivered,
      returned and cancelled counts and what they spent (D-218). Both apply on commit.
    - Opening stock per location with unit cost, supplier dues and advances, wallet
      balances and courier COD in transit are staged (D-215). One cost per SKU (D-216).
    - The same file twice is one import (D-217).
  - **The opening.** One `post` writes the opening stock movements and one journal, dated
    the evening before go-live (today or yesterday, D-221), to `3350 Opening balance
equity` (D-213). It runs once per brand and names the accountant who agreed the staged
    trial balance.
  - **The reconciliation.** Imported, journal and module figures side by side per line,
    written as CSV for the accountant, with a sign-off recorded once and only when every
    line agrees (D-222).
  - **The training org.** `pnpm demo:org` seeds it and runs the anonymised sample files
    through the real importers and the opening (D-223). It is left out of the consolidated
    reads, and notify sends nothing from it.
- Verification: `pnpm verify` exits 0 at `5a289df` (259 s; 131 test files, 2,207 passed, 1
  skipped, which is not M14a's). An earlier full run at `d497064` passed too (365 s; 2,205 passed, 1 skipped,
  not M14a's). Acceptance checks 1–5 pass in
  `apps/server/src/modules/migration/migration.db.test.ts`, with the domain halves in
  `packages/domain/src/migration/migration.test.ts` and
  `packages/domain/src/posting/opening-balance.test.ts`:
  1. "the dry run shows a balanced opening trial balance" — stock = Σ(qty × cost) from the
     sample file's own text, ৳151,308.75, 186 units; the property test holds it for any rows;
  2. "a bad row anywhere leaves no partial state" — a bad last row in each of the six
     importers, and the last product, the last buyer and the journal after its movements
     failing inside the transaction;
  3. "the same file twice is one import" — all six re-run, and edited files add only what
     is new;
  4. "check 4: posts one journal whose trial balance is zero and whose stock is the
     valuation" — debits = credits = ৳464,849.50, inventory line = `InventoryApi.valuation`
     to the poisha;
  5. "the reconciliation report" agrees on all nine lines, flags a drifted wallet, and
     records one sign-off. A generated copy for the training org is in
     `docs/review/M14a/reconciliation-training.csv`, from `pnpm demo:org` and
     `pnpm migration reconcile` run against a throwaway database. **Human:** the client's
     accountant signs the pilot brand's report before go-live.
- Auditors:
  - ledger-auditor: 1 critical — commits, discards and the post were not serialised per
    brand — fixed in `6694e37` with a per-brand advisory lock. Its 3 warnings and 7 notes:
    - W1–W3 and N1, N3–N6 fixed in `1d884ba`;
    - N2 recorded as D-224;
    - N7 logged as a follow-up below.

    The re-check found 0 critical and 0 warnings. Its three notes are logged below or are
    the expected migration-number clash with sibling branches.

  - acceptance-auditor: NOT READY with 5 gaps, all closed:
    - discard and status had no tests (now `a staged file set aside`);
    - this entry was not final;
    - N2 and N7 were not accounted for;
    - the plans index and this plan's status were stale (`docs/build-status.md` is left to
      its owner, as instructed);
    - CLAUDE.md's `demo:org` line was incomplete.

    Re-audit at `5a289df`: **READY**.
- Decisions/assumptions: D-213 (amended: no re-opening), D-214 to D-224.
- New dependencies: none.
- Deviations from the milestone spec:
  - No console screen; the importers are a command (D-214).
  - Customers carry no fraud signals, because the fraud check is gone (D-291).
  - The opening date is today or yesterday only (D-221).
- Follow-ups:
  - The client's accountant signs the pilot brand's reconciliation. (owner: human)
  - Re-run `pnpm db:seed` on every existing database before a migration, so each brand
    has `3350 Opening balance equity`. Add it to M14b's go-live runbook. (owner: claude)
  - M12's settlement import should clear a legacy pre-go-live COD reference against the
    opening receivable (D-220). (owner: claude)
  - Ask whether any brand needs a cut-off older than the day before go-live (D-221).
    (owner: human)
  - Decide whether wrong supplier dues or courier receivables found after the opening need
    a correcting path. There is no manual journal (D-088, D-213 amended). (owner: human)
  - A correction found after the opening lands in profit and loss (a stock adjustment or
    a cash over/short), not in opening equity. Tell the client's accountant before the
    pilot, and add an "opening correction" posting rule against `3350` if they want one.
    (owner: human, then claude)
  - Run and sign the reconciliation after the post and before the brand trades. Stock is
    valued now, so the report moves after the first sale. Put this in M14b's go-live
    runbook. (owner: claude)
  - Every branch that starts from `5741b44` (M17, M18, M20 and this one) uses migrations
    0081 onwards. Whichever merges second regenerates its migrations on top. (owner:
    integrator)
  - A console screen if brands are to migrate themselves (D-214). (owner: claude)
  - A CSV file takes at most 5,000 rows, so split a larger customers export into several
    files. Each file is its own import. (owner: human)
- Next: M14b.

### 2026-10-02 · M18 · Marketing: campaigns, spend, attribution, Meta import and conversions · done

- Delivered: per-brand campaigns mapped to Meta campaign and ad ids and UTM names; daily ad spend, typed by hand or imported from Meta Insights; leads; re-engagement segments with a hashed Meta audience file; the §11 dashboard (spend, CPO, CPDO, ROAS, the attribution split, a daily series) from real orders, with attribution resolved when read; one hashed Conversions API `Purchase` per delivered order, sent once. Console screens for each. Branch `m18-marketing`, stacked on `remove-fraud`.
- Verification: `pnpm verify` exit 0; checks 1-4 PASS (evidence table in `docs/plans/M18.md`); the marketing database suite passes 26/26 against real Postgres.
- Auditors: acceptance-auditor findings fixed in `560dddb`. ledger-auditor: 0 critical, 3 warnings, all fixed: the spend import could count spend twice (unmapped hand-typed spend, a moved Meta id, concurrent imports), and two Meta campaigns on one campaign overwrote each other; a conversion Meta accepted was logged as failed if recording it failed; the dashboard bound one parameter per order. Tests added for each.
- Decisions/assumptions: D-250 to D-262; D-252, D-254 and D-256 extended after the ledger audit.
- New dependencies: none.
- Deviations from the milestone spec: none. Both Meta adapters are unverified and off (D-257).
- Also: `idempotency.e2e.test.ts` gives its harness teardown 60 s, as the other harness suites do; it overran vitest's 10 s default under load.
- Follow-ups: verify the Meta adapters with a brand's token, pixel and test event code (owner: human); check a campaign's `productIds` against the catalog, which nothing reads yet (owner: claude); decide whether the buyers-consented switch should be org_admin only rather than marketing (owner: human); service-level cross-org tests for the connection, conversions and spend beyond the RLS guard test (owner: claude).
- Next: whatever the coordinating session schedules; not started are M14b, M17, M20, M24, M26 and M30.

### 2026-10-02 · M17 · Advance payments and return reasons · done

- Delivered (branch `m17-advances`, from `remove-fraud`; the fraud half was removed by the owner,
  D-291):
  - **Advances that someone checked (D-013, D-230).** The desk records a buyer's bKash, Nagad
    or bank payment as a claim (transaction id, amount); nothing posts and the COD does not
    move. Accounts verifies it into the wallet it arrived in — never the person who recorded
    it — which posts Dr Wallet / Cr Customer advance per advance and lowers the COD; or rejects
    it. Several payments per order; one live claim per transaction id per brand. The old
    `POST /v1/orders/:id/advance` and the create body's `advancePaidPoisha` (both let an
    unchecked amount reach the books) are gone.
  - **Its endings (D-231 to D-233, D-236).** Applied on delivery (oldest first, after any
    exchange credit). On a cancel or a return, kept or refunded per the brand's policy
    (`orders.advance_on_cancel` = refund, `orders.advance_on_return` = forfeit by default),
    keeping at most the delivery charge; a refund is owed at the ending and posted when
    accounts records it. A verification can wait for a booked parcel, settle at once on an
    ended order, or be voided with a reversal journal before the parcel moves.
  - **Return reasons (D-234).** A reason from a fixed list of eleven on every return and
    exchange, refused by the state machine and by a deferred trigger without one, stored per
    order, and a report by reason (`GET /v1/orders/return-reasons`).
  - **Console.** An Advances panel on the order (record; accounts can undo a verification), an
    Advances queue under Accounts (verify, reject, record a refund), a required reason on the
    courier returns dialog, and a Returns by reason page. bn and en.
- Verification: `pnpm verify` exits 0 at `f0c19ea` plus these docs (131 test files, 2,196 tests),
  after one rerun: the run before it failed only `dispatcher.db.test.ts`'s `afterAll` hook (a
  10 s timeout stopping its Testcontainer under load; all its tests passed, and the suite passes
  alone). It also passed at `1e86c7a` (131 files, 2,194 tests). Acceptance checks 1–3 pass:
  1. `advances.db.test.ts` › check 1 (applied on delivery; refunded on cancel with two
     payments; a keep policy keeping only the delivery charge; plus the refused-parcel and
     partial-delivery endings), hand-computed balances and a zero trial balance;
  2. `advances.db.test.ts` › check 2 and `orders.e2e.test.ts` › M17 check 2 (HTTP);
  3. `returns.test.ts` and `advances.db.test.ts` › check 3; `courier.db.test.ts` for the
     courier returns path.

  Real-stack browser run: `advances.stack.ts` 3/3 (claim, verification by a second-factor
  accounts user, the report; axe in both themes; screenshots in `docs/review/M17/`) and
  `order-desk.stack.ts` 3/3.

- Auditors:
  - ledger-auditor: 0 critical, 4 warnings. W1 (a booking racing a verification), W2 (no way
    to undo a mistaken verification) and W3 (missing race, cap, credit and RLS tests) are fixed
    with tests in `1e86c7a`; W4 (migration numbers 0081–0082 collide with M14a, M18 and M20) is
    the integrator's. The re-check found 0 critical and 1 new warning
    (a void by the verifier, now refused by the service and a CHECK in `f0c19ea`).
  - acceptance-auditor: NOT READY with 5 gaps, then 1 on re-audit at `f0c19ea`. Closed: the
    void's timeline label, a table test pinning the advance effects on every row, database
    assertions that fail only for the rule they name, and the courier path's recorded reason.
    Open: CLAUDE.md's Commands line should name `advances.stack.ts` and `docs/review/M17/` in
    the `e2e:stack` entry. Not edited here: CLAUDE.md changes are the owner's to make.
- Decisions/assumptions: D-230 to D-236 (D-232 ASSUMED: the policy defaults and the
  delivery-charge cap). D-099 and D-101 carry update notes; D-013 stays OPEN only for an
  optional gateway.
- Migrations: `0081_m17_advances_returns_schema.sql` (generated), `0082_m17_advances_returns_policies.sql`
  (RLS, grants, the advance path trigger, the born-pending insert guard, and the deferred
  return-reason trigger). They will collide with sibling branches' 0081+ at integration.
- New dependencies: none.
- Deviations from the milestone spec: none in scope. Added beyond the checks, from the ledger
  audit: the void path (D-236) and the booking lock (D-231).
- Closes M10's follow-up "no refund path for a customer advance, and one advance per order".
- Follow-ups:
  - CLAUDE.md, Commands, `e2e:stack` line: add "M17's advance claim, verification and
    returns-by-reason screens (`advances.stack.ts`)" and `docs/review/M17/`. (owner: human)
  - Renumber 0081–0082 at integration; any database that applied an earlier m17-advances
    0081 must be rebuilt (the file and its journal `when` changed before merge). (owner:
    claude, integrator)
  - A settings screen for `orders.advance_on_cancel` / `orders.advance_on_return`. (owner: claude)
  - Exchange credits and pre-M17 advances (an advance column with no rows) have no refund path
    of their own (D-233). (owner: claude)
  - The return-reason trigger covers status updates, not inserts: a data import (M14a) should
    write `sales.order_returns` for historical returns or accept that the report starts at
    M17. (owner: claude)
  - Refunds are one person's act; add maker-checker if the client wants it (D-232). (owner: human)
  - Verify and refund journals are dated when accounts acts, not when the bKash money moved.
    (owner: human, a client question)
- Next: integration of M17 with M18, M20 and M14a.

### 2026-10-02 · M20 · Targets, bonus rules, productivity · done

- Delivered:
  - **Targets.** A monthly target per employee or per team on confirmed orders, delivered
    orders or delivered revenue. The month is split into Saturday-start weeks by the working
    days in the employee's M19 calendar, using largest remainder, so the weeks always sum to
    the month. Progress is rolled up from `OrdersApi.agentResults`, counted for the agent who
    confirmed the order (D-272). `target.progress` reaches the employee and HR only when the
    achieved figure moves. The worker refreshes progress once per org per ten-second bucket
    (D-279). A target is set only for the current Dhaka month or a later one (D-280).
  - **Bonus rules into payroll.** These are versioned JSON with a pure evaluator: cumulative
    tiers, per unit, basis points of excess revenue, and a cap. A version is previewed against
    a month, submitted by its author and approved by someone else through the approvals
    module. The executor and 0083 activate only the version that names the request. Applying
    rules to a draft run (`POST /v1/hr/payroll/runs/:id/bonuses`) replaces the run's rule-made
    bonus inputs, and only for employees the run pays. Payroll submit recomputes under the run
    lock, refuses changed inputs and freezes what it recomputed (D-280).
  - **Productivity.** `hr.desk_events` is written from the outbox's order events. It gives
    pickup time (median and p90, nearest rank; a reassignment restarts the clock for the new
    assignee) and orders per active hour, where an active hour is a Dhaka clock hour with a
    desk action (D-276). `events.outbox.actor_user_id` records who acted (D-277).
  - **Console.** `/performance` (the agent's own dashboard), `/performance/targets`,
    `/performance/bonus-rules`, `/performance/productivity`, and a Bonuses panel on the payroll
    run.
  - 14 routes, in the route matrix with fixtures. Migrations 0081–0083.
- Verification: `pnpm verify` exits 0 at `a53f30d` (131 test files: 2,240 passed, 1 skipped).
  It also passed at each fix commit before that: `66e3b4c`, `4e21161` and `4215f61`.
  An earlier run failed only `dispatcher.db.test.ts`: every test passed, but its `afterAll`
  teardown hit the default 10 s under the full parallel run. It now gets the 60 s the other
  database suites have. Acceptance checks 1–4 pass:
  1. `targets.test.ts`, "the weekly split": fast-check over 500 months from 2000 to 2099 with
     random weekly offs, holidays and totals up to 9×10^11, plus Eid, zero-working-day and
     one-unit tables. Through the API, August 2026 splits as 3/2/2/2/1 over 6/6/6/6/3 working
     days.
  2. `targets.test.ts`, "the bonus evaluator": §12's example over ten rows, plus per unit,
     basis points, the cap (with a property), parser refusals and a zero target. Through the
     API, a 12-of-10 agent previews ৳2,100 and is paid it.
  3. `targets.test.ts`, ten seeded streams (reassignment before and after pickup, a
     supervisor's action, duplicated and shuffled events). `performance.e2e.test.ts` runs the
     real outbox → dispatcher → `hr.desk_events` → HTTP path: 240 s, 120 s after a
     reassignment, and 30 s, with a median of 30 s and a p90 of 120 s.
  4. `performance.e2e.test.ts`, over HTTP. An agent sees only their own target, productivity
     row and dashboard, gets 404 on another agent's target, and gets 403 on bonus rules and on
     setting targets. A branch manager sees only their branch. In `performance.db.test.ts`,
     another brand reads nothing from the seven M20 tables and is refused writes.

  Real-stack browser run (`e2e:stack`, after the build, at `4215f61`): 20/20 in 3.1 min. It boots the built
  worker with the HR module, and M11 check 4 passes through it (852 ms). The first attempt
  failed 6 and left 14 unrun, because another session's stack held ports 3110 and 5183
  (`EADDRINUSE`) and the specs ran against that stack. The M05 review screenshots now show
  the Performance entry.

- Auditors:
  - ledger-auditor: 0 critical and 7 warnings, all fixed with tests in `2356438`. The re-check
    found 0 critical and 2 warnings: an input or award write that never locked the run could
    land between submit's recompute and its commit, and a cancelled target's bonus could
    still be approved on a waiting run. Both are fixed in `4215f61`, with a two-transaction
    test.
  - The confirmation pass on `4215f61` found 0 critical and 1 warning, and both re-check
    warnings closed. The warning: a cancel could still pass its check while a submit
    committed, because nothing locked the run. Its notes:
    - the new run locks could deadlock a removal against an apply, or return a 500 to a
      checker approving during a submit;
    - an older unlocked read let an apply pay a target cancelled under it;
    - the late approval was audited as the author's.

    All are fixed with tests in `4e21161`:
    - a cancel locks the target `for no key update` and the month's runs `for share`;
    - every remover takes the run before its inputs;
    - submit refuses a bonus for a cancelled target or a replaced rule;
    - a found decision is audited as `activated`.

  - The confirmation of `4e21161` closed all of that and found 0 critical and 1 warning. A
    version supersede locked the approved version `for update` and then waited for the draft
    runs, while an apply holding a run waited on that version through its award's foreign
    key: a deadlock, and a 500 for the checker. Fixed in `66e3b4c` with `for no key update`,
    and a two-transaction test that fails with "deadlock detected" on the old lock. Its
    notes are done too: a cancel locks only its month's runs, and submit refuses a stale
    bonus before raising any approval request.
  - The confirmation of `66e3b4c`: **0 critical, 0 warnings**. It also checked that the
    version locks still taken `for update` (draft or pending versions, which no award
    references) form no cycle with an apply. Its one test note is done in `a53f30d`.

  - acceptance-auditor: NOT READY with 3 gaps, all docs: the plans index, `build-status.md`,
    and two outbox comments that contradicted D-277. Then NOT READY with 2: this entry
    unfinished and the docs uncommitted. Then **READY** at `314eabc`, with the M20 and HR suites
    re-run.
    The re-audit found no check weakened by `4215f61`. It also corrected the cross-brand write
    test, which no longer accepts a foreign-key error, since a foreign-key check ignores RLS.
- Decisions/assumptions: D-270 to D-280. D-271, D-272 and D-273 are ASSUMED. D-280 was extended
  by the re-check.
- New dependencies: none. `@elysium/domain` gains a `./targets` export.
- Deviations from the milestone spec:
  - Team targets track progress but pay no bonus (D-273), and the console creates employee
    targets only; team targets are API-only.
  - An active hour is a clock hour with a desk action, not real active time, because M28 is
    out of scope (D-276, D-292).
- Also on this branch:
  - The work was stopped by the owner, then restacked onto the fraud removal (D-291) as
    `31eccef`; the originals are at `backup/m20-pre-restack`.
  - `events.outbox` gained `actor_user_id` for every emitter (D-277), not just M20's.
- Follow-ups:
  - **Migration numbers collide with M18.** `m18-marketing` also ships 0081–0083. Whichever
    branch merges second must renumber its migrations and regenerate the drizzle snapshot.
    (owner: claude)
  - 0083 was edited on this branch after it was first committed. That is allowed because it
    is not on main, but the migrator does not compare hashes, so a database that applied the
    earlier 0083 keeps the unlocked guards without warning. Reset any local database that
    ran this branch. (owner: claude)
  - HR reads `approvals.approval_requests` directly through `approvalStatus`, an M19 pattern
    that M20 reuses for bonus versions. The approvals module needs an `*.api.ts` (invariant
    12; ledger audit N11). (owner: claude)
  - `GET /payroll/runs/:id/bonuses` does not return the last apply's `skipped` list, and a
    draft run shows no "rules changed since the last apply" hint after a supersede removes
    its bonuses. (re-check notes; owner: claude)
  - A target set late in its own month has no checker (D-280). Show each award's target
    creation date in the run's Bonuses panel for the payroll checker, or give targets an
    approval if the client wants it closed. (owner: claude; the choice is the client's)
  - How a team bonus is shared, to close D-273. (owner: human)
  - No test drives `hr.refresh_target_progress` through pg-boss end to end. The enqueue and
    `refreshOrg` are each tested, and the stack run boots the worker. (owner: claude)
  - Assert that `target.progress` rooms exclude other agents, not only that they include the
    member and HR. (owner: claude)
  - Team targets in the console, and a stubbed Playwright spec for `/performance`. The 13 M20
    console files have no test of their own; check 4 is proved over HTTP. (owner: claude)
- Next: M14a in its own worktree. M24 waits for M18.

### 2026-10-02 · M25 · Investor portal pages, with 2FA mandatory · done

- Delivered (branch `m25-investor-portal`, from `integration-wave2`; not merged):
  - **The investor's own pages at `/investor` in `apps/portal`** (D-310). Bangla first with an
    English toggle, light and dark. Sign-in is the console's journey against the same Better
    Auth endpoints: an investor who has not enrolled a second factor gets the enrolment screen
    and nothing else, because the server's enrolment wall refuses every other route until a
    code verifies; a returning investor needs their authenticator code or a recovery code.
  - **What an investor sees, one brand at a time** (D-311): their position (capital held,
    under lock-in, withdrawable, profit declared, paid and owed), their contributions with each
    lot's lock-in, the profit declared to them (from their own statement), their withdrawals
    with each status, their statement, and their documents, each opened through a URL minted
    for that click. A switcher when they invest in more than one brand. Exited investors
    still see their row. No withdrawal form: the role is read-only, so the page tells them to
    ask the brand's accounts team (D-312).
  - **The browser half of check 1, against the real stack** (D-313):
    `apps/portal/e2e/investor.stack.ts`, run with `pnpm --filter @elysium/portal e2e:stack`.
    A throwaway database whose money is posted through the real API in process
    (`investor-portal-stack.provision.ts`), the built API and worker, and the portal. Chosen
    over the till's stub pattern because isolation is the server's property; a stub could only
    show that the page draws what the stub returns.
  - **From the ledger audit** (server): nobody raises, reviews, approves or pays a withdrawal
    paid to themselves (D-314); an investor's own row omits the brand's staff notes and the
    signed document URL is `no-store` (D-315). Portal: figures cached per signed-in user and
    brand, and the portal never moves the session's brand on its own except when none is
    chosen (the session is shared with the console).
- Verification: `pnpm verify` exits 0 at `103f589` (144 test files, 2,374 tests passed, 1 skipped;
  bundle 231.9 KB of 250 KB, route matrix, i18n, api-client, migration and schema checks PASS)
  plus this entry and one test assertion (the D-314 message). Acceptance checks:
  1. API: `investors.e2e.test.ts` › "check 1" (11 tests) and "check 1: an investor's withdrawal
     list holds only their own requests"; `investors-tenancy.test.ts`. Browser:
     `investor.stack.ts` 6/6 (two investors, one in two brands; each enrols, sees their own
     figures and none of the other's on the page, and the other's rows answer 404 or nothing
     from inside the same session; a second investor signing in at the same tab after the first
     one's session ended sees none of the first one's figures). The new browser tests were
     mutation-checked: removing the per-user cache keys fails test 6.
  2. `investors.e2e.test.ts` › "check 2" (13 tests, including D-314, mutation-checked).
  3. `investors.e2e.test.ts` › "check 3" (6 tests, now asserting `no-store`) and
     `investor.stack.ts` › "a document opens only through a URL minted for that click".

  axe (WCAG 2.1 AA, no serious or critical) on the sign-in, enrolment, second-factor and
  dashboard screens in both themes, in Bangla and at phone width; it found a scrollable table
  with no keyboard access at phone width, now fixed. Screenshots in `docs/review/M25/` (the
  setup key and recovery codes masked).

- Auditors:
  - ledger-auditor: 0 critical, 4 warnings (portal cache not keyed by user; the portal moving
    the console's brand on window focus; exited investors hidden; a staff member who is also
    the investor could sign for their own withdrawal). All fixed with tests; the re-check
    found 0 critical, 0 warnings, and five notes listed under follow-ups.
  - acceptance-auditor: NOT READY with 3 documentation gaps and no code gaps (the plan's
    Status, architecture §15 still saying every withdrawal step posts, and CLAUDE.md's
    Commands). The first two are fixed. The re-audit at `103f589`:
    NOT READY with one gap, the CLAUDE.md Commands line below, which only the owner edits; READY
    once it is added. Its nit (pin the D-314 test to the beneficiary message) is done.
- Decisions/assumptions: D-310 to D-315. D-120 carries an update note (superseded for
  investors).
- New dependencies (all already in the catalog, new to `apps/portal`): `@tanstack/react-query`
  (server state per brand and user, cancellation on a brand switch), `react-hook-form` and
  `@hookform/resolvers` (the sign-in forms, as the console's, validated with the shared Zod
  schemas), `@playwright/test` and `@axe-core/playwright` (the real-stack spec and its
  accessibility checks).
- Deviations from the milestone spec: none. Not built, by decision: a withdrawal request from
  the portal (D-312) and a cross-brand total (D-311).
- Fixed in passing: `dispatcher.db.test.ts` and `realtime.e2e.test.ts` gave their `afterAll` only
  vitest's 10 s default, which a loaded `pnpm verify` outlasted on three runs here (and on M17's);
  both now get the 60 s the other 32 database suites use (`103f589`, test-only). One other run
  failed on the shared Postgres running out of lock memory (`max_locks_per_transaction`) and
  passed on the next run with nothing else changed.
- Follow-ups:
  - CLAUDE.md, Commands: add "`pnpm --filter @elysium/portal e2e:stack` runs the portal's
    `investor.stack.ts` against the real stack (a throwaway database seeded through the real
    API, the built API and worker, and the portal). Build the server first. It covers M25
    check 1's browser half and writes review screenshots to `docs/review/M25/`." (owner: human)
  - The "Withdrawable capital" tile is not net of requests already waiting. (owner: claude)
  - Linking a login to an investor row is one person's act and cannot be undone; consider
    maker-checker, which would also close D-314's gap for a link made after a request was
    signed. (owner: human)
  - The distributions table shows the day a profit was declared, not the month it was for.
    (owner: claude)
  - The server suite's checker is a super admin; rerun the flow with `accounts` as checker
    (D-119). (owner: claude)
  - Commit `260e199` holds an unmasked enrolment screenshot of a throwaway user in a dropped
    database: harmless, but a secret scanner will flag it. (owner: human, at merge)
  - D-310 to D-315 do not collide with the main worktree today; check again at merge, as M26
    is being built in parallel. (owner: claude, integrator)
- Next: integration of M25's portal into the wave-2 branch.

### 2026-10-02 · M24 · Analytics, dashboards, leaderboard · done

- Delivered:
  - **Rollups.** A new `analytics` schema with five daily tables (brand, showroom, channel,
    campaign, agent), rebuilt per brand from the owning modules' interfaces — orders, the new
    `MarketingApi`, HR — never incremented (D-320, D-321). The worker recomputes the day on
    order events (one job per brand per ten seconds), nightly for the last seven days, and the
    org admin can recompute up to 92 days from the dashboard. Migrations 0092–0093.
  - **The brand dashboard** (`/analytics`, a new `Dashboard` subject for org_admin, D-325):
    orders placed to returned, delivered revenue, gross profit, AOV, return rate, delivery
    success, spend, CPO, CPDO, ROAS, desk pickup, cash in wallets and stock value, by channel,
    showroom and campaign, best sellers and agents, a daily revenue chart, and CSV/XLSX export
    (D-328, D-330).
  - **All brands** for Super Admin, through the read-only analytics role.
  - **The leaderboard**: seven normalized metrics per brand per month, ranked, with a weighted
    composite (weights are configuration). An org admin sees every brand's rates and ranks
    and only their own brand's revenue (D-023 as D-322 to D-324).
  - **Insight rules**: seven, as pure functions with thresholds (D-326), worded in bn and en.
  - **LLM narrative**: off by default behind `analytics.llm_narrative`; an allow-list payload
    with a guard, a daily cache and a fake provider. No real provider was built (D-327).
- Verification: `pnpm verify` exit 0 at `ee833e0` (153 test files: 2,540 passed, 1 skipped)
  and again at `6f54975` after the ledger audit's fixes (2,542 passed, 1 skipped). The final
  run at `35d7027`, after the acceptance audit's gaps were closed: exit 0, 154 files, 2,552
  passed, 1 skipped.
  Acceptance checks 1–4 pass; the evidence table is in the plan:
  1. `rollup.db.test.ts`: all five tables equal direct SQL over two seeded brands, after a
     rerun, a partial rerun, overlapping recomputes, a spend correction and the worker's
     handler. A deliberately broken rollup fails it. The triggers are tested too: the nightly
     fan-out (one job per brand, collapsed on a rerun) and an order event's job (its own Dhaka
     day through today, one per ten-second bucket, started after the bucket) in `pgboss.job`.
  2. `analytics.e2e.test.ts`: two org admins, Super Admin and every other role, over HTTP.
  3. `insights.test.ts`: every rule fired, held one basis point (or second) under its
     threshold, and silenced by a small sample in each month it reads; removing any of the
     sample guards fails a test. One rule also fires over HTTP against the group median.
  4. `narrative.test.ts`: planted personal data, a 300-run property and the guard; the HTTP
     test reads the prompt the fake provider received.
- Auditors:
  - ledger-auditor: 0 critical, 2 warnings, both fixed in `cb0f8cb`. W1: the first cut
    opened all five rollups to `erp_analytics`; only `daily_org` is read across brands, so
    only it is now. W2: gross profit beside revenue gives cost of goods, so the leaderboard and
    the group medians read a variant without it. Its notes on overlapping recomputes, an
    event's own day, the agents' pickup rounding and the fake's prompt list are done too.
  - ledger-auditor re-check of `cb0f8cb`: **0 critical, 0 warnings**; its one new note (an
    event's range unbounded after a 92-day outage) is fixed in `62a4b36`.
  - acceptance-auditor: NOT READY with 4 gaps, all closed: three insight rules lacked a
    sample or boundary case; the rollup's triggers (nightly fan-out, the event job) were
    untested; the plan's status ended in a placeholder; and this entry did not say 0093 was
    edited in place. Its re-audit at `35d7027`: **READY**.
- Decisions/assumptions: D-320 to D-330. D-323 and D-326 are ASSUMED.
- New dependencies: none. `@elysium/domain` gains an `./analytics` export.
- Deviations from the milestone spec:
  - Response time is not on the leaderboard: it was the Message Hub's figure (D-290).
  - Pickup time is the mean, not M20's median, because a median cannot be summed from days
    (D-322).
  - No `leaderboard.updated` event: the board is computed on read (D-324).
- Also on this branch: M18's dashboard attribution moved into `attribution.reader.ts`, shared
  with the rollup; `FlagsModule` now has its first runtime reader.
- Follow-ups:
  - **Migration numbers.** 0092–0093 collide with M26's; the integration renumbers. (owner:
    claude)
  - 0093 was edited on this branch after it was first committed (`cb0f8cb`, the ledger
    audit's W1). That is allowed because it is not on main, but the migrator does not compare
    hashes, so a database that applied the first 0093 keeps `erp_analytics` reading all five
    rollups (the tenancy guard then fails loudly). Reset any local database that ran this
    branch before `cb0f8cb`; no shared database did. (owner: claude)
  - A training brand's org admin still sees the real brands' leaderboard and group medians
    (ledger audit note). Refuse both for a training brand if the client wants. (owner: claude)
  - A delivered line with no dispatch cost counts as zero cost, which overstates gross profit
    for such lines. Count and show them. (owner: claude)
  - The CSV/XLSX writer is imported from `orders/export/tabular.ts`; move it to the platform.
    (owner: claude)
  - The rollup's order and marketing reads scan a brand's orders on each recompute; index or
    narrow them if a brand's order count makes the ten-second job slow. (owner: claude)
  - No Playwright spec for `/analytics`; the four checks are proved over HTTP and in the
    domain. (owner: claude)
  - Tell the client that a peer's ROAS and CPDO together give its average order value, and
    that with few brands the group median can reveal a peer's rate (ledger audit note 1).
    (owner: human)
  - A real narrative provider, if the client wants one (D-327). (owner: human)
- Next: integration with M25, M26; then M14b and M30.

### 2026-10-02 · M26 · Company loans · done

- Delivered (branch `m26-company-loans`):
  - **Lenders and loans (D-293, D-296).** A brand records who lent it money and the loan's
    terms; the receipt posts Dr Wallet / Cr Loan payable (the lender) at once, with its
    schedule, in one transaction.
  - **Schedules (D-294).** Flat or reducing balance, monthly, in integer poisha; the principal
    always sums to the loan exactly (fast-check, and a deferred trigger in the database).
  - **Repayments through approvals (D-297 to D-299).** One whole instalment at a time, oldest
    first, split into principal and interest. Under the brand's `loan_repayment` threshold it
    posts at once; above it a second accounts user approves (and it posts) or rejects (and the
    instalment can be paid again, through a new rejection hook in the approvals module).
  - **Reminders (D-300).** A daily job reminds each brand N days before a due date, in the
    notifications inbox and by SMS, exactly once per instalment.
  - **Statements (D-301).** Schedule, repayments, totals, and the ledger's balance for the
    lender beside the schedules'.
  - **Void (D-304).** A loan recorded by mistake, with nothing paid on it, is voided by
    reversing its receipt — by someone other than the person who recorded it; the database
    allows that one change and no other, and a void and a repayment cannot both commit.
  - **Console.** Loans list, record a loan (with a schedule preview), the statement with pay
    and void, and the loan-due item in the notifications inbox. bn and en.
- Verification: `pnpm verify` (under `heavy.mjs`, Testcontainers) exits 0 at `8bf5e46`, the
  re-audit's fixes (148 test files, 2,430 tests, 1 skipped). Before the re-audit it exited 0 at `24a0459` (147 files,
  2,416 tests) on the fourth run; the first three failed on
  suites M26 does not touch: `dispatcher.db.test.ts`'s `afterAll` hook timing out, then
  `out of shared memory` (`max_locks_per_transaction`) in 12 suites' migrations — both with
  `TEST_DATABASE_URL` pointing every suite at the dev Postgres at once — and then, on
  Testcontainers, `promo.db.test.ts`'s race test (the loser was refused while pricing
  instead of while redeeming; exactly one use still won). Acceptance checks 1–4 pass:
  1. `packages/domain/src/loans/loans.test.ts` › check 1 (1,500 realistic and 1,500 edge
     loans), and 0090's deferred trigger refusing a schedule one poisha off
     (`loans.e2e.test.ts`);
  2. `loans.test.ts` › check 2: ৳10,000 at 12% over 3 months worked by hand, and the
     ৳1,00,000 / 12% / 12-month table (instalment ৳8,884.88, interest ৳6,618.53);
  3. `loans-reminders.db.test.ts` (real Postgres): once in the window, never twice across
     reruns, racing runs and catch-up, plus a deterministic test of the unique index;
  4. `loans.e2e.test.ts` › check 4 (HTTP): golden books, four journals with their keys, zero
     trial balance; the under-threshold path; and, from the ledger audit, two payments racing
     one instalment, two submits racing one loan id, a replay with other terms, the generic
     route refusing the type, an approval that names no payment, the database refusing a
     payment posted or rejected behind its approval's back, and the void; from the re-audit,
     a void racing a repayment in both orders (a `Promise.all` race, and two deterministic
     lock tests that hold one transaction open until the other waits on the loan row), each
     asserting the winner's journals and the lender's balance, and the database refusing a
     void by its recorder, on the wrong journal, with a payment waiting or posted, twice, or
     edited.

  Real-stack browser run (`e2e:stack`): 22 of 23. The notifications inbox spec
  (`shell-quality.stack.ts:391`) passes. `money.stack.ts`'s first test failed because
  `advances.stack.ts` runs first and puts ৳60 into the same Bank wallet; `money.stack.ts`
  alone passes 6/6. There is no real-stack spec for the loan screens.

- Auditors:
  - ledger-auditor: W1 (an approval could be recorded as approved while posting nothing),
    W2 (a repayment's state was tied to its approval and journal only in the service), W3 (no
    way to correct a loan recorded by mistake) and N4 (a journal could be named by two rows)
    are fixed: the executor and the rejection hook refuse instead of returning quietly,
    `loan_repayment` is in `EXECUTOR_REQUIRED_TYPES`, 0092's triggers bind a payment to its
    pending or approved request and its own instalment's journal, the void path (D-304), and
    0091's unique indexes. Race and replay tests added.
  - ledger re-audit at `24a0459`: 0 critical, 4 warnings, fixed in `3495569` — W-A (a void
    and a repayment could both commit: 0093 makes a payment's insert read its loan `for
share`), W-B (one person could void a loan's receipt: `LOAN_SELF_VOID` in the service and
    the trigger), W-C (the console minted a new id per request, so a retry after a lost
    response could record a second loan: one id per attempt), W-D (database refusal tests for
    the void rules) — and N2 (a capitalised payment id). Second re-audit at `3495569`: 0
    critical, 1 warning (the race tests did not assert the ledger's result), fixed in
    `8bf5e46` with the note-level items (error codes in the lock tests, `pg_blocking_pids` in
    the lock poll, one lowercased payment id for the audit trail, a 4xx ending the console's
    attempt). Not taken: the trigger trusting `voided_by` rather than `app.user_id`, and a
    void above the threshold going through approvals (follow-ups).
  - acceptance-auditor: NOT READY with 2 gaps — the architecture's module row (fixed) and no
    real-stack run of the touched inbox (run, passes). Re-audit: all four checks EVIDENCED,
    NOT READY on one docs gap (no M26 row in `docs/plans/README.md`, and the plan's Status
    without the audits), closed here.
- Decisions/assumptions: D-293 to D-304 (ASSUMED: D-294, D-295, D-297, D-300). D-298 and
  D-302 carry notes from the audit fixes; D-304 records the second-person rule, the lock, and
  why 0093 is a new migration rather than an edit of 0092.
- Migrations: `0089` (generated: schema and the enum value), `0090` (`--custom`: RLS, grants,
  triggers), `0091` (generated: the void columns and unique journal indexes), `0092`
  (`--custom`: the void trigger and the approval-bound payment triggers), `0093`
  (`--custom`: the loan lock, the second-person void and the case-insensitive payment id).
  They will collide with sibling branches' numbers at integration.
- New dependencies: none.
- Deviations from the milestone spec: none in scope. Added beyond the checks, from the ledger
  audit: the void path (D-304).
- Follow-ups:
  - Partial payments, prepayment, early settlement and rescheduling (D-297). (owner: human,
    then claude)
  - Loans taken before go-live need an importer (D-296). (owner: claude)
  - Reversing a posted repayment; only an unpaid loan can be voided (D-304). (owner: claude)
  - Interest is expensed when paid, not accrued (D-295). (owner: human, a client question)
  - Each brand must create a `loan.instalment_due` notify template; none is seeded, so every
    SMS reminder is recorded `failed` until then. (owner: human)
  - The SMS amount is Latin digits without lakh grouping inside a Bangla template. (owner:
    claude)
  - A repayment whose write loses a race leaves its approval pending; a checker can only
    reject it, but it sits in the queue until then. (owner: claude)
  - `loans.test.ts`'s realistic property takes 4–8 s: fine under the root config's 30 s
    timeout, too slow for vitest's 5 s default if run from inside `packages/domain`. (owner:
    claude)
  - `money.stack.ts` assumes an untouched Bank wallet, and `advances.stack.ts` (M17) runs
    first, so a full `e2e:stack` fails; assert deltas or give one spec its own wallet.
    (owner: claude)
  - `promo.db.test.ts` › "gives the last use to exactly one…" expects the loser to fail at
    redeem; under load it fails at pricing. Accept either refusal. (owner: claude)
  - `pnpm verify` with `TEST_DATABASE_URL` at the dev Postgres runs out of lock slots when
    every suite migrates at once (`max_locks_per_transaction` 64); run it without, or raise
    the setting in `infra/docker-compose.dev.yml`. (owner: human)
  - A real-stack spec for the loan screens (record, pay, approve, void). (owner: claude)
  - A void needs a second person but not an approval: any accounts user other than the
    recorder can void a genuine loan of any size. Route voids above the `loan_repayment`
    threshold through approvals if the owner wants it. (owner: human)
  - 0093's self-void check compares `voided_by` with `created_by` as the application wrote
    them; it could also require `voided_by = app.user_id`. (owner: claude)
  - Renumber 0089–0093 at integration. (owner: claude, integrator)
- Next: integration of M26 with its sibling branches.

### 2026-10-02 · M14b · Deployment, observability and the preview server · partial

- Delivered: the production path built and rehearsed locally (server image, release step,
  Kamal config, managed-Postgres bootstrap, Pages headers, Sentry and OpenTelemetry behind
  configuration, log masking, readiness, API security headers, runbooks; details in
  `docs/plans/M14b.md`). For the owner's server, a preview at one origin behind the host's
  own nginx: `infra/docker-compose.preview.yml` (API on 127.0.0.1 only), the nginx site
  `infra/preview/nginx-elyerp.conf`, and `infra/preview/deploy.sh`, which deploys a commit
  over SSH with `git archive`. The portal and the till now work under a sub-path.
- Verification: portal and till unit tests 49/49, typecheck and lint clean; the till's
  offline e2e 3/3; the preview stack and nginx site locally with a browser, 13/13 (plan
  status). Checks 1–3 need the owner's staging and are not claimed; `pnpm verify` was not
  run in this session because Docker's disk on C: was nearly full.
- Decisions/assumptions: D-340 to D-352 (D-352 rewritten for the host-nginx preview).
- New dependencies: none.
- Deviations from the milestone spec: the single-server preview is an addition the owner
  asked for.
- Follow-ups: the first super admin has no supported way in (invites need an admin,
  D-057), so a fresh preview or production database cannot be signed into (owner: claude,
  before the preview is useful); run `pnpm verify` once C: has room (owner: claude);
  `docker-buildx` must be installed on the server (owner: human, in the runbook).
- Next: the owner's first preview deploy, then M30.

### 2026-10-02 · gaps · Order lifecycle buttons, courier statuses that ship, settings screens · done

- Delivered (branch `gaps-orders-settings`, from `integration-wave2` at `09c36d1`; plan
  `docs/plans/gaps-orders-settings.md`; D-390 to D-396):
  - **Courier statuses ship the order (D-390).** A status that proves the parcel left —
    picked up, in transit, out for delivery, delivered, partly delivered, returning, back at
    the merchant — ships a `confirmed` or `packed` order first and then applies what the
    status means from `shipped`, in one transaction through the state machine. Before this
    nothing but a missing button produced `ship`, so a delivered parcel left its order
    `packed`, the delivery ignored and no revenue posted. `hold`, `booked`, `pickup_pending`,
    `cancelled` and `unknown` still move nothing before shipment; a held order is never moved.
  - **Confirming the handover ships the order (D-391)**, once, whoever comes second.
  - **Order detail buttons from the server's own table (D-392):** Confirm, Mark packed, Hand
    to courier, Mark delivered, Partial delivery, Start return, Receive return, Release hold,
    Hold, Cancel — each shown only when `GET /v1/orders/:id`'s new `transitions` lists it and
    the caller holds `update Order`, with dialogs for reasons, the collected amount and the
    return inspection. Cancel is no longer offered on a held order. A parcel panel books the
    parcel, shows its courier status, links its tracking and confirms the handover; the
    parcel page shows and confirms the handover too.
  - **Bulk pack and hand-over (D-393)** on the order list, through
    `POST /v1/orders/bulk-transition`.
  - **Settings (D-394, D-395):** `/settings` stops being a placeholder — approval thresholds
    (with relaxations waiting for a second org admin), delivery zones, courier accounts
    (write-only keys, fingerprints, the adapter's own field names), website order keys (the
    secret shown once) and till registers. The link shows for org_admin, accounts, marketing
    and branch managers, each seeing only the tabs their grants open. New reads:
    `GET /v1/approvals/thresholds`, `GET /v1/courier/providers`, and an `orderId` filter on
    `GET /v1/courier/parcels`.
  - **HR's Pay button (D-396):** `GET /v1/hr/payroll/wallets` (id and name only, through
    `LedgerApi.activeWallets`) feeds the pay and disburse pickers, which were empty for hr.
  - bn and en for every string. No new dependency.
- Verification (all under `heavy.mjs`, Testcontainers):
  - `pnpm verify` at `f655283`: format, lint and typecheck pass; tests 2,676 of 2,678 pass,
    1 skipped, and 1 failed — `packages/db/src/testing/tenancy.test.ts` › "seeds the chart
    of accounts once per org" hit its 30 s timeout with the machine at about 1 GB free
    memory. That file alone then passed (67/67), and build, the bundle budget, migrations,
    schema drift, the route-matrix gate, i18n and the api-client check all passed. The
    previous full run at `971b720` was green (163 files, 2,674 tests).
  - `apps/server/src/modules/courier/handover.e2e.test.ts`: 21/21 against real Postgres,
    through HTTP and through the worker's webhook path, with exact goods-in-transit and
    receivable amounts.
  - `apps/console/e2e/order-lifecycle.stack.ts` on the real stack: 4/4 (pending to delivered
    with the buttons, bulk pack, every settings tab as org_admin through the 2FA wall, no
    Settings for sales), axe clean in both themes; screenshots in `docs/review/gaps/`. The
    site key's one-time secret is not photographed (invariant 10).
- Auditors:
  - ledger-auditor at `79fd19e`: 1 critical, 4 warnings. C1 (a figureless partial
    delivery on a packed order recorded the full COD as collected with no delivery journal),
    W1 (a hand-set status could ship at any date), W2 (the order routes' delivery and return
    bypassed the parcel, so the courier's statement could never match), W3 (Release hold
    never showed: the console said `release`, the domain `release_hold`), W4 (tests lacked
    exact amounts and the webhook path) — fixed in `971b720`. Re-audit: 0 critical, 2
    warnings — W-A (a parcel the courier cancelled after pickup could not be received from
    the console), W-B (the difference reason lost from the Sales discounts memo) and notes
    N-A, N-B — fixed in `f655283`. Third audit: 0 critical, 0 warnings.
  - acceptance-auditor: not run; this is not a milestone and has no acceptance checks.
- Follow-ups:
  - The delivery journal names the order's courier, the settlement relieves the parcel's;
    set the order's courier from the consignment in the courier-path ship step (N3,
    decisions.md). (owner: claude)
  - `POST /v1/orders/:id/start-return` is not refused while a parcel is live (only the
    console steers it to the parcel); add `start_return` to `PARCEL_RECORDED` for parity.
    (owner: claude)
  - A booking stuck `pending` blocks a person's delivery or return on that parcel until it
    fails; a "cancel booking" action on the parcel panel would give a way out. (owner:
    claude)
  - Delivery zones' thana mapping, courier party ("Steadfast") creation, exchange from the
    order detail and settlement upload remain without a screen. (owner: claude)
  - `tenancy.test.ts`'s seed test runs close to its 30 s timeout under load. (owner: claude)
- Next: merge `gaps-orders-settings` into the integration branch.

### 2026-10-02 · preview kit · Demo data, sign-ins and a guide for trying the ERP · done

- Delivered: `pnpm preview:seed` fills a database with a few weeks of believable work in
  Elysium Lifestyle BD and creates one sign-in per role (new random passwords every run,
  written only to a gitignored file or stdout). All the work goes through the real API
  routes, in-process, with the worker's job handlers. It covers 15 orders in every state,
  parcels on a fake courier with a COD settlement, purchases, stock, marketing, payroll,
  targets, till sales, investors, a company loan and the dashboards. Some items are left
  waiting to approve. It is idempotent, and it fails if the books disagree: trial balance,
  stock against 1300 Inventory, or COD against courier receivables. `pnpm preview:local`
  does the whole thing on this PC in one command. `e2e:preview` is the smoke run: it builds
  a preview the same way and signs in as every role. `docs/testing-guide.md` is the owner's
  plain-language guide for https://elyerp.enfinito.cloud, and
  `docs/runbooks/preview-kit.md` has the steps for this PC and the server.
- Verification:
  - `pnpm verify` exits 0 on 2ad6070 (165 test files: 2674 passed, 1 skipped).
  - The re-audit fixes after it pass format, lint, typecheck, the preview and audit unit
    tests (32), and the files and auth platform suites (40).
  - Two seed runs on a fresh local preview, the second on top of the first, give identical
    books. A planted change by an outsider made the seed refuse, even with
    `--allow-existing-users`.
  - Seed on a fresh database: every book check agrees. The demo brand's trial balance is
    Tk 31,01,514.51 on each side, stock equals 1300 at Tk 4,35,160, COD variance is 0, and
    the training brand balances. It also ran with `NODE_ENV=production`, with `--out -` and
    without `migration-sample/`.
  - Smoke run: `roles.preview.ts` passes 8 of 8 with the enrolment spacing (before it, the
    accounts test hit the limit). `portal-till.preview.ts` passed 3 of 3 in the earlier run.
  - Suites touched by the first audit's fixes (files, HR, courier M15 tracking, auth
    platform) pass: 53 + 61 tests.
- Auditors: ledger-auditor, first pass: 1 critical, 7 warnings, all fixed (D-381, D-389).
  Re-audit: 0 critical, 3 warnings.
  - W1 fixed. A change in any brand's audit log by someone outside the preview refuses the
    seed, and no flag skips it. Refusals point at the runbook, and the runbook says to
    unmark a database before real use.
  - W2 fixed. An exemption only silences the no-org error, and the test pins it per
    handler.
  - W3: D-389 is narrowed to the local driver, and the R2 case is a follow-up.
  - Notes N3 to N6 are fixed.
  - The acceptance-auditor does not apply: this is not a milestone.
- Decisions/assumptions: D-380 to D-389.
- New dependencies: none.
- Deviations: none from the plan. Added from the audit: the database marker guard, a
  two-connection check, fake gateways, `LOG_DESTINATION`, and the stronger books check.
  Also two fixes to shipped code: `@AuditExempt` route metadata in place of the run-time
  audited flag, and the refusal of bytes for a stored upload.
- Follow-ups:
  - R2 uploads: a presigned `PUT` can replace a stored object during its 900 s life. Copy
    to a final key on finalize, or use a conditional `PUT` (re-audit W3). (owner: claude)
  - The SMS and Meta fakes apply only in the seed's process. On the server the deployed
    worker shares the queue. Today the seed queues no SMS. Refusing to run when the
    environment names a real provider would make that hold by design (re-audit N1).
    (owner: claude)
  - A finalize landing between the bytes `PUT`'s status check and its write is still
    possible; lock the row in both (re-audit N2). (owner: claude)
  - `intake.controller.ts` still sets `ALREADY_AUDITED` at run time for a replay; move it to
    `@AuditExempt` or a service-written row (re-audit N7). (owner: claude)
  - The credentials file's `chmod 600` does nothing on Windows (`preview:local`). It is
    gitignored, but readable by other local users. (owner: human, if the PC is shared)
  - The console has no buttons yet for hold, pack, ship, deliver, booking a parcel and
    inviting staff; the guide lists them as "not on screen yet". (owner: claude)
  - Merge into `integration-wave2`, which now has M14b. Reuse the resolution from
    `preview-deploy` (0d09119). `logger.ts` keeps M14b's `createLogger(name, destination?)`
    and `loggerOptions()`, and adds `LOG_DESTINATION=stderr` → `pino.destination(2)` when no
    destination is passed. `apps/server/package.json` keeps M14b's dependencies and adds
    only `files` and `preview:seed`. The portal and till sub-path URLs need M14b's
    7f15149. (owner: claude, integrator)
- Next: merge into `integration-wave2`. The preview server already runs a snapshot of this
  work (`preview-deploy`), seeded once on 2026-10-02 (17 s, books agree). Do not re-seed
  it, or the owner's passwords change.

### 2026-10-02 · gaps-users-auth · Staff accounts and sign-in · done

- Delivered (branch `gaps-users-auth`, from `integration-wave2`):
  - **Staff screen** (`/users`, `read User`): a brand's people with roles and branch scope,
    status (active, invited, deactivated, disabled), two-step state and last sign-in. An
    admin changes roles (D-400), deactivates a leaver — roles here off, sessions ended at
    once, nothing they wrote touched (D-401) — and approves another admin's reset.
  - **Sign-in refusal (D-401).** Better Auth's session hook refuses an account that is
    disabled or holds no active role anywhere (`403 ACCOUNT_INACTIVE`); the login says so.
  - **Accept-invite and password reset without email (D-402).** `/accept-invite#token=…`
    and `/reset-password#token=…` set a password before any session check. An admin issues a
    one-time link (invite 72 hours, reset 1 hour; a reset voids the old password and every
    session), minted in the action's own transaction. The public reset paths are closed.
    20 resets an admin an hour, 5 a person a day.
  - **Lost phone (D-403).** An admin removes a second factor; the person enrols again.
  - **Second admin (D-404, D-405).** A reset of anyone who ever held a role that can raise
    or decide an approval, or an investor, is a `credential_reset` approval decided by
    another org admin — never the asker, never the person; a cross-brand person is a super
    admin's to reset. The grant lineage keeps every granter and link holder (D-406, D-410).
- Verification:
  - `pnpm verify` (under `heavy.mjs`) exits 0 at `332dac3`: 164 test files, 2,691 tests
    (1 skipped), bundle 240.7 KB of 250, schema drift, route matrix (314 routes), i18n and
    api-client checks PASS; and again after the re-audit fixes, at `52c81ed`: 164 files,
    2,695 tests (1 skipped), every check PASS.
  - `users.e2e.test.ts` (real Postgres): every permission edge — self-escalation through
    either route, cross-brand 404s, super admin protection, demote-then-reset, branch
    managers and warehouse needing a second admin, deactivated users and their sessions,
    tokens single-use and expiring, resets audited and ending sessions, approvals by a
    second admin only, rate limits, the trigger's refusals, two admins minting at once.
  - `users.stack.ts` (real stack, one worker): invite and set a password; reset a forgotten
    one; reset an accountant's second factor through a second admin; deactivate a leaver.
    axe, no serious or critical violation, both themes; screenshots in
    `docs/review/gaps-users-auth/`.
- Auditors: ledger-auditor at `57d6aa5` (2 critical, 7 warnings, 7 notes), fixed in
  `332dac3`; re-audit at `332dac3` (0 critical, 3 warnings), fixed after it: the deactivation
  path never takes an approval row after the person lock, the lock is per person across
  brands, and the database lifecycle and a concurrent mint have direct tests.
- Decisions/assumptions: D-400 to D-410 (ASSUMED: D-402's lifetimes and limits, D-404's
  24-hour collection window).
- Migrations: `0098` (generated: `iam.credential_resets`, `users.last_sign_in_at`, the
  `credential_reset` approval type and both never-auto-approve CHECKs), `0099` (custom:
  RLS, grants, the reset trigger), `0100` (generated: `iam.membership_granters`, the
  self-grant CHECK, restrict on deleting a person with resets), `0101` (custom: backfill,
  RLS, the tightened trigger, `iam.users_active_elsewhere`). They will collide with sibling
  branches' numbers at integration.
- New dependencies: none.
- Follow-ups:
  - Email the links once an email adapter exists (D-212); until then an admin can approve
    requests raised by someone whose invite they held (D-077's W4). (owner: human, then claude)
  - Before SMS is switched on, confirm whether `/phone-number/verify` creates a staff session
    without TOTP for a user with a phone number; close it if so. (owner: claude)
  - Freeze `org_id`, `user_id` and `role` on `iam.memberships` and refuse DELETE, so "ever
    held" cannot be rewritten (re-audit note 1). (owner: claude)
  - `POST /v1/users` on a role already held still adds branches without an audit row of its
    own, and creates the user row outside the membership transaction. (owner: claude)
  - The per-admin limit is counted without a lock per admin; parallel asks for different
    people can pass it. (owner: claude)
  - The lineage only grows: two admins who edit each other's roles can no longer check each
    other's requests, and only a super admin unblocks them. Decide whether routine edits
    should count (D-410). (owner: human)
  - The 0101 backfill cannot recover granters `POST /v1/users` overwrote before it; recover
    them from the audit log if any brand has live data. (owner: claude, integrator)
  - An operator-disabled account keeps its `/api/auth` session until expiry (predates this).
    (owner: claude)
  - Renumber 0098–0101 at integration. (owner: claude, integrator)
- Next: integration with the other wave-2 branches.
