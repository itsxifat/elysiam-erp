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

### 2026-10-02 · integration · Wave-2 gaps joined, the test site hosted · done

- Delivered (branch `integration-wave2`):
  - Merged M14b's preview deploy, `gaps-orders-settings`, the preview kit and
    `gaps-users-auth`. Conflicts were side-by-side additions (routes, navigation, i18n, the
    stack helpers, docs) and kept both sides; the logger keeps M14b's `createLogger(name,
destination?)` and adds the preview kit's `LOG_DESTINATION=stderr`. Migrations 0098–0101
    follow 0097 unchanged.
  - Hosted on the owner's server (D-352): https://elyerp.enfinito.cloud, certbot TLS, the
    database marked `elysium-preview` and seeded once with `preview:seed` (books agree). Two
    deploy-script fixes came out of the first real run: nginx's workers could not read the
    0700 release directory (500), and a rejected nginx config is now rolled back so the
    shared host's other sites survive the next reload.
  - The server's clock was 9 h 27 min fast (Ubuntu's NTS sources never answer from its
    network), which would have refused every two-step code. With the owner's OK, chrony now
    also uses a plain pool (`authselectmode ignore`); the runbook has the check.
- Verification: `pnpm verify` exit 0 at `49b96b5` with all four merged: 179 test files,
  2,808 tests (1 skipped); bundle, migrations, schema drift (100 migrations), route matrix
  (319 routes, 311 matrix-tested, 8 public), i18n and api-client checks all pass. All nine
  preview sign-ins accepted on the live site after deploying `49b96b5`.
- Follow-ups:
  - A supported way to create the first super admin on a brand-new database: invites need an
    existing admin (D-057) and `db:dev-users` refuses non-local databases. Needed before real
    go-live. (owner: claude, M30)
  - The preview kit's own follow-ups (R2 presigned PUT, the seed refusing a real SMS
    provider, the finalize race) and both gaps branches' follow-ups are in their entries above.
- Next: M30 review and fixes.

### 2026-10-03 · M30 · Hardening and launch readiness, part 1 · partial

- Delivered (branch `m30-hardening`, `integration-wave2` merged at `f17be07`; plan
  `docs/plans/M30.md`):
  - **Security review and fixes.** Four read-only reviewers covered auth, tenancy and files,
    money paths, and the public endpoints and clients. They found 5 high and 14 medium
    findings. Every high is fixed, and so are the bypasses the ledger-auditor found in those
    fixes over three rounds:
    - login rate limit walked past with `..` paths (A1);
    - a branch cash out or transfer "charge" with no receipt or checker (C1, D-362);
    - self-loans and self-disbursal (C2, D-363);
    - a branch manager redirecting a salary or reviving a leaver (C3, D-363);
    - unlimited desk discounts, then their edit, exchange and markup bypasses (C4, D-364).
      Mediums fixed: A2, A6, B1, C5 (D-365, a capped short collection at the desk and on a
      parcel), D1 and D2. The rest have owners in the plan.
  - **Load test**, every measured §29 target met: `pnpm load:test`, k6 in Docker on a
    throwaway local stack, never aimed at the preview server (D-361).
    - Order desk p95: lookup 37 ms, SKU search on 20k SKUs 37 ms, order save 83 ms.
    - Intake: 74 ms at 20 req/s.
    - Twelve-month reports and first load on 4G have a part-2 plan.
  - **Route report**: `pnpm report:routes`, `docs/review/M30/route-report.md`, 319 routes.
  - **`pnpm admin:bootstrap`**: the first super admin on a new database, through a
    one-time `/accept-invite` link. It refuses once any super admin exists, never promotes an
    account and is audited in every brand. `docs/runbooks/deploy.md` says how to run it.
  - **Accessibility pass**: axe in light and dark on every screen the preview walks, plus
    the portal, tracking page and till. Two real failures were fixed: dark-theme brand text
    (a `--primary-text` token, held to 4.5:1 by the token audit) and the till's F2 hint.
  - **Training guides** per role (`docs/training/`) and the **go-live checklist**
    (`docs/go-live-checklist.md`, unsigned), built on the testing guide and
    `runbooks/go-live.md`. The testing guide's not-on-screen list is brought up to date.
- Verification:
  - `pnpm verify` exits 0 at `57583d3` (under `heavy.mjs`): 183 test files, 2,873 tests, 1
    skipped as before. Route matrix: 319 routes, 311 matrix-tested, 8 public. Every check
    passes.
  - `pnpm verify` exits 0 again at `60a24dc`, the closing fix commit: 183 files, 2,874
    tests, 1 skipped.
  - `e2e:preview`: 11/11, no serious or critical axe violation in either theme.
  - Each fix ran its own suite against real Postgres as it landed.
- Auditors:
  - ledger-auditor: four rounds. 3 critical and 5 warnings, then 1 critical and 1 warning,
    then 0 critical and 1 warning, then 0 critical and 0 warnings at `60a24dc`. Everything
    is fixed.
  - acceptance-auditor: NOT READY at `57583d3`, with 5 gaps, all evidence and docs. The
    re-check at `60a24dc` found all five closed and part 1 READY once this verify was
    recorded.
- Decisions/assumptions: D-360 to D-365 (D-364 and D-365 ASSUMED, with an open owner
  question).
- New dependencies: none. k6 runs from the `grafana/k6` Docker image, not a package.
- Deviations from the milestone spec:
  - Part 2 waits for staging (D-360): alert rules, retention policies, the restore drill
    and the checklist's signature.
  - The accessibility pass lives in the preview specs, not a new stack spec.
  - The first super admin command was added to the milestone's scope by the coordinator.
- Follow-ups (owner: claude unless marked; full list in the plan):
  - Medium findings A3, A5, B2, C6, C7 and D3, and the lows.
  - B1's head/get race, and W-2's auto-approve race.
  - Pro-rating an order discount when an edit drops units.
  - Ceilings as per-org settings.
  - Console gaps: no branch on the "Add an employee" form, no employee edit screen, no
    investor sign-in link, and the supplier dropdown empty for warehouse.
  - Owner decisions (owner: human): A4 (host-only session cookie), and whether the 20%
    ceilings fit (D-364, D-365).
- Next: M30 part 2 once a staging server exists. Then the owner signs the go-live checklist.

### 2026-10-03 · m30-followups · M30's open mediums, two races and four console gaps · built

- Delivered (branch `m30-followups` from `integration-wave2` at `ad0a737`; plan
  `docs/plans/m30-followups.md`):
  - **Console gaps a tester hits.** "Add an employee" has a branch picker (a branch manager's
    add answered 404); an Edit panel on each employee sends only what changed (payout details
    and the linked sign-in for `update Payroll` holders); the investors list links a portal
    sign-in; warehouse's supplier dropdown on `/supply/entries` is filled. Four narrow
    picker routes behind the permission each screen's action needs, with ids and names only
    and masked emails, through a new `IamApi` (D-419).
  - **Medium findings.** A3: an SMS code never signs anyone in (D-411). A5: someone who has
    worked for another brand is a super admin's to add (D-412, ASSUMED). B2: the generic file
    download needs the purpose across the brand; investors' own route passes its row check
    (D-413). C6: supply receipts, supplier payments and returns are dated today or yesterday
    (D-414, ASSUMED). C7: the approval threshold counts the person's day (supplier payments
    to any supplier; petty cash and branch cash outs), under a per-person lock (D-415,
    ASSUMED). D3: a per-brand miss budget on the tracking page (D-416, ASSUMED; Turnstile not
    built, it needs the brands' keys). B3 stays a deployment item.
  - **Races.** B1: reads of an upload stop at the type's ceiling in both drivers, and the local
    PUT and finalize share the row lock (D-417). W-2: a request the module decided to hold is
    never auto-approved (`holdForChecker`, D-418); a supplier payment's request is now raised
    in the payment's own transaction.
  - Guides, the testing guide, the go-live checklist, `architecture.md` (§6 thresholds, §22
    files), M30's plan and the build status are brought up to date. The route report and the
    api client are regenerated (323 routes).
- Verification:
  - `pnpm verify` run 4: tests 184 of 185 files, 2,916 passed, 1 failed, 1 skipped. The
    failure was a pre-existing race test in `promo.db.test.ts` that flaked under load; it now
    waits at a barrier so the race is always the one under test.
  - `pnpm verify` run 5, after the ledger audit's fixes, passed format, lint and typecheck and
    was then stopped by Claude Code's memory guard before the tests (the PC ran low on
    memory). Not restarted, as the guard asks.
  - After the last change: build, bundle (245.1 KB of 250), migrations, schema drift, route
    matrix (323 routes, 315 matrix-tested, 8 public), i18n and api-client checks PASS; lint and
    format pass; every touched suite passes, one worker at a time (1,553 tests across 83
    files, real Postgres).
  - `pnpm verify` (under `heavy.mjs`) exits 0 at `a1a1c43`: 185 test files, 2,922 tests (1
    skipped); every check passes.
- Auditors: ledger-auditor 0 critical, 4 warnings, 10 notes; the warnings and five notes fixed;
  re-check 0 critical, 0 warnings, its remaining notes fixed or recorded. acceptance-auditor
  not run (not a milestone).
- Decisions/assumptions: D-411 to D-419 (D-412, D-414, D-415 and D-416 ASSUMED, each with an
  owner question).
- Migrations: `0102` (custom: `iam.users_held_elsewhere`).
- New dependencies: none.
- Follow-ups: in the plan's status (Turnstile keys, the roles-path re-grant, R2 copy at
  finalize, module-owned receipt downloads, a warehouse menu link, owner questions).
- Next: M30 part 2 on staging.

### 2026-10-03 · catalog-stock-ux · Products, stock and the catalog made easy · built

- Why: the owner tried the test site and said adding a product, managing stock and managing
  the catalog had "no easy option and even in some case there is no way". The audit (plan
  `docs/plans/catalog-stock-ux.md`) found 4 of 16 everyday tasks impossible, 8 hard, 4 easy.
  The impossible ones: receiving a new product's first stock (the supply form listed only SKUs
  already at the location), editing a product, archiving a SKU, a product spreadsheet import,
  a transfer to a showroom (no showroom or in-transit location could be made), a product's
  stock history and setting a low-stock level.
- Delivered (branch `catalog-stock-ux` from `integration-wave2` at `8556f42`):
  - **Product page is the hub** (D-420): variants with stock per location (warehouses, then
    showrooms), Out of stock and Low badges, inline price editing with history, photos as
    thumbnails, Add sizes or colours as chips, stock history, labels; actions Receive stock
    (primary), Adjust, Transfer, Low-stock alerts, Edit, Archive, and Archive or Restore per
    variant. Each action is one request through the route that owns it.
  - **New product in one form** (D-421, D-426): name, category, price, status (Active by
    default), sizes and colours as chips drawing the variant grid, a price per variant,
    opening stock per variant received from a supplier at a cost per piece (a supply entry,
    or a quantity-only draft without `read Cost`), optional photos.
  - **Catalog setup** (D-424, D-429): categories (add, rename, nest, switch off), size and
    colour lists (add, fix a label; codes suggested and fixed once saved), stock locations
    (add a warehouse or a showroom under a branch, rename, switch off). Linked from Catalog.
  - **Import** (D-425): a New products tab with a template, per-row problems and an
    all-or-nothing import, beside the existing Prices tab.
  - **Stock page**: category filter, product links, a variant column, quick actions (Receive
    stock, Transfer, Adjust, Count stock); empty in-transit rows hidden.
  - **Supply entries** (D-430): any catalog item can be received; cost typed in taka.
  - **Server**: `variantPrices` on product create (D-422); `PATCH /v1/catalog/skus/:id`
    (D-423); `PATCH /v1/catalog/attributes/:id` and `.../values/:valueId` (D-424);
    `POST /v1/catalog/imports/products(/dry-run)` (D-425); stock and movements by product and
    category (D-427); the first transfer creates the in-transit location (D-428). Pure rules in
    `packages/domain/src/catalog/{variant-prices,product-import}.ts`. No migration, no new
    posting rule, no new movement kind.
  - **Stack suite** (D-431): `catalog-stock.stack.ts`; a `merchandiser` org admin; the
    duplicate `admin` entry the wave-2 merge left in the provision removed (it failed
    provisioning, so no stack spec could run); ports overridable.
  - **From the audits**: receipts keep their idempotency key until a success or a 409, and
    the supply routes refuse a replayed key with different goods (`sameReceipt`, D-432);
    zero cost per piece refused in the receive dialogs; a location holding stock or a
    transfer cannot be switched off; one in-transit location per brand; the importer caps
    a file at 5,000 SKUs and refuses ambiguous values; inventory reads variant labels and
    category subtrees through `CatalogApi` (invariant 12).
  - **Low-stock alerts** on the product page: the reorder-level route existed but no screen
    set it, so "Low" never showed.
- Audit after: all 16 tasks easy (table in the plan).
- Verification:
  - New tests: `packages/domain/src/catalog/catalog-ux.test.ts` (variant prices, the
    importer, slugs; fast-check), `apps/server/src/modules/catalog/catalog-stock-ux.e2e.test.ts`
    (11 tests over HTTP on real Postgres: variant prices, SKU archive, renames, stock and
    history by product and category with cost withheld from the warehouse role, the importer,
    two first transfers at once, the switched-off in-transit location, the location
    deactivation guard), `apps/console/src/routes/catalog/catalog-stock-ui.test.ts`, route-matrix
    fixtures for the five new routes.
  - `catalog-stock.stack.ts` against the real stack: 7 of 7 pass, axe clean on setup, new
    product, product page, stock and import (run with `E2E_CONSOLE_PORT=5283 E2E_API_PORT=3210`
    because another worktree's preview held 5183).
  - `pnpm verify` (under `heavy.mjs`, `VITEST_MAX_WORKERS=4`) exits 0 at `f29dd3b`: 188 test files, 2,962 passed, 1 skipped; format, lint, typecheck, build, bundle (247.8 KB of 250), migrations, schema drift, route matrix (328 routes, 320 matrix-tested, 8 public), i18n and api-client all pass. A first run with the default 12 workers died of out-of-memory (Docker restarted); a second failed only the module-boundary guard, fixed in `f29dd3b`.
- Auditors: ledger-auditor: first pass 0 critical, 1 high (a retried receipt posted twice), 2 medium, 7 low, 8 notes; all fixed or recorded; re-checks found one medium in each of the next two rounds (a kept key replaying an edited receipt, then renewal on edit reopening the double post), both fixed; final re-check at `f29dd3b` 0 critical, 0 warnings, 3 notes. acceptance-auditor not run (not a milestone).
- Decisions/assumptions: D-420 to D-432 (D-421, D-423, D-425 and D-426 ASSUMED).
- Migrations: none. New dependencies: none.
- Owner questions: stock already in hand that came from no supplier, after go-live (D-421);
  whether a SKU with stock may be archived (D-423, allowed now); Active as the default for new
  products (D-426).
- Follow-ups: an idempotency key on transfer dispatch (D-432); in-transaction audit rows for
  catalog mutations (today the after-commit interceptor writes them); inventory's remaining joins to
  `catalog.products` and `catalog.skus` (pre-existing debt) behind `CatalogApi`; a row lock in
  migration 0033's movement-location check so a switch-off cannot race a movement; a banner
  after an unanswered save ("an earlier save may have gone through"); the console bundle is at 247.8 KB of 250, so the
  redesign should watch the budget.
- Next: merge into the wave-2 integration after the redesign lands; then M30 part 2 on staging.

### 2026-10-05 · wave 3 · The owner's new shape: one ERP per brand, a mother ERP, the website run from the ERP · in progress

- The owner's instruction (D-469): every business gets its own ERP deployment and database, with
  no clue of the others or of a head office; a separate mother ERP on its own server and domain
  shows and handles everything; each brand's ERP becomes its website's back office, starting
  with Elysium Lifestyle BD's Next.js site at `D:Projectselysium`.
- Delivered so far (branch `integration-wave2`):
  - The redesign (`design-refresh`, verified 2026-10-03: verify exit 0, the stack and preview
    Playwright runs green) fast-forwarded into `integration-wave2`, so wave 3 builds on the new
    design. Its own progress entry was never written; its plan's Status and the review
    screenshots are the record.
  - Plans: `docs/plans/wave3.md` (shape, the old admin panel mapped feature by feature, order
    of work, the old site's problems) and M31 to M37, the milestone table and sections in
    `docs/milestones.md`, D-469, decision id ranges per milestone, `build-status.md` and the
    plans index.
  - The owner link's format, shared by the brands (verify) and the mother (mint):
    `packages/domain/src/iam/owner-link.ts` with 13 tests including fast-check (D-473).
  - Survey of the old website: Next.js 14, Mongoose 9 on one Mongo database, 31 admin screens,
    112 API routes, 20 models; money in float taka; sizes only, stock as one number per size.
- Found on the old website and fixed on its branch `fix/settings-public-allowlist` (66890cb,
  not deployed): the public `GET /api/admin/settings` returned the ncom.bd connector, order,
  API and webhook secrets to anyone; visitors now get an allow-list of storefront sections and
  staff the redacted document without ncom. `GET /api/orders/[id]` also returned the ncom block
  to shoppers. The ncom secrets should be rotated once it is deployed.
- Builders started (each in its own worktree, decision ids reserved): M31
  (`m31-brand-edition`), M32 (`m32-mother`), M33 (`m33-storefront-catalog`).
- Owner questions: the old site's courier-history fraud check (default: not carried over,
  D-291); the two servers and the mother's domain; Elysium's admin address; Elysium's
  SSLCommerz, SMTP, Meta, GA4 and ncom credentials; the accountant's cost per piece for the
  website's stock; a switch-over date.
- Next: integrate M31, M32 and M33; then M34 and M35.

### 2026-10-05 · M33 · The website's catalog and content, run from the ERP · built

- Delivered (branch `m33-storefront-catalog`, continuous build mode, plan `docs/plans/M33.md`):
  - **The data.** Web fields on `catalog.products` (`web_visible` separate from `status` and off
    for a new product, featured, new arrival, gender, material, care, tags, size chart, SEO
    title and description, `previous_slugs` kept by a trigger; descriptions to 20,000
    characters) and on `catalog.categories` (shown on the website, featured, gender,
    description, picture). A new tenant schema `storefront`: `settings`, `web_locations`,
    `hero_slides`, `nav_items`, `size_charts`, `legacy_ids`, `site_keys`, all RLS ENABLE and
    FORCE from `tenantTableSql()` with composite foreign keys. Migrations
    `0103_m33_storefront_schema.sql` (generated) and `0104_m33_storefront_policies.sql`
    (policies, grants, the size-chart foreign key, the slug-history triggers, search text with
    tags and material).
  - **The rules** (`packages/domain/src/storefront/`, fast-check): `availableForWeb`,
    `storefrontPrice` and the `{ poisha, taka }` wire money, the slug history
    (`recordSlugChange`, `releaseSlug`, `resolveSlug`), the shipping rule, the product list's
    parameters and cursor, tags, safe links, size charts, the category tree and the menu.
  - **The storefront read API** `/storefront/v1/*` (`docs/storefront-api.md`): products with
    category subtree, gender, tags, size, price range, featured, new arrival, on sale and
    search, six sorts, a keyset cursor plus `page` and `total`; a product by slug with each
    size's live availability at the web locations, images, size chart, breadcrumb and related
    products, and `{ redirect: { slug } }` for an old address; the category tree; search; the
    site in one answer (settings, hero, menu, announcement, promo, testimonials, shipping,
    payments); size charts; districts and thanas. Signed with `X-Api-Key`, `X-Api-Timestamp`,
    `X-Api-Signature` over `timestamp.METHOD.path?query`, ±5 minutes, keys derived from
    `INTAKE_KEY_SECRET` under their own label; every answer through `serializeForStorefront`
    (an allow-list at every depth, then the cost deny-list), with an ETag, `304` and
    `Cache-Control: private, max-age=30, stale-while-revalidate=300`.
  - **Public images**: `GET /media/<org>/<file>/<thumb|card|full>` for stored public product,
    category and website images only, never an original, cached a year.
  - **The console**: a **Website** section in the Sell group (Settings by section, Hero slides
    and Menu with drag and arrows, a Size chart grid editor, Connection for the website's keys
    with the secret shown once), the product page's **Website** card with "View on website",
    and a **Website** dialog per category on Catalog setup. A `Storefront` subject: org_admin
    and marketing manage, sales reads. Lazy-loaded; strings in bn and en.
  - **For M34 to M36**: `STOREFRONT_API` (web locations, the shipping rule, old ids),
    `OrdersApi.deliveryZones`, `InventoryApi.levelsAt`, `CatalogApi` web reads,
    `FilesService.publicImagesIn`, the POST signing base for M34's checkout.
- Verification:
  - Acceptance check 1 (hidden never reaches the website; live availability at the web
    locations only): `storefront.e2e.test.ts` › "what the shop shows" — a hidden and an
    archived product absent from list and search and 404 on their pages; the shirt's sizes
    read S 5, M 3 (4 less 1 held), L 0 at the warehouse, then S 5, M 12, L 3 once the showroom
    is a web location. PASS.
  - Check 2 (an old slug redirects): "old addresses" — a renamed product's old slug answers
    `{ redirect: { slug } }`; another product taking it stops the redirect; another brand
    taking it leaves this brand's redirect alone; domain property test of the history rule.
    PASS.
  - Check 3 (401s; no cost field): "the signature" — no headers, a malformed, unknown,
    revoked, other-master or landing-page key, a wrong signature, another path or query, and
    a timestamp 301 s either side all answer the same 401; `cost-sweep.e2e.test.ts` drives
    every live `/storefront/v1` route with a website key and finds no cost or cost-like key.
    PASS.
  - Check 4 (round trip through the console): `website.stack.ts` against the real stack, 7 of
    7 passed (ports 3213/5286), first at `ef62846` and again after the audit fixes at
    `21672da` (48.2 s): settings by section, two hero slides reordered, a menu with a dropdown,
    a size chart, a key issued and the saved site read back through the signed API with it, a
    product put on the website from its card. axe clean (serious and critical) on settings,
    hero, menu and size charts. Screenshots in `docs/review/M33/` (`dd30f7a`); the dialog that
    shows a key's secret is not screenshotted (`b2792ae`; an earlier commit carried one from a
    throwaway database, useless without that database's key row). PASS.
  - Check 5: `pnpm verify` (under `heavy.mjs`, `VITEST_MAX_WORKERS=4`) exits 0 at `8a3414c`,
    the last code commit: 194 test files, 3,086 passed, 1 skipped (pre-existing); format, lint,
    typecheck, build, bundle (initial route 246.1 KB of 250), migrations, schema drift (103
    migrations agree), route matrix (358 routes, 341 matrix-tested, 17 public), i18n (3,256
    keys) and api-client all pass. The route-matrix and cost-sweep suites pass with the 21 new
    console routes and the 8 signed reads.
- Auditors: ledger-auditor first pass 0 critical, 1 high (a nested `withOrg` in the public
  reads could starve the pool under concurrent traffic), 1 medium (key issue and revoke and
  settings saves audited only after the response; the `pin` pattern redacted the whole
  shipping section), 6 low, 6 notes — all fixed (`7808488`) except the notes recorded below;
  re-check 0 critical, 0 high, 0 medium, 1 low (a repeated query parameter), 6 notes — the low
  and five notes fixed (`21672da`). acceptance-auditor: READY, all five checks PASS; its
  scope notes fixed after: the category picture is checked through `FilesService`
  (`publicImagesIn` with a purpose), not by a new catalog read of `files.objects`; the old-id
  map, a shown product with no active size and a pending category picture gained tests; the
  doc nits.
- Decisions/assumptions: D-500 to D-512 (D-500, D-501, D-503, D-506, D-507, D-509, D-510,
  D-511 and D-512 ASSUMED).
- New dependencies: none.
- Deviations from the milestone spec: two migration files (schema, then policies and
  triggers), as every milestone writes them; `Cache-Control` is `private` as well (D-506);
  the list also takes `page` and returns `total` for the old shop's numbered pages (D-506);
  website keys reuse `INTAKE_KEY_SECRET` under their own label (D-509); "drag to reorder" is
  native drag and drop plus arrow buttons, no library.
- Owner questions: exact stock quantities on the website, or only in and out of stock
  (D-510); new products start off the website (D-500); the product path for "View on
  website" is the old site's `/shop/<slug>` (D-503, confirm in M36).
- Follow-ups: the audit redaction matches `pin` and `nid` as substrings (`shipping`,
  `locationIds`), which redacts innocent keys across the system — match whole segments
  (owner: claude); `storefront_settings_org_idx` duplicates the settings primary key (drop in
  a later migration; harmless); M36's importer must write products inside the brand's
  `withOrg()` so the slug triggers see the brand (§31); a 1,920-pixel image size if the hero
  looks soft (D-507); nginx or a CDN cache in front of `/media/` at go-live (M37).
- Integration notes: migrations `0103_m33_storefront_schema.sql` and
  `0104_m33_storefront_policies.sql` (renumber at integration; 0103's journal entry and
  snapshots come with them); the i18n blocks sit before `common.today` in both catalogues;
  `openapi.json` and the generated client are regenerated by `pnpm api:client`; M31's
  neutral header names are what this API uses from the start.
- Next: M34 (buying on the website) on the storefront API; M36 converts the website onto it.

### 2026-10-05 · M31 · One ERP per brand (brand edition) · done

- Delivered:
  - **One brand per deployment** (D-470): `ERP_BRAND_SLUG` on the API and worker; both refuse
    to start unless the database holds that brand and no other real one (the training org
    may sit beside it), with a message naming the other brands. `db:seed --brand <slug>` /
    `SEED_BRANDS`, `preview:seed --brand`, `preview:local --brand`. With the slug set the
    login branding answers that brand alone and the trusted origins are `TRUSTED_ORIGINS`.
  - **The all-brands views left** (D-471): the consolidated dashboard, the leaderboard and the
    consolidated wallet and P&L reports answer 404 and are gone from the route matrix,
    OpenAPI, the client, the console (screens, tabs, palette, messages) and the permission
    matrix (`Leaderboard`). Insights compare a month with the brand's own three months before
    it (D-478); the narrative payload (v2) carries no rank.
  - **White label** (D-472, D-479): CSRF `erp_csrf` / `x-csrf-token`; local storage `erp-*`
    (older values moved once, by shape); the till's IndexedDB `erp-pos`, an older build's database
    copied on every start and deleted only when the till holds it alone and the copy took
    everything in it; shell cache `erp-pos-shell-v1`;
    intake headers `X-Api-*` (old names still read); TOTP issuer, SMS text, titles, login
    fallbacks, recovery-code file names and payslip from the brand's row or neutral;
    multi-brand copy reworded; OpenAPI `ERP API`. `pnpm check:white-label` in verify.
  - **Owner sign-in link, brand side** (D-473, D-476, D-477): `POST /v1/auth/owner-link`
    (off unless `OWNER_LINK_PUBLIC_KEY`), Ed25519 verify, audience, window, single use
    (`iam.owner_link_uses`) and the owner's identity in one owner-role function
    (`iam.accept_owner_link`), a two-hour Better Auth session (server-only endpoint) that
    passes the enrolment wall and lands in the brand, audited; one 401 for every refusal.
    Owners are never staff, never given a role or a password (triggers), and read "Owner" on orders and
    resets to non-owners. Console `/owner-link#token=…`.
  - **The client address behind the proxy** (D-479, from the coordinator): Fastify 5.12 read
    the numeric `TRUSTED_PROXY_COUNT` as "trust nothing", so every visitor shared one
    per-address rate-limit bucket; the adapter now passes a hop function, and the nearest hop
    must be loopback or private.
  - **Deployment shape** (D-474, D-475): `infra/brand/` (compose project `erp-<slug>`,
    `.env.brand.example`, `new-brand.sh`, `nginx-brand.conf` incl. `/storefront/` and
    `/media/`, `deploy.sh`, `server-deploy.sh`, the website's `/admin` redirect) and
    `docs/runbooks/brand-deploy.md`. Nothing deployed.
- Verification:
  - `pnpm verify` (under `heavy.mjs`, `VITEST_MAX_WORKERS=4`) exits 0 at `b1683a8`: 199 test
    files, 3,033 passed, 1 skipped; format, lint, typecheck, build, bundle 243.8 KB of 250,
    white-label (185 built files, no hit), migrations, schema drift, route matrix (325 routes,
    316 matrix-tested, 9 public), i18n and api-client all pass. Earlier runs at `98bd32c` and
    `166af4b` were green too.
  - Check 1 in a real process: the built API and worker against a throwaway five-brand
    database exit 1 with `BrandDeploymentError: ERP_BRAND_SLUG is "oura-lifestyle", but this
database also holds 4 other brands (beownz, elysium-lifestyle-bd, orvo, wear-x-clothing).
A brand's ERP runs on a database of its own …`; on one brand beside the training org the
    API stays up and logs `brand deployment`.
  - Browser: the till's Playwright spec 5 of 5 (two new: a queued sale under an older build's
    database moves and syncs once; an older tab left open keeps its database and its later
    sale arrives too); the console's stubbed specs 13 of 13; `users.stack.ts` 4 of 4
    (`E2E_API_PORT=3211 E2E_CONSOLE_PORT=5284`).
- Auditors: ledger-auditor on the tenancy and auth diff: first pass 0 critical, 0 high, 2
  medium (the app role could pre-spend a `jti` and mint an owner through 0104's function; the
  till could delete an older build's database while another tab still queued sales into it),
  3 low, notes; all fixed in `d39b42c` (migration 0105, the session trigger and owner check on
  the wall bypass, the till's drain-then-delete) or recorded (a link names its brand by slug:
  copies use another key pair). Re-check: 0 critical, 2 low (an owner could still get an
  account row; a second new tab could wait on an older tab), both fixed in `4811b5e`
  (migration 0106, a bounded wait). acceptance-auditor: checks 1 to 4 evidenced; NOT READY only for want of a green verify
  after `d39b42c` and `4811b5e`, closed by the run at `b1683a8` above; its smaller notes (an
  untested `admin:bootstrap` owner rule, `_headers` unscanned, one multi-brand sentence in
  the reset rules) were fixed in `b1683a8`.
- Decisions/assumptions: D-470 to D-479 (D-475 and D-478, and D-472's app names, ASSUMED). D-473 records the
  link format committed before the session and its brand side.
- Migrations: `0103_m31_owner_link.sql` (owner_link_uses, users.is_owner, sessions.owner_link),
  `0104_m31_owner_link_grants.sql` (owner triggers), `0105_m31_owner_link_hardening.sql`
  (`iam.accept_owner_link`, the session trigger, revokes), `0106_m31_owner_no_password.sql`
  (no account row for an owner). Renumbered at integration (after M33's 0103 and 0104) to
  `0105_m31_owner_link`, `0106_m31_owner_link_grants`, `0107_m31_owner_link_hardening` and
  `0108_m31_owner_no_password`; the regenerated 0105 is byte-identical to the original 0103.
- New dependencies: none.
- Deviations from the milestone spec: used `jti`s are pruned by `iam.accept_owner_link` on each
  use, not by a worker job (D-476); the plan's `packages/domain/src/auth/owner-link.ts` is
  `packages/domain/src/iam/owner-link.ts` (committed so before the session).
- Follow-ups: the mother mints links against D-473 (M32, owner: claude); the owner names the
  admin hosts and the app names (D-475, D-472, owner: human); paste the website's `/admin`
  redirect when the brand's staff move (M36, owner: human); an existing preview tab needs one
  reload after this deploys (CSRF rename); a realtime test of the two-hour cap (it shares
  `resolveIdentity`, owner: claude); the old intake header names retire with the old site (M36).
- Next: integration with M32 and M33; M37 deploys the brands.

### 2026-10-05 · M35a · Offers: the old website's discount engine and flash sales, in the ERP · built

- Why: the old website's admin ran its own discounts and flash sales (wave 3, D-469); M34's
  checkout needs the pricing rules before it can price a cart, so M35 was split and its offers
  built first (plan `docs/plans/M35.md`, items 1 and 2).
- Delivered (branch `m35a-offers` from `integration-wave2` at `0c056cf`, not merged):
  - **One discount engine** (D-540): `packages/domain/src/promo/discounts.ts`, the old site's
    `computeDiscounts` in integer poisha (code and automatic; percent, flat, free delivery, buy X
    get Y, tiered; SKU, product and category-ancestry scope; minimums, first order, windows,
    limits, ceiling; best single or the stack, priority). M16's `validatePromo` is a view of it.
    Each stacked discount comes off its own lines only (the old engine over-gave on scoped
    stacks). `legacy.ts` reads the old site's documents; `flash.ts` ports the offer ranking and
    line planner.
  - **Differential test**: the old engine copied verbatim as an oracle
    (`promo/oracle/old-site-discounts.js`, commit 333393e) against the port on 5,000 generated
    carts (whole percents, equal to the poisha outside three documented departures) and 2,000
    with fractional percents (within a poisha per discount), plus eleven named cases. Recorded
    carts from the old database were not reachable (D-540).
  - **Schema** 0103 to 0106: `promo.codes` extended, `promo.discount_tiers`,
    `promo.flash_sales`, `promo.flash_sale_items`, `promo.flash_claims` (one per order line, a
    six-column foreign key to a whole line of its own order charged the sale price, and a key on
    `sales.order_lines` to point it at); RLS ENABLE and FORCE, no DELETE grants, the claim
    trigger, the title backfill brand by brand.
  - **Server** (D-541, D-542, D-548): `PromoApi.quoteDiscounts`, `redeem` (a savepoint),
    `liveFlashOffers`, `claimFlashUnits` (conditional UPDATE per line in a savepoint, database
    clock), `releaseFlashUnits`, `storefrontFlashSales`, `storefrontFlashSale`, `holdsOnOrder`;
    `release_flash_units` on every cancel and received return; an order edit refused around
    claims and applied discounts; first order through `BuyerHistoryRegistry` (D-543),
    re-checked under the code's lock; editor routes `/v1/promo/flash-sales` on `LandingPage`
    with route-matrix fixtures; `FilesApi.isPublicAsset` for banners (D-547). The desk sends
    line quantities and names the two new refusal reasons; automatic discounts stay off at the
    desk (D-544).
  - **Console** (D-549): Campaigns → Discounts (the promo-code screen renamed, a form per kind,
    scope pickers, conditions, Dhaka-time schedule D-545, limits, stacking, priority) and Flash
    sales (list with live sold counts, switch on and off, duplicate; editor with product picker,
    per-size sale price and units or all stock, banner, slug, window). bn and en; lazy.
- Verification:
  - New tests: `discounts.test.ts`, `discounts.differential.test.ts`, `flash.test.ts` (domain,
    fast-check), `offers.db.test.ts` (25 on real Postgres: the five-of-twenty race on lines
    charged the sale price, the cancel through the real route, the savepoints, the claim's
    conditions and line tie, a return after a partial delivery through the real transitions,
    per-line release, the claim trigger, the edit refusal, the storefront read seam, the editor
    over HTTP with banner checks and audit, quotes and redemptions, the first-order race,
    sub-category scope, a buy-X-get-Y code at the desk, the 0105 backfill), console
    `campaigns-ui.test.ts`, the effect rows in `orders.test.ts`.
  - M16's promo tests green (`promo.db.test.ts`, `promo.test.ts` unchanged; the desk's unit
    test gains `qty`; `crm.stack.ts` follows the rename).
  - `offers.stack.ts` and `crm.stack.ts` against the real stack (ports 3214/5287): 2 and 4
    passed, axe clean in both themes; screenshots in `docs/review/M35a/` (M16's refreshed).
  - `pnpm verify` (under `heavy.mjs`, `VITEST_MAX_WORKERS=4`) exits 0 at `3e3387c`: 193 test
    files, 3,079 passed, 1 skipped; format, lint, typecheck, build, bundle (245.6 KB of 250; M35a's
    strings are 1.8 KB of it), migrations, schema drift (105 migrations), route matrix (334
    routes, 326 matrix-tested, 8 public), i18n and api-client all pass.
- Auditors:
  - ledger-auditor: 0 critical, 13 warnings (one high: stacked scoped discounts could over-give).
    Fixed W1-W6, W8-W10, W12, W13 and N1-N2 in `c4d212f`, W11 (the desk's two new refusal
    reasons) in `ff470a7`; W7 recorded as D-546 (owner question).
  - Re-check: 0 critical, 2 warnings (an order edit would 500 around claims; a claim was not
    tied to its own order's line), both fixed in `592a728`; its notes on stacked redemptions (a
    savepoint), lock order (D-548), flash-sale edits (offer order) and legacy amounts fixed too;
    the first-order gap across different discounts accepted in D-543.
  - acceptance-auditor on items 1 and 2: NOT READY with six gaps; addressed in `3e3387c` (claims
    tied to the line's price, the evidence substitution recorded in D-540 and the plan, the
    storefront read seam with its routes left to M33/M34, the plan's ids and checks, this
    entry). Not re-run after the fixes.
- Decisions/assumptions: D-540 to D-549 (D-543, D-544, D-546 ASSUMED).
- Migrations: `0103_m35a_offers_schema.sql`, `0104_m35a_offers_policies.sql`,
  `0105_m35a_offers_integrity.sql`, `0106_m35a_flash_claim_lines.sql`. M31 (0103-0106), M32
  (0103) and M33 (0103-0104) use the same numbers: renumber at integration. 0105 and 0106 were
  amended on this unmerged branch; a local database that applied an earlier version needs a
  fresh migrate. New dependencies: none.
- Owner questions: an approval step, a ceiling or a below-cost refusal for discounts and flash
  sales (D-546).
- Follow-ups: the storefront module's `GET /storefront/v1/flash-sales` and `/:slug` on the read
  seam, and the Website section's link to Campaigns (M33/M34); M34 calls the checkout surface in
  D-548's order and chooses an order's `promo_code_id` when discounts stack; M36 maps the old
  site's discounts and flash sales (legacy product-wide caps need per-size limits) and can add
  recorded carts to the differential test; palette entries for Discounts and Flash sales; a kit
  date-and-time picker for the schedules; the console bundle has about 4 KB left.
- Next: integrate with M31 to M33; M34 prices checkout through this.

### 2026-10-05 · integration · M31, M33 and M35a joined into the wave-3 integration · done

- Merged into `integration-wave2`: M33 (faf12bd), M31 (2954f50), the Cloudflare real-address
  change (f055243, D-580) and M35a (4e500db). Migrations renumbered in merge order, SQL
  unchanged: M33 0103–0104, M31 0105–0108 (0105 regenerated, byte-identical to the branch's
  0103), M35a 0109–0112 (the regenerated schema diff equals the net of its 0103 and 0106; the
  branch's files kept verbatim). Conflicts were side-by-side additions (docs, `catalog.api.ts`,
  CLAUDE.md's stack-spec line); the API client was regenerated from the merged server.
- Verification at 967efca: format, lint, typecheck green; tests 3,210 passed, 1 skipped (the
  one failure at 4e500db was M35a's backfill test reading its migration under the old number,
  fixed in 967efca and re-run 25/25); build, bundle, white-label (197 files, no brand name),
  migrations, schema drift (111 migrations agree), route matrix (361 routes, 343
  matrix-tested, 18 public), i18n and api-client all PASS.
- M35a's acceptance re-audit at 4e500db: checks 1–3 evidenced; gaps closed or reassigned (the
  renumbered test; a ledger audit of its last fix commit 3e3387c, run now; the flash-sale
  storefront routes and the checkout claim, now M34's per D-548).
- Ledger audit of M35a's last fix commit (3e3387c): 0 critical, 1 warning (W1: the storefront flash-sale reads filter only switched-on items, not web visibility; handed to M34, which builds the routes, with notes N1 upcoming-sale prices, N4 a test that no line is charged a flash price without a claim, N5 a cross-org claim test). N2: migration 0112 builds a six-column unique index on `sales.order_lines` under an exclusive lock, harmless on a new brand, worth a quiet window on a populated one.
- From now on every migration up to 0112 is treated as frozen: Elysium's ERP will be deployed
  from this branch.
- Deploying Elysium's ERP to `erp.elysium-lifestyle.bd` was blocked by Claude Code's permission
  check; the steps are with the owner (option to allow it, or run them).

### 2026-10-05 · M38a · Products, stock in hand, barcode stickers and the scanner · built

- Why: the owner's first priority (D-600): re-upload the products and the stock already in hand
  at a cost per piece, and print a barcode sticker for every piece; then use a scanner
  everywhere (plan `docs/plans/M38.md`, part M38a).
- Delivered (branch `m38a-barcodes`, merged up to `integration-wave2` at a80598e, not merged
  back):
  - **The new-product form, complete** (D-601): name, category, price, status, description;
    several photos at once, reordered, cover chosen, each optionally cropped to 3 : 4 on a
    canvas; sizes and colours as chips with a price, pieces and a cost per variant; the stock
    **already in hand** (while the window is open) or **from a supplier**; the website details
    folded away. One button; a failed step is retried alone; it ends on "Print N stickers".
  - **Stock in hand** (D-602): `inventory.stock_in_hand_entries` and `…_lines`; drafts by the
    warehouse (no cost field), priced and posted by `read:cost`; `opening_balance` movements
    blended into WAC and one journal per entry, Dr Inventory / Cr 3350 Opening balance equity
    (`stockInHandDraft`, keyed `stock_in_hand:<entry>:posted`). The **opening stock window**: an
    org admin closes it; reopening is an `opening_stock_reopen` approval for that close (D-608);
    migration 0114 starts it closed for a brand that had already opened its books or traded. A
    posted entry made by mistake is reversed exactly, through an approved
    `stock_in_hand_reversal`, while the window is open (adjustment_loss movements at the entry's
    cost and the ledger's reversal of its journal), or not at all.
  - **An internal EAN-13 for every SKU** (D-603): `2`, an eleven-digit per-brand sequence, the
    check digit, taken in one upsert; typed or imported codes in the range refused; the backfill
    in 0114, brand by brand.
  - **Stickers** (D-604): thermal 38 × 25, 40 × 30 and 50 × 25 mm (one sticker per page, the
    page the sticker's size) and A4 3 × 8 and 4 × 10 with "start at"; the brand's short name
    from its own org row (white label); printed from the new-product form, every receipt and
    stock-in-hand entry, the product page and ticked Stock rows.
  - **The scanner everywhere** (D-605): `createScanDetector` in `@elysium/domain/barcode`; the
    console's lazy `ScanListener` opens the product at the scanned variant, or hands the scan to
    the stock screen listening; scan fields on receive, stock in hand, transfer, adjustment,
    supply entries and counts; "Scan with camera" through `BarcodeDetector`.
  - **Strict stock** (D-606): a count by scanning (`POST /v1/inventory/counts/:id/scans`,
    append-only `count_scans`, one piece per scan key); typing over a counted figure needs a
    note, on the server too; each variant's barcode on the product page.
  - **Lookup** `GET /v1/catalog/lookup?code=` (D-609); section catalogues for i18n so the
    strings stay out of the first download (D-607).
  - **Error text in the dark theme**: `text-destructive` read 3.2:1 on dark surfaces, found by
    this milestone's dark axe pass; `--destructive-text` lifts it there (`.dark
.text-destructive`, M30's `--primary-text` pattern), held by three pairs in the token
    contrast audit. Every error line in the console gains from it.
- Verification:
  - `pnpm verify` (under `heavy.mjs`, `VITEST_MAX_WORKERS=4`) exits 0 at 3e72f26: 214 test
    files, 3,294 passed, 1 skipped (not new); format, lint, typecheck, build; bundle 249.2 KB
    of 250; white-label (206 files), migrations, schema drift, route matrix (374 routes, 356
    matrix-tested, 18 public), i18n and api-client PASS. After 428069a (a narrower count lock,
    a test assertion, docs): the three inventory test files, 48 passed.
  - Acceptance checks: (1) `stock-in-hand.e2e.test.ts` asserts one balanced journal per entry
    (Dr Inventory / Cr Opening balance equity) and its `opening_balance` movements, and
    `barcodes.stack.ts` creates a product with three sizes and 9 pieces in hand at ৳850 and is
    offered exactly 9 stickers, then prints a 9-page PDF; (2) `barcode.test.ts` (fast-check:
    every check digit, every single-digit error caught, internal numbers valid and unique), the
    e2e test's six concurrent product creates (18 unique codes) and SQL equal to the domain, and
    a scan in the stack spec opening the product at that variant; (3) `stickers.test.ts` reads
    every PDF page's MediaBox from the real Gotenberg for all five media, and the stack spec
    checks the downloaded roll PDF; (4) stock in hand refused once closed by the service,
    `InventoryApi` (stock in hand and M14a's opening) and the triggers; (5) this verify and the
    ledger audits below.
  - `barcodes.stack.ts` (8) and `catalog-stock.stack.ts` (7) against the real stack at
    3e72f26 (ports 3215/5288, one worker): 15 passed, axe clean in light and, for the M38a
    screens and dialogs, dark (log `D:/Projects/erp-tools/e2e-m38a-final.log`); screenshots in
    `docs/review/M38a/` (01 to 07 light, 08 to 10 dark).
- Auditors:
  - ledger-auditor: 0 critical, 7 warnings. All fixed in 3585ae1: W1 (windows closed for
    brands with history; maker-checker on each post is an owner question), W2 (the exact
    reversal), W3 (a post repeats what its poster read), W4 (the note on the server), W5 and N1
    (a reopen names its close; the trigger stamps the times), W6 (the merge), W7 (tests: a close
    racing an in-flight entry, the WAC blend, concurrent scans, a stale reopen, the backfill);
    notes N2 to N7 and N9 to N11 fixed, N8 and N12 left (the POS tables use the same client-id
    keys; `brandShortName` follows `takeSequence`).
  - Re-check at bd3248f: 0 critical, 3 warnings (the price dialog could quietly refetch the
    draft beside the typed costs; no tests of the reversal's checks at the decision; the
    go-live runbook did not mention the window) and notes, fixed in 2c9d7ea and 3e72f26 (the
    window will not close while a reversal waits; the reversal checks the journal it reverses;
    count locks). A last check of those: 0 critical, 1 warning (a fresh brand counting stock in
    before signing the reconciliation would block the sign-off), fixed with notes 1, 3, 5 and 6
    in 428069a. Left as notes: a changed location marks no line in the price dialog (the
    dialog shows the location); N8, N12 and N-9 (display only).
  - acceptance-auditor at bd3248f: checks 1 to 5 evidenced, NOT READY on one gap: axe ran in
    the light theme only. Fixed in 2c9d7ea (the dark pass above, which found and fixed the
    error-text contrast); its nits fixed too (the sticker PDF checks skip, and say so, when
    Gotenberg is down; a Bangla label; the migration's comment). Not re-run after the fix.
- Decisions/assumptions: D-601 to D-609 (D-601 and D-604 ASSUMED; D-602's maker-checker on
  each post ASSUMED, an owner question); D-602, D-603, D-606 and D-608 amended after the audit.
- Migrations: `0113_m38a_barcodes_stock_in_hand.sql` (generated) and `0114_m38a_policies.sql`
  (custom), numbered after integration's frozen 0112. Both were regenerated on this unmerged
  branch after the ledger audit and never applied outside throwaway test databases.
- New dependencies: none from outside the repo. The console gains the workspace package
  `@elysium/domain`, through its `./barcode` entry only (scan detection and the bars on the
  product page, D-609).
- Preview: a database migrated with history (the shared preview) starts with opening stock
  closed for every brand that traded there; ask to reopen as org admin and approve as super
  admin, or try it in a brand without history. A preview built fresh by `preview:local` starts
  open.
- Owner questions: a second person on each stock-in-hand post (D-602); the A4 sheet stock's
  exact geometry (D-604); each brand's short name for stickers; the 3 : 4 crop (D-601); the
  thermal printers' dots per mm; `BarcodeDetector` is missing on some browsers (iPhones), where
  the camera button is hidden.
- Follow-ups: a pending reversal shown on the entries list (the entry's detail has it); the
  difference between 1300 Inventory and Σ on hand × WAC that §8's once-per-receipt rounding
  leaves (existing, unrecorded; `preview:seed` passes only with round costs) wants a decision
  row and a line on the valuation report; M38b's packing station reuses the scan detector and
  the lookup.

### 2026-10-05 · M34 · Buying on the website: checkout, accounts, SSLCommerz, email · built

- Delivered (branch `m34-buying`, from `integration-wave2`, merged again at 4e500db and 9d1a4cd):
  - **Cart and checkout** (D-520, D-521, D-532, D-539): `POST /storefront/v1/cart/quote` and
    `POST /storefront/v1/checkout` (signed over the idempotency key and the raw body, D-535).
    One pure rule (`quoteCart`) prices the quote and the checkout: shelf or flash price,
    M35a's discounts (codes and automatic), the website's zone fee and free shipping. The
    checkout re-prices (`409 CART_REPRICED` with the new quote), creates a `pending` website
    order, holds its stock at one web location with the atomic reserve (`409 OUT_OF_STOCK`),
    redeems the discounts, claims the flash units and returns a one-time view token. The
    state machine knows a held order (`stockHeld`): confirming it reserves nothing more, a
    pending cancel releases the hold.
  - **Shopper accounts** (D-522, D-523, D-533, D-534): register with a six-digit email code
    (HMAC'd, 15 minutes, 5 tries), sign-in (bcrypt 12; the old site's hashes still work),
    Google (linked only to a verified address), forgot and reset password (SHA-256 tokens, one
    hour, once), profile with saved addresses, change password, the account's orders. Guest
    orders join the account by verified email only. Limits per shopper address and email.
  - **The shopper's order** (D-524): by view token or account, the shopper's status words, the
    money, how it is paid, the address, the lines and the courier's tracking code.
  - **SSLCommerz** (D-525 to D-528, D-537): Website → Payments (store id, sealed password,
    sandbox or live, the IPN address, the online payments). The worker opens the session and
    checks every payment with the Order Validation API (exact amount, BDT, this transaction);
    an accepted one is a verified advance (Dr SSLCommerz clearing 1120 / Cr Customer advance)
    and lowers the COD. Unpaid online orders cancel after 60 minutes. UNVERIFIED adapter.
  - **Email** (D-529, D-530): an SMTP channel in `notify` per brand (Website → Email, a test
    button, the log); Bangla and English templates for the code, the reset link and order
    placed, confirmed, shipped, delivered, cancelled; written in the transaction, sent by
    the worker with the body sealed until it goes.
  - **Flash sales on the website** (D-538): `GET /storefront/v1/flash-sales` and `/:slug`, only
    SKUs the website sells, scheduled sales without prices.
  - **The old site's customers** (D-531): `pnpm migration legacy-customers --org <slug>
dry-run|commit --file <users.json>`.
  - **Console**: Website → Payments, Email and Customers; the order page's website card; the
    buyer profile's website account.
  - Docs: `docs/storefront-api.md` "Buying (M34)", architecture §31 "Buying (M34)" and the §7
    row, `docs/runbooks/website-buying.md`, CLAUDE.md Commands, the plan's Status.
- Verification:
  - `pnpm verify` (under `heavy.mjs`, `VITEST_MAX_WORKERS=4`) exits 0 at `f3398a2`: 212 test files, 3,280 passed, 1 skipped (the known skip); format, lint,
    typecheck, build, bundle (249.9 KB of 250: two strings shortened to fit), white label,
    migrations, schema drift (114 migrations), route matrix (390 routes, 352 matrix-tested, 38
    public), i18n and api-client all pass.
  - Acceptance checks 1-4 and 6 in `apps/server/src/modules/storefront/buying.e2e.test.ts` (29
    tests on real Postgres): quote = order = COD and `409 CART_REPRICED`; the last-unit race
    (one 201, one `409 OUT_OF_STOCK`, stock never below zero); a short SSLCommerz payment
    refused and audited (and its money owed back) and a correct one booked once from the IPN
    with exact balances and a zero trial balance; register, verify, sign in, reset, Google;
    twenty checkouts against a five-unit flash sale (five at the sale price, the rest
    `409 CART_REPRICED`, no sale-priced line without a claim, a cancel gives the unit back);
    a typed code and an automatic discount through the checkout (redemptions, attribution,
    release on cancel). Domain: `packages/domain/src/storefront/buying.test.ts` (31, fast-check)
    and the held-order rows in `orders.test.ts`.
  - `website-buying.stack.ts` against the real stack (ports 3216/5289): 4 passed, axe clean;
    screenshots in `docs/review/M34/`.
- Auditors:
  - ledger-auditor: 1 critical (a sandbox store's test-card payments would have been booked
    as real money), 8 warnings (a payment being checked could be expired; late gateway money
    kept under the cancel policy; refused-but-taken money left out of the ledger; the clearing
    wallet found by code; guest orders claimable by an unverified phone; console lists wider
    than sales' own scope; an unkeyed password fingerprint; untested money paths) and 8 notes.
    All fixed in f692e6e and 8eba94d (migration 0115). Re-check: 0 critical, 1 warning (a key
    the worker cannot open refused the payment instead of retrying) and five notes, fixed in
    872f94e; the one note left (a not-valid check returns the session to `ready` rather than
    its earlier state) is cosmetic.
  - acceptance-auditor: NOT READY with five gaps (the API client not regenerated after the
    scope change, check 5 unrecorded, no progress entry, no test of discounts through the
    checkout, the new key missing from the deploy configs), fixed in 62794f3 and 91c9426 and
    this entry, plus the bundle budget in f3398a2. Re-run at ff1a32c: READY (29 of 29
    end-to-end tests passing).
- Decisions/assumptions: D-520 to D-539 (ASSUMED: D-520, D-522, D-527, D-528, D-529, D-531,
  D-534, D-538); an "Unverified integrations" row for the SSLCommerz adapter.
- New dependencies:
  - `bcryptjs` 3.0.3 — bcrypt in pure JavaScript (no native build on Windows or Alpine) that
    also checks the old site's `$2a$`/`$2b$`/`$2y$` hashes, so imported shoppers keep their
    passwords.
  - `nodemailer` 10.0.12 — SMTP to each brand's own mail server, the mailer the old site
    already used.
- Migrations: `0113_m34_buying_schema.sql`, `0114_m34_buying_policies.sql`,
  `0115_m34_session_validating.sql`. 0113 and 0114 were regenerated after the first merge
  (renumbered after M35a's 0112); a local database that ran an earlier copy needs a fresh
  migrate.
- Deviations from the milestone spec: flash prices and the full discount engine moved into
  scope at the coordinator's request (plan item 8, check 6); the customers import is the
  optional command of D-561. A sandbox SSLCommerz store takes payments only where
  `STOREFRONT_SSLCOMMERZ_ALLOW_SANDBOX=true` (staging, preview, tests).
- Follow-ups:
  - The first SSLCommerz sandbox run, then marking the adapter verified (owner: human).
  - Gateway fees from SSLCommerz's settlement report into the clearing wallet (owner: claude).
  - `BRAND_STOREFRONT_CREDENTIALS_KEY` in Elysium's `.env.brand` before Website → Payments and
    Email are used there (owner: human).
  - Owner questions: splitting an order no single web location can fill (D-521); holding
    risky payments (D-525); whether M36's website must send `client.ip` (D-534).
  - The order page's website card and the buyer profile's card are covered by API tests but
    not by the stack spec.
  - The console's initial route is at 249.9 KB of 250: the next strings in the English catalogue
    need the section catalogues lazy-loaded first (owner: claude).
  - Kamal's deploy leaves `STOREFRONT_SSLCOMMERZ_ALLOW_SANDBOX` off for staging too; set it
    per environment if staging should take sandbox payments (owner: human).
  - Tests still to write (owner: claude): the real `SslcommerzGateway` and `SmtpMailer` against
    a stubbed fetch and transport; that the password fingerprint is keyed; D-534's sign-in,
    code-send and resend limits over HTTP.
- Next: integrate M34 into `integration-wave2`; M36 builds the website on these routes.

### 2026-10-05 · integration and deploy · M38a and M34 joined; Elysium's own ERP online · done

- M38a fast-forwarded into `integration-wave2` (dffe5d2; its verify green there, migrations
  0113–0114). M34 merged (7a0b0fd), its migrations renumbered after M38a's: 0115
  (regenerated, identical), 0116, 0117 (unchanged). Conflicts were side-by-side additions
  (stack provision users, docs, CLAUDE.md, §7's posting table).
- The console's initial route reached 250.7 KB of 250 at the merge: the 236 website keys moved
  into a section catalogue (D-607 amended), 247.8 KB after; the white-label check now scans
  section catalogues (93a9765).
- Verification at 93a9765: `pnpm verify` exit 0 — 218 test files, 3,364 passed, 1 skipped;
  bundle, white-label (216 files), migrations, schema drift (116), route matrix (403 routes,
  365 matrix-tested, 38 public), i18n, api-client all PASS.
- **Elysium's brand ERP is live** at `https://erp.elysium-lifestyle.bd` (D-581) on the brands
  server (103.129.209.29), deployed with `infra/brand/deploy.sh` after the owner's go-ahead:
  compose project `erp-elysium-lifestyle-bd`, API on 127.0.0.1:3501, a fresh database seeded
  with Elysium alone, certbot TLS, behind Cloudflare with the real-address snippet (D-580).
  Deploys: a80598e (first), dffe5d2 (M38a: stickers, stock in hand, scanner), 93a9765 (M34;
  `BRAND_STOREFRONT_CREDENTIALS_KEY` added to its `.env.brand` first). Health checks green
  after each; the server's other sites still answer 200.
- The first super admin (the owner's email) was created with `admin:bootstrap`; the one-time
  link was given to the owner.
- Every migration up to 0117 is now applied to a live database: frozen.
- Next: M35b and M36 (building), then M38b, then M32 resumes.

### 2026-10-05 · M36 · The new Elysium website on its ERP · built (website repo)

- Delivered in `D:\Projects\elysium` on branch `erp-storefront` (seven commits from
  f379c9d to aba9ecb): the site reads and writes only through the brand ERP's signed storefront
  API; the admin panel, the Mongo models, `mongoose`, the demo kit, Cloudinary, the ncom and
  Steadfast routes, scanner, upload and image routes, fraud and courier code and the landing
  pages are gone (about −46k / +6k lines); `/admin` answers 308 to the ERP. Shopper features
  kept: home, shop with filters and search, product page with sizes, size chart and flash prices,
  cart and checkout priced by the ERP (district and thana pickers, COD and SSLCommerz through the
  ERP), the order page by token or account, sign-up with an emailed code, sign-in, reset and
  change password, profile, addresses and orders, the frame from `GET /site`.
- Verification: Playwright 14 of 14 against a local preview brand ERP (`elysium_preview_m36`,
  API on 3300), including a COD checkout checked through the ERP (website channel, pending,
  stock held), sign-up and reset through a local TLS mail sink, an SSLCommerz return the ERP
  refuses, sign-in refusing off-site callbacks; `next build`, lint, the no-database check and
  11 unit tests green; the Docker image healthy read-only. acceptance-auditor: two real bugs
  (open redirect through `callbackUrl`; a checkout idempotency key lost after a gateway timeout)
  fixed and covered; its remaining points were these ERP docs.
- Decisions: D-560, D-562 to D-564 (D-561 is the owner's start-fresh decision).
- Waiting for M35b: campaign links, tracking, the scanner app's sign-in.
- Owner inputs for the demo: the website key and Site URL (a server command is being added so
  the key's secret is never shown), SMTP in Website → Email, SSLCommerz sandbox or live keys,
  a Google OAuth client for the demo host, products switched on for the website.

### 2026-10-05 · ops · A brand's website connected from the server (D-582) · built

- Branch `ops-website-key` from `integration-wave2` at 0e90e4a. Not merged, not deployed.
- `main.admin.ts` gains two commands beside `bootstrap` (unchanged):
  - `website-key --label "<label>"` issues a storefront site key for the deployment's brand
    through `StorefrontService.issueKey`, the console's own method (same derivation,
    fingerprint row and in-transaction audit row), and prints on stdout exactly
    `ERP_SITE_KEY_ID=…` and `ERP_SITE_SECRET=…`, for
    `… | sudo tee -a /etc/elysium-web/<site>.env >/dev/null`. The key id and everything else go
    to stderr; log lines too (`LOG_DESTINATION=stderr`, and stdout is redirected to stderr
    while a command runs). Refuses without `INTAKE_KEY_SECRET`.
  - `website-site-url --url https://…` saves Website → Settings' Site URL through the new
    `StorefrontService.setSiteUrl`: `patchSettings`' lock, merge and audit, with the other site
    details read inside the lock. `https://` only, no query or fragment; `http://localhost` is
    refused too (D-582 says why).
  - Both boot `WebsiteAdminModule` (the storefront service with the catalog, orders, files and
    approvals modules) as an application context, the way `pnpm migration legacy-customers`
    boots its importer, and act as `system:admin-cli` with `via: 'cli'` on the audit row. The
    brand is `ERP_BRAND_SLUG` (the boot check) or the database's one brand (`commandBrand` in
    `platform/brand/deployment.ts`); two brands, none or a switched-off one are refused.
- The settings audit summary now records `siteUrl` for every save. The HTTP harness takes
  `brands` to boot on a one-brand database.
- Scripts: `pnpm admin:website-key`, `pnpm admin:website-site-url` (root and server), beside
  `admin:bootstrap`. pnpm 12 prints its `$ …` lines on stderr, so the pnpm form pipes cleanly
  too. Runbook: `docs/runbooks/brand-deploy.md` §5; architecture §31; CLAUDE.md Commands.
- Tests: `website-admin.e2e.test.ts` (10, real PostgreSQL holding one brand beside the
  training org): the two lines and nothing else on stdout; the key signs
  `GET /storefront/v1/site` through the real guard (200; a wrong secret 401); the row and audit
  row with the system actor, `via: 'cli'` and no secret; `ERP_BRAND_SLUG` named; the Site URL
  saved with the other site details kept, and a save holding the settings lock is waited for
  and kept (the command is seen queued on the lock in `pg_locks` first); refusals without
  `INTAKE_KEY_SECRET`, without a label, for eight non-https or malformed addresses (nothing
  saved), for a switched-off brand, the training org named, and a second brand, named or
  not. The built CLI was also run end to end on a throwaway database with
  `NODE_ENV=production LOG_LEVEL=debug`, piped through `tee`: the file held exactly the two
  lines.
- ledger-auditor: 0 critical, 2 warnings. Fixed: the missing tests above (S2); the address is
  checked before the database is touched; a failure to close the modules no longer hides an
  issued key; exit 1 when stdout could not be written; an unknown command says `admin`; the
  saved address is compared with what reads back. S1, a Website → Settings page opened before
  the command and saved after it puts the old Site URL back (the form sends the whole
  section): a runbook warning for now. Not changed: the slug is read from the raw environment
  (the tests change it per call; `serverEnv()` still rejects a malformed one when the modules
  boot).
- Verification at 38d7059: `pnpm verify` exit 0 under the heavy lock (`VITEST_MAX_WORKERS=4`) —
  219 test files, 3,374 passed, 1 skipped; bundle, white-label (216 files), migrations, schema
  drift (116), route matrix (403 routes, 365 matrix-tested, 38 public), i18n, api-client all
  PASS. The rebuilt CLI run end to end again afterwards: the same two lines in the file.
- Follow-ups:
  - Settings saves conditional on `updatedAt` (409 when the section changed since the form
    loaded), so a stale console form cannot undo the CLI's or another person's save (owner:
    claude).
- Dependencies: none added.

### 2026-10-05 · deploy · The new Elysium website online at demo.elysium-lifestyle.bd · done

- Elysium's ERP redeployed at 550f5e5 (the website-key and Site URL commands, D-582); health
  green.
- The website (`erp-storefront` at cb7379e) copied to `/srv/elysium-web/releases/cb7379e23132`
  on the brands server (`/srv/elysium-web/current`), its settings in the root-only
  `/etc/elysium-web/demo.env` (NEXTAUTH secret generated on the server), the website key
  issued by `admin website-key --label "demo website"` and piped straight into that file (the
  secret was never displayed), the ERP's Site URL set to `https://demo.elysium-lifestyle.bd`
  by `admin website-site-url`. Container `elysium-web-demo-web-1` on 127.0.0.1:3601 (host
  network, read-only), healthy; `/api/health?erp=1` answers `"erp":"ok"`.
- nginx site `elysium-web-demo.conf` (Cloudflare real-IP include, rate limits) installed after
  `nginx -t`, certbot TLS; `https://demo.elysium-lifestyle.bd` 200, `/admin` 308 to the ERP;
  the server's other sites still 200.
- The owner still sets Website → Email (SMTP), Website → Payments (SSLCommerz), switches
  products on for the website, and optionally a Google OAuth client for the demo host.

### 2026-10-06 · M39a · Delete and archive everywhere · built

- Why: the owner's first use of the live ERP: "we don't have any option to delete categories,
  size chart and sizes and others" (D-620; plan `docs/plans/M39.md`, part M39a; investigation
  `docs/review/M39/investigation.json`). Built in parallel with M39b.
- Delivered (branch `m39a-delete-archive` from `integration-wave2` at 28e0c4c, not merged):
  - **What uses a row is asked of the modules that hold it** (D-621): `ReferenceRegistry` in
    `platform/references/`, with `CatalogReferences`, `LocationReferences` and
    `DiscountReferences`; inventory, orders, the till, supply, couriers, promotions, the website
    and marketing each register a checker counting their own tables (invariant 12). Inside each
    delete: lock, count, refuse with `*_IN_USE` and the counts in words, release, delete, audit.
    A delete-side 23503 maps to the same code. `GET …/:id/usage` answers what uses a row.
  - **Every delete keeps what it deleted** (D-622): the audit row's `before`, in the same
    transaction; the website's size chart, menu and hero slide deletes retrofitted.
  - **Catalog** (D-623 to D-626): categories (delete, empty-and-delete with subcategories moved
    up and menu entries moved, archive/restore; an archived category's products leave the
    website; discount scopes never rewritten); lists and values (`is_active`, delete, archive
    with their variants in one call, restore, reorder; the server refuses an archived value on
    a new variant); products and SKUs deleted when nothing references them; an archived
    product's address goes to the next product as `-2`; new variants keep a product's code
    prefix after it moves category.
  - **Cascades only from a deleted parent** (D-627): price history, empty stock levels,
    discount tiers and flash sale items, each guarded by a trigger for every role.
  - **Everything else** (D-628 to D-634): size charts' empty-and-delete and the menu's child
    count; locations, suppliers, discounts (restored paused), flash sales (archived), SMS
    templates and ad campaigns deleted when never used; branches renamed and switched off with
    guards (new `Branch` subject); expense and income heads added, renamed and archived, never
    deleted. `delete Supply`, `delete LandingPage` and `delete Campaign` for org_admin.
  - **Console**: the shared `DeleteOrArchive` dialog, on Catalog setup (explicit Archive and
    Restore replace the hidden checkboxes; value order; the location dialog's copy and the
    16-character code fixed), Website → Size charts and Menu, Campaigns → Discounts, Flash sales
    and Templates, Marketing → Campaigns, Supply → Suppliers, Branches and Accounts → Wallets.
    Strings in a `manage` section (D-607).
  - **After the ledger audit**: a supplier the books name as a party (an opening due) is kept;
    a supplier's audit row keeps no contact details; a branch is held by money in any of its
    wallet accounts, and a switched-off branch opens no till or shift; the discount restore
    guard reads under its lock; a category under an archived one is refused for a product;
    empties lock in id order and write one audit row per product moved; a campaign an order's
    recorded source names is kept, matched as §11's attribution matches
    (`OrdersApi.ordersAttributedTo`); posting the opening refuses a supplier deleted after its
    balance was staged (`SupplyApi.lockSuppliers`); an empty-and-delete refuses a target under
    an archived category, and a parent and its child emptied at once queue.
- Verification:
  - `pnpm verify` at 52774e6 (under the heavy lock, `VITEST_MAX_WORKERS=4`): exit 0 — 222 test
    files, 3,422 passed, 1 skipped; bundle 248.1 KB of 250 PASS; white-label (222 files) PASS;
    migrations (36 on main unchanged) PASS; schema drift (118 migrations) PASS; route matrix
    (446 routes, 408 matrix-tested, 38 public) PASS; i18n PASS; api-client PASS.
  - `catalog-deletes.e2e.test.ts` 28 passed, `platform/references/deletes.e2e.test.ts` 18
    passed, `migration.db.test.ts` passed, on throwaway databases.
  - `delete-archive.stack.ts` on 52774e6 (`E2E_API_PORT=3220 E2E_CONSOLE_PORT=5293`, one
    worker, under the heavy lock): 9 passed; screenshots `docs/review/M39/a-01` to `a-12`
    retaken.
- Acceptance checks:
  - **Check 1** — every M39a entity is deleted when unused and refused (archived instead) with
    its users named when used; nothing referenced by a stock movement, an order line, a till
    line, a supply line, a flash sale, a live discount or a lead can be deleted; the courier
    return line is counted (the `pg_constraint` test holds every foreign key into the catalog to
    a checker); a reference committing while a delete waits on its lock refuses the delete, and
    twelve racing rounds never leave a reference to nothing: `catalog-deletes.e2e.test.ts`,
    `platform/references/deletes.e2e.test.ts`, `delete-archive.stack.ts`.
  - **Check 2** — a category with two products, a subcategory (whose slug collides at the top
    level) and a menu entry is emptied into another and deleted in one transaction, and the
    signed storefront list shows the products under the new category:
    `catalog-deletes.e2e.test.ts` › "empties a category …", `delete-archive.stack.ts` with
    `docs/review/M39/a-02` and `a-03`.
  - **Check 8 (M39a part)** — `pnpm verify` green; ledger-auditor on the deletes and tenancy
    diff; the stack spec with screenshots `docs/review/M39/a-*.png`; acceptance-auditor.
- Auditors:
  - ledger-auditor (deletes, tenancy, branches, ledger parties), first pass: 1 critical (a
    supplier named only by an opening due's journal lines could be deleted), 6 warnings
    (supplier contact details in the audit row; branch money read from wallet rows only; no
    branch-hold tests; the holds read locked the branch; tills and shifts at a switched-off
    branch; the archived-discount restore race) and minors; all fixed in `00c1e2e`. Re-review:
    0 critical, 2 warnings (campaign usage did not match orders as attribution does; a balance
    staged before a supplier's delete) and notes; fixed in `52774e6`.
  - acceptance-auditor: NOT READY with 5 gaps (this entry; the stack spec on HEAD; an
    empty-and-delete target under an archived category; behaviour tests for courier returns,
    legacy ids, a campaign's product, a product-wide discount and an archived list; another
    brand's 404 on every route kind); all closed in `52774e6` and by this entry and run.
- Decisions/assumptions: D-621 to D-634 (ASSUMED: D-623, D-625, D-626).
- New dependencies: none.
- Migrations: `0118_m39a_delete_archive_schema.sql`, `0119_m39a_delete_archive_policies.sql`
  (renumbered at integration).
- For M39b (it owns `product-detail.tsx`, `products.tsx`, `new-product.tsx`):
  `productUsage`/`deleteProduct` and `skuUsage`/`deleteSku` in `apps/console/src/api/manage.ts`
  with `<DeleteOrArchive>` from `apps/console/src/ui/delete-or-archive.tsx`; `isActive` on each
  list and value of `GET /v1/catalog/attributes` (filter pickers for a new variant to
  `isActive !== false`).
- Follow-ups:
  - M35b's `storefront.custom_links` (category key, highlighted products) join the website's
    checker when that branch merges (owner: claude, at integration).
  - Owner questions: an archived category's products on the website (D-623); a grace period
    before deleting a never-stocked SKU if tills stay offline long (D-625); renaming the
    standard expense heads (D-634).
  - Product and variant delete buttons on the product page and list (M39b).
  - An orphan sweep for files no product, category or banner uses any more (critic).
  - Discount scope ids and a campaign's `product_ids` are soft references (no foreign key, no
    lock), so a discount created while a product is being deleted can name it; harmless
    (D-623), noted for whoever adds foreign keys there.
  - `ordersAttributedTo` reads `sales.orders.source` with no index; fine now, watch at §29's
    sizes.
  - Supply's ledger-party count and wallets' branch-money read add to the existing
    `module-boundaries` debt on `ledger.*`; a `LedgerApi` method would retire both.
  - No test drives the hero slide delete's audit row (it needs a stored file), or the 23503
    backstop in each module's mapper (only catalog's and the shared helper are tested).
  - The website's cache is forgotten inside the delete's transaction, so a read in the same
    instant can re-cache the old menu for up to 30 seconds (`SiteCache.TTL_MS`); an after-commit
    hook in `withOrg` would close it.

### 2026-10-06 · integration and deploy · M39a joined and live · done

- M39a (delete and archive everywhere) merged into `integration-wave2` (ff89eb8); its
  migrations 0118–0119 follow the live 0117 unchanged. Verify at ff89eb8 exit 0: 223 test
  files, 3,432 passed, 1 skipped; bundle, white-label (350 files), migrations, schema drift
  (118), route matrix (446 routes, 408 matrix-tested, 38 public), i18n, api-client PASS.
- Elysium's ERP redeployed at ff89eb8: health green; the website at demo.elysium-lifestyle.bd
  still reads it (`erp: ok`); the server's other sites 200. Migrations up to 0119 are frozen.

### 2026-10-06 · M35b · Campaign links, tracking, the ncom.bd connector, the packing scanner and order labels · done (on branch, not merged)

- Delivered: the rest of the old admin panel, run from the brand's ERP. **Website → Campaign links** (a five-digit code on the shop, a category or a page, with highlighted products, a banner and a pop-up, and a visit count; the website reads it through the signed API). **Website → Tracking** (the Meta pixel and Conversions API and GA4 with its Measurement Protocol; the website forwards its browser events, the ERP hashes personal data before storing it, seals what it will send and sends it from the worker; the order's `Purchase` is the ERP's own, `purchase_<order no>`, held until an online payment is booked; an event log). **Website → Marketplace** (ncom.bd's contract 1 under `/ncom/<org id>/…`: products, categories and live stock for ncom's own landing pages, holds through the inventory's atomic reserve, orders handed over and edited with revisions, status changes and desk edits sent back through an outbox, webhooks). **Orders → Scan** and the packing scanner app's routes (sign-in with password and authenticator code, a 30-day device token, the packing list by order number or parcel code in the person's own scope, pairing and signing phones out). The old **label sheet** as a bulk action on the orders list (eight paper sizes, QR codes). Landing pages were dropped by the owner mid-build (D-550: they are ncom.bd's).
- Verification: `pnpm verify` exit 0 (224 test files, 3,434 passed, 1 known skip; every gate; the console's initial route 248.3 of 250 KB), re-run after the last fixes. Acceptance: check 3 withdrawn (D-550); check 4 PASS (the old site's `ncom-check.mjs` and `ncom-order-check.mjs`, ported, pass against the ERP in `marketplace.e2e.test.ts`); check 5 PASS (`packing.e2e.test.ts`: sign-in with password and TOTP, lookup with the device token in scope, refused once revoked, after sign-out and once the person is switched off). e2e: `web-marketing.stack.ts`, 8 tests on the real stack (ports 3217/5290, one worker), screenshots in `docs/review/M35b/`. Route matrix and cost sweep cover every new route; the cost sweep drives every connector route signed as ncom.
- Auditors: ledger-auditor first pass 2 critical, 9 warnings (ncom amounts read as zero when missing; an ncom edit could rewrite the money unchecked; edit refusals never reached; same order under a new key; foreign lines plus a discount; desk edits not sent back; connector answers outside the serializers; tracking keeping personal data; marketing able to retarget the pixel; missing tests) and 13 notes, fixed in b8f591f; re-check 0 critical, 0 warnings; its notes fixed in d6c6169 (a unit-covering division in the money module, quantities read strictly, SQLSTATEs never taken for refusals) or recorded below. acceptance-auditor: NOT READY on its first pass with five gaps (this entry, the plan's status, the re-check's result, a stack run on the final code, and the scanner app as it ships calling the old site's `/api/admin/scanner/*`); all closed, the last by serving those two paths in the app's own error shape (D-554 amended).
- Decisions/assumptions: D-551 to D-559 (D-554, D-555, D-559 ASSUMED; parts of D-552 and D-556 ASSUMED), with D-552, D-553, D-556 and D-558 amended after the ledger audit and D-554 after the acceptance audit; a new event, `order.edited` (architecture §19); D-550 is the owner's. Two unverified integrations recorded: the Meta CAPI/GA4 adapters and the ncom connector against ncom.bd itself.
- Migrations: `0118_m35b_web_marketing_schema.sql` (schemas `marketplace` and `packing`, nine tables, `order_channel` gains `marketplace`), `0119_m35b_web_marketing_policies.sql` (RLS ENABLE and FORCE, grants, guard triggers), `0120_m35b_holds_final_events_purge.sql` (an ended hold is final; webhook claims prunable). M39a and M39b also add 0118/0119: renumber at integration.
- New dependencies: `uqr` 0.1.3 (server) — a zero-dependency MIT QR encoder for the label sheet's codes; the SVG is drawn in-house.
- Deviations from the milestone spec: ncom's addresses carry the org id (`/ncom/<org id>/v1/*`, not `/ncom/v1/*`): nothing else names the tenant before the signature is checked; the website's nginx can rewrite the old `/api/ncom/*` (M37). The scanner pairs a phone from the console with a one-time code instead of reusing a session. The courier fraud check is not carried over (D-291). The console's initial route is 248.8 KB of 250 (247.8 at the base): the four new lazy routes in the router.
- Follow-ups: the ledger re-check's notes left open: a desk edit reaches ncom a few seconds after it is made (the event dispatcher), so an ncom change in that window still passes the revision check; an order handed over with a line of the brand that no longer resolves is filed with that line as another shop's and a warning only on the Marketplace screen (the old site's behaviour; consider the order desk); untested paths: the edit refused for not collecting ncom's total, the edit leaving none of the brand's lines, ncom's own edit not echoed, the marketplace order's Purchase, the SSLCommerz waiting Purchase released, the 120-a-minute event limit, and a lookup by courier tracking code (owner: claude); `docs/build-status.md` still shows M35 at 30% (the coordinator's to update); verify the tracking adapters with a brand's dataset, test event code and GA4 DebugView, and the connector with ncom's dashboard test on a staging brand (owner: human); an index for the scanner's parcel-code lookup on `courier.consignments` (owner: claude); M39a registers `custom_links.category_id` and the highlighted products with `CatalogReferences` (owner: claude, M39a); M36's website gives its pixel `purchase_<orderNo>` and sends `tracking` with the checkout (owner: claude, M36); the generic keys added to `STOREFRONT_VISIBLE_FIELDS` (`meta`, `events`, `client`, `type`, `results`) could be narrowed (owner: claude).
- Next: integration into `integration-wave2`, renumbering the migrations after M39's.

### 2026-10-06 · M39b · Variant prices, buying prices and product management · built

- Delivered (D-635 to D-649; branch `m39b-variant-pricing` from `integration-wave2` at 28e0c4c,
  with `integration-wave2` at ff89eb8, M39a, merged in on 2026-10-06):
  - **New product**: prices by size and by colour in one step (a row's own price wins, then its
    size's, then its colour's, then the main price), rows chosen and set together (price,
    regular price, pieces, cost) or copied down, zero and negative figures refused on the
    screen, a regular ("was") price per variant, a weight, the category's default size chart,
    a colour per photo, and **a buying price per variant whether the stock is in hand or from a
    supplier** (D-421's one cost for all is gone).
  - **Product page**: each variant's price and regular price; for a `read:cost` role its average
    cost, last buying price (date, supplier) and a margin worked out in the browser; a stock-value
    tile; **Edit prices** with a bulk editor (all, a size, a colour or ticked rows; set, add,
    subtract, raise or lower by %, round; preview into the boxes; one save with one reason); one
    price history for every variant (price and regular price); **Buying prices** (the standard
    buying price per variant); **Sizes and colours** (new variants listed with the price they
    start at, never the cheapest or an archived one's; untick a size to stop it in every colour;
    a new axis offers to archive the old variants); a colour per photo; **Edit variant** (a
    supplier's barcode, a weight); **Duplicate**; the price tile for every reader; the 1440 px
    layout (codes on one line, icon actions in a sticky column).
  - **Receipts**: the receive dialog and Supply → Entries ("Add a product": every variant as a
    line) take a cost per variant, prefilled from the supplier's standard price, else the
    standard price, else the last buying price; a draft being priced is prefilled the same way;
    a scanned archived variant is refused; the draft-pricing Cancel label.
  - **Supply → Buying prices**: the standard buying price spreadsheet (download, check, import
    all or nothing). `supply.sku_purchase_prices` lives in supply only (invariant 5).
  - **Product list**: photo, stock, website switch, price range; a row menu (open, duplicate,
    show or hide on the website, archive) and bulk actions (show or hide, size chart, move to a
    category, archive, stickers).
  - **Delete** (M39a's routes and dialog, `delete Catalog`): in the product page's header, on
    each variant row and in the list's row menu. The dialog says what uses it; something nothing
    uses is deleted (its standard buying prices go with it, counted in the audit log); anything
    else is offered Archive or Restore. Pickers for a new variant offer only live lists and
    values; Sizes and colours keeps an archived one the product sells so it can be unticked and
    never adds a combination with one; a duplicate leaves such variants out and refuses an
    archived category, as the bulk move does. **Delete unused** on the list's ticked rows
    deletes the ones nothing uses and says how many it kept.
  - **Website**: the product page, the cards and the cart show the same price (a live flash
    price included) and strike through the regular price, or under a flash price the higher of
    the shelf and regular prices; the storefront API's "on sale" filter works (D-511
    amended); photos grouped by colour. (The website's own "On sale" link still opens its
    flash-sale page: a website follow-up.)
  - **Couriers**: a booking declares Σ qty × weight when every variant is weighed (Pathao never
    below 500 g), else the courier's default.
- Server: migrations (renumbered after M39a's frozen 0118 and 0119) `0120_m39b_variant_pricing_schema.sql` (columns, `supply.sku_purchase_prices`)
  and `0121_m39b_variant_pricing_policies.sql` (RLS, two `on delete set null (column)` composite
  keys, the price-history trigger widened to the regular price). New routes:
  `GET /v1/catalog/products/:id/price-history`, `POST /v1/catalog/products/:id/duplicate`,
  `PATCH /v1/catalog/products`, `PUT /v1/catalog/products/:id/images/:imageId/colour`,
  `PUT /v1/catalog/skus/:id/weight`, `PATCH /v1/catalog/skus` (inventory, the held-stock guard),
  `GET /v1/inventory/stock/products`, `GET`/`PUT /v1/supply/sku-costs`,
  `GET /v1/supply/sku-costs/export`, `POST /v1/supply/sku-costs/import/dry-run`,
  `POST /v1/supply/sku-costs/import`, `PUT /v1/storefront/products`; wider bodies on
  `POST /v1/catalog/products`, `POST …/variants`, `PUT /v1/catalog/prices` (regular price,
  expected price) and the category's website fields. Errors `CATALOG_SKU_HELD`,
  `SUPPLY_IMPORT_REJECTED`. Domain: `@elysium/domain/pricing` (new entry point).
- Verification:
  - `pnpm verify` (under `heavy.mjs`, `VITEST_MAX_WORKERS=4`): exit 0 at d46e0c8 (226 test files; every gate passed; initial route 248.5 KB of 250). Before the
    merge: exit 0 at 98f9ed0 (221 files). The first merged run had one failure outside M39b,
    `storefront.e2e.test.ts` "refuses a timestamp outside five minutes" (a `now + 301` that
    lands on 300 when a second ticks over under load); it passed on its own and in the next run.
  - M39 checks 3 to 7 on real Postgres in `apps/server/src/modules/catalog/variant-pricing.e2e.test.ts`
    (prices by size and +10 % with a history row each; per-variant receipt costs giving WAC 750
    after 700 and 800; cost to cost roles only and never through the catalog; the standard price
    prefilling, never moving WAC, its spreadsheet, the audit keeping counts only; duplicate with
    no stock; extend prices and code order; held-stock guard; the storefront's regular and flash
    prices and "on sale"; product stock totals, never another brand's; stale reprices refused; the catalog price
    spreadsheet naming a price that would reach its regular price; with M39a: a duplicate
    without archived values or categories, a bulk move refused into an archived category,
    standard prices through the real SKU, product and supplier deletes with their audit
    counts, the supplier keys swept from `pg_constraint`, a size chart emptied into another
    moving the category default). M39a's `catalog-deletes.e2e.test.ts` now lists the standard
    price's cascade from its SKU.
    Domain: `packages/domain/src/pricing/pricing.test.ts` (fast-check). Console:
    `m39b-ui.test.ts`. Route matrix and cost sweep cover every new route.
  - `variant-pricing.stack.ts` against the real stack (ports 3221/5294), now with Delete (the
    unused copy deleted, the shirt offered Archive, "Delete unused" on two rows): 7 passed with axe, with `catalog-stock.stack.ts`, `barcodes.stack.ts` and M39a's `delete-archive.stack.ts` in the same run (31 passed, d46e0c8). The first run at HEAD failed check 3: with several size lists in the brand, the quick prices followed the first list, not the one picked (fixed in d46e0c8). Screenshots
    `docs/review/M39/b-01` to `b-10`.
- Auditors:
  - ledger-auditor: 0 critical, 5 warnings, 11 notes. Fixed: W1 (the standard-price
    spreadsheet went into the audit log through the request body: the service now writes
    counts only, tested), W2 (the product page's per-variant archive now goes through the
    guarded route), W3 (`for no key update`, so repricing or archiving no longer blocks stock
    movements' key-share locks or risks a deadlock), W4 (a card only strikes through the lowest
    size's own regular price, tested), W5 (the product stock route tested: the stock page's
    scope, which §6 makes the whole brand for a branch manager, and nothing of another brand), N1 (no silent zero cost or ৳0.01 fallback), N2 (a negative cost is refused), N3
    ("Cost per piece" now speaks for every untyped variant), N4 (a reprice carries the price it
    was made against; a stale one is refused), N5 (Save waits until the preview has no problems),
    N7 (Pathao never below 500 g), N10 (tests: standard price never moves WAC, import refused for
    non-cost roles), N11 (the catalog price spreadsheet names a price that would reach its
    regular price, in the dry run). Left as recorded: W3's reserve-path re-check of the variant's status (an
    order confirmed in the same instant as an archive can still reserve it, as D-423 already
    allows for orders taken before an archive), N6 (price sort uses shelf prices, documented),
    N8 (kept), N9 (requests are chunked at 200).
  - ledger-auditor on the integration (ba851b0, 7eb3ca5): 0 critical, 2 warnings, 4 notes, all
    fixed in 4e2e8f1: W1 (standard prices tested through the real deletes, the supplier keys
    swept), W2 (a delete's standard prices counted in the audit log), N1 (shared locks in the
    duplicate and bulk move), N2 (`SUPPLY_NOT_FOUND` for a standard price racing a delete), N3
    (a size chart emptied into another moves category defaults), N4 (Sizes and colours adds no
    archived combination). Same unlocked check remains in M39a's own create and extend paths
    (follow-up).
  - acceptance-auditor: NOT READY at 4e2e8f1 with four gaps (no stack run at HEAD, this entry
    stale, bulk "delete unused" missing, the website's "On sale" claim); all four closed in
    2f4aece, d46e0c8 and e324aeb. Re-check at e324aeb: READY.
- Decisions/assumptions: D-635 to D-649 (ASSUMED: D-637, D-639, D-640, D-641, D-645, D-646);
  D-421 amended by D-635, D-511 by D-640.
- New dependencies: none.
- Deviations from the milestone spec: none.
- Follow-ups: M39a's create and extend paths check archived categories and values without a
  shared lock (owner: claude, with M39a's next change); `storefront.e2e.test.ts`'s timestamp
  test is flaky under load (owner: claude, M33); the catalog price spreadsheet's text is kept
  whole by the audit net (selling prices, not costs; owner: claude); the website's "On sale"
  link should open `?onSale=true` on its shop page rather than the flash-sale page, so regular
  prices show there too (owner: claude, website repo); the archive guard sees reserved stock, not pending orders without a reservation (M39a's
  reference port, owner: claude); a check that a "was" price was ever real (D-640, owner:
  human); Pathao's real minimum weight (owner: human, with credentials).
- Next: merge into `integration-wave2` (coordinator).

### 2026-10-06 · integration and deploy · M39b joined and live · done

- M39b merged into `integration-wave2` (f8d2cd3); code identical to its verified branch (verify
  at d46e0c8: 226 test files, 3,504 passed, 1 skipped; every gate; stack 31 passed;
  ledger-auditor 0 critical after fixes; acceptance-auditor READY). Migrations 0120–0121 follow
  M39a's 0119; schema drift PASS (120).
- Elysium's ERP redeployed at f8d2cd3: health green; the website at demo.elysium-lifestyle.bd
  reads it (`erp: ok`) and its home answers 200; the server's other sites 200. Migrations up to
  0121 are frozen.
- M35b's integration is renumbering its migrations after 0121 (0122–0124).
- Follow-up for the website repo: show the storefront's new regular (compare-at) prices and
  per-colour photos, and point its "On sale" link at the shop's on-sale filter.

### 2026-10-06 · integration · M35b joined (after M39a and M39b) · done, not deployed

- Branch `int-m35b` from `integration-wave2` at aebe7f5 (M39a live), then `integration-wave2`
  at e72c5ec merged in when M39b went live first (67349fc). `m35b-web-marketing` (3a26f2c)
  merged in a8f3aaf. Conflicts were side-by-side additions, all kept: CLAUDE.md's stack-spec
  line and the ncom checkers, `CatalogApi` (M39a's size-chart reassignment, M35b's marketplace
  reads, M39b's SKU weights, statuses and directory), `OrdersApi` (`CampaignMatch` and the
  packing facts), the storefront module's controllers, storefront-public (M39b's shown prices,
  M35b's exported `CategoryRef`), error codes, the contracts and i18n barrels (manage,
  catalog-pricing, web-marketing, packing sections), the route-matrix manifest and both auth
  sweeps' fixtures, architecture §31, progress, build status. The API client is regenerated
  from the merged server (`pnpm api:client`, 496 operations, exactly both sides').
- **Migrations renumbered** after the frozen, live 0118–0119 (M39a) and 0120–0121 (M39b):
  `0122_m35b_web_marketing_schema.sql` (regenerated, byte-identical to the branch's 0118),
  `0123_m35b_web_marketing_policies.sql` and `0124_m35b_holds_final_events_purge.sql` (the
  branch's 0119 and 0120, copied; 0124's header still says "0119's rules", meaning 0123).
  `check-migrations --base integration-wave2`: 193 unchanged. A dev database that ran the
  branch's own 0118–0120 must be rebuilt (its journal stamps would skip M39's).
- **The references join** (9d3927c, c713d3b; decisions 2026-10-06 integration rows): the
  website's checker counts a campaign link's category (its foreign key) and highlighted products
  (`campaign_links`, not movable: a shared link is never re-pointed or trimmed by a delete);
  the marketplace module registers with `CatalogReferences` and `LocationReferences` for ncom
  holds, live or ended (`marketplace_holds`); ncom's product listing and category list leave
  out an archived category's products and subtree as the website does (D-623). Tests on real
  Postgres in `web-marketing.e2e.test.ts` and `marketplace.e2e.test.ts`; the `pg_constraint`
  coverage tests list `storefront.custom_links` and `marketplace.ncom_holds`.
- Verification at 67349fc: `pnpm verify` exit 0 — 232 test files, 3,581 passed, 1 skipped;
  bundle 248.9 of 250 KB; white-label (244 files), migrations, schema drift (123), route matrix
  (497 routes, 439 matrix-tested, 58 public), i18n (4,088 keys), api-client PASS. Stack:
  `web-marketing.stack.ts`, `delete-archive.stack.ts` and `variant-pricing.stack.ts`, 24 of 24
  (screenshots retaken in `docs/review/M35b/` and `docs/review/M39/`); `delete-archive`'s list
  order assertion now polls (it raced the refetch once).
- Auditors on the merge: ledger-auditor 0 critical, 1 warning (the green verify was on an
  uncommitted tree; since committed and re-verified) and notes, fixed in c713d3b (the "Empty and
  delete" hint names a campaign link; ncom categories walk their ancestors; the hold-by-SKU
  count uses jsonb containment; migration numbers in comments and decisions) or below.
  acceptance-auditor on M35b items 4–8 and checks 4–6: the five earlier gaps closed, checks 4,
  5 and 6 and the join evidenced; its two integration gaps (the failed stack run, this entry)
  closed by the green re-run and this entry. Ledger re-audit of the M39b merge (67349fc): 0
  critical, 1 warning — an archived variant can meet a live ncom hold (the single-variant
  archive checks no held stock; a reserve reads `sellable` before locking), recorded as a
  2026-10-06 integration decision row with its fix, not changed at the merge; its notes: a doc
  comment moved, the rest below. Migrations 0118–0121 byte-identical to live, 0122–0124 to
  M35b's originals, snapshot chain intact; `catalog-deletes.e2e.test.ts` 28/28 on the merged
  order.
- Follow-ups: a campaign link saved at the same moment as a product delete can keep the deleted
  product's id (no foreign key on the highlighted list; M39a's soft references share the gap;
  the website skips it, a re-save says "No such product") — lock the products `for key share`
  in `assertRefs` (owner: claude); a campaign link may still be pointed at an archived category
  (owner: claude); `check-migrations` compares with `main`, so pass `--base` at the live
  commit on integration branches (owner: claude); the archived-variant / ncom-hold gap above:
  the single archive through the held-stock check, SKUs locked before every reserve, ncom and
  checkout holds named in `CATALOG_SKU_HELD` (owner: claude); should ncom see flash prices and
  M39b's per-variant weights (owner: human); the cost-sweep fixture for
  `GET /v1/inventory/stock/products` asks for a random product (owner: claude).
- Next: the coordinator fast-forwards `integration-wave2` and deploys (migrations 0122–0124
  become frozen).

### 2026-10-06 · deploy · M35b live on Elysium's ERP · done

- `integration-wave2` fast-forwarded to the M35b integration (f69fdea; verify at 67349fc green:
  232 test files, 3,581 passed; stack 24 of 24; ledger and acceptance audits run). Migrations
  0122–0124 follow M39b's 0121 and are now frozen.
- Elysium's ERP redeployed at f69fdea: health green, the website still reads it.
- Its nginx site (installed once and never rewritten by a deploy, because certbot edits it) was
  patched by hand to the template's API paths: `/ncom/` (the ncom.bd connector) and
  `/api/admin/scanner/` (the shipped scanner APK's old addresses) now reach the API (an unsigned
  ncom ping answers 401, the scanner login 400); `nginx -t` passed before the reload, with a
  backup to roll back to; the server's other sites still 200.
- Still to do: the website repo shows the new regular prices, colour photos and campaign links,
  and turns tracking on; ncom.bd's credentials go into Website → Marketplace when the owner has
  them.

### 2026-10-06 · website · Regular prices, colour photos, campaign links and tracking on the new site · done

- The website repo's `erp-storefront` gained b433c66 and 8451835: the ERP's regular price
  struck through everywhere a price shows, "On sale" through the ERP's filter, photos switched
  by colour, campaign links (`?cu=`) mapped to the real ERP route with a view counted once per
  visit, and tracking from the ERP (off until switched on in Website → Tracking; browser events
  batched to the ERP, never Purchase; the confirmation page's pixel uses `purchase_<orderNo>` so
  the ERP's server Purchase deduplicates). Playwright 20 of 20 against the live code's ERP,
  37 unit tests, lint clean, no-database check; acceptance-auditor READY. No ERP change.
- Redeployed to demo.elysium-lifestyle.bd (release 845183525925, the previous image kept as
  `elysium-web:previous`): healthy, reads the ERP, home and the on-sale shop answer 200.
- To switch tracking on later: the nginx tracking-proxy include on the demo site, the pixel and
  GA4 ids in Website → Tracking, and `STOREFRONT_TRACKING_PROVIDER=live` with
  `STOREFRONT_TRACKING_ENABLED=true` on the brand ERP.

### 2026-10-06 · hotfix · Sticker and every other PDF failed on the live ERP · fixed

- The owner's "Print stickers" failed with "the failure is logged". The live API's log:
  `Cannot find the Bangla fonts. Set PDF_FONT_DIR …` from `loadFonts` (catalog labels).
- Cause: `apps/server/src/modules/files/pdf/fonts.ts` never read `PDF_FONT_DIR`. The server
  image sets it to `/app/fonts` (where the fonts are) and also keeps a `pnpm-workspace.yaml` at
  `/app`, so the workspace walk stopped there, looked for a `packages/ui` the image does not have,
  and threw. All seven production callers (SKU stickers, courier labels, packing order labels,
  invoices and their documents, payslips) were affected on any deployed server, including the
  test site; every local and CI test passed because a checkout has the folder the walk finds.
- Fix 8f68372: the variable wins whenever it is set; `fonts.test.ts` reproduces the image's
  layout (marker at the root, no packages/ui, fonts in their own folder). PDF tests 19 of 19,
  typecheck and lint green; deployed to Elysium's ERP at once; on the live server the four faces
  load and Gotenberg returns a PDF with Bangla text. Full verify run afterwards (below).
- Lesson: deployed images need a smoke test that renders one PDF; added as a follow-up for
  M14b/M30 part 2 (a post-deploy check in `infra/brand/server-deploy.sh`).

### 2026-10-06 · pause · Weekly usage limit reached

- The hotfix's full verify passed at 613efaf: 233 test files, 3,585 passed, 1 skipped.
- Builders stopped by the account's weekly limit (resets 2026-10-09, 07:00 Asia/Dhaka), work
  safe on disk (no zeroed files): M38b on `m38b-pack-video` at 8982c9c (station screen, recorder
  and upload queue committed; 4 files uncommitted), M32 on `m32-mother` at 84265aa (merged with
  today's integration; deploy scripts in progress; 9 files uncommitted), stickers (45 × 35 mm,
  custom size, extra line) on `stickers-sizes` not started.

### 2026-10-06 · M38a · Stickers: 45 × 35 mm, a custom size and an extra line · done

- Delivered (owner's request, branch `stickers-sizes`): **Print on** offers a 45 × 35 mm thermal
  roll beside 38 × 25, 40 × 30 and 50 × 25, and **Custom size…** with width and height in mm
  (25–110 × 15–100, one decimal), one sticker a page at exactly that size. Every size is laid
  out by one rule, `stickerLayout` in `@elysium/domain/barcode` (D-650): the module a whole
  number of 203 dpi dots (0.25 mm floor, so under 29.3 mm wide is refused with the least width
  that prints), bars never under 5 mm, lines given up least important first (the name's second
  line, the extra line, the SKU code, size and colour, the name; never the brand and price row
  or the barcode). An optional extra line of up to 40 characters on every sticker of a print,
  under **More options** (D-651). A live preview drawn from the same layout, saying what was
  left off; the medium, custom size, price choice and extra line remembered per person on the
  device (D-652). Same dialog at every entry point. No migration; no API-client change (the
  labels route's body is untyped in the generated client).
- The fixed sizes print as before: the regenerated `sticker-thermal-38x25.png` and
  `sticker-thermal-50x25.png` match the old ones (38 × 25 at 0.25 mm and 7 mm bars, 50 × 25 at
  0.375 mm); new review images `sticker-thermal-45x35.png` (with "Made in Bangladesh") and
  `sticker-custom-32x20.png`, and `03b-stickers-custom-size.png` of the dialog. On the A4 3 × 8
  sheet a name between about 39 and 49 characters now reserves two lines where it fits in one
  (the cutting estimate is conservative); cosmetic, sheets only.
- Verification: `pnpm verify` exit 0 at 65eb92d (merged with `integration-wave2` a0f1f97): 234 test
  files, 3,606 passed, 1 known skip; every gate (bundle 249.1 KB of 250, white label, migrations,
  schema drift, route matrix, i18n, api-client) PASS.
  Targeted: domain layout property tests (never outside the sticker, no overlapping rows,
  module ≥ 0.25 mm and bars ≥ 5 mm, refusal exactly under 29.25 mm, deterministic, drop order;
  2,000 runs each); server `stickers.test.ts` 16 of 16 against the real Gotenberg (every
  medium's MediaBox including 45 × 35, a custom 32.5 × 20 at 92.13 × 56.69 pt, out-of-range and
  two-decimal sizes refused by the schema, 27 mm refused by the service with
  `CATALOG_LABELS_INVALID` before any read); console `m38a-ui.test.ts` 17 of 17 (the dialog's
  validation); `barcodes.stack.ts` 8 of 8 on the real stack (a 25 mm width refused in the
  dialog, a 32.5 × 20 print with an extra line: nine pages of exactly that size; axe clean in
  both themes). Console initial route 249.1 KB of 250.
- Auditors: ledger-auditor n/a (no ledger, stock, tenancy or permission change; stickers still
  select no cost).
- Decisions/assumptions: D-650 (ASSUMED: the 0.25 mm floor, the 0.5 mm edge, the size limits),
  D-651, D-652.
- New dependencies: none.
- Follow-ups: the owner to print one 45 × 35 and one custom run on the shop's printer and scan
  them (owner: human); `docs/build-status.md` unchanged (one cell; left to the integration).
- Next: deploy to the live ERP (coordinator).

### 2026-10-07 · trust-votes · Admins vouch for an admin; a trusted checker may approve their inviter · built, lean-tested

- Delivered (owner's request, branch `trust-votes`): **Staff** shows each active admin's
  **Trusted** badge or "n of m votes"; **Manage** has a Trust section with **Trust** /
  **Withdraw trust** and the reason a vote would not count. Routes
  `POST /v1/users/:id/trust` and `DELETE /v1/users/:id/trust` (`update User`, route matrix
  and fixtures added); `GET /v1/users` rows gain `trust`. `iam.trust_votes` (migrations `0125_trust_votes_schema`,
  `0126_trust_votes_policies`). The rule is `trustGraph` in `@elysium/domain/iam` (D-656): only
  independent admins count (no one in the candidate's invitation chain either way, no shared
  inviter but a super admin, two-step sign-in on), two thirds of them and at least two.
  `ApprovalsService.decide` sets the grant-lineage refusal aside for a trusted checker, counted
  live in the decision's transaction, never for a `credential_reset` (D-655). Strings in a new
  `trust` section catalogue (lazy, not in the first download).
- Verification (lean, as asked; full testing scheduled for Friday): typecheck (server,
  console), eslint on every touched file, prettier, `check:routes`, `check:api-client`,
  `check:migrations`, `check:schema`, `check:i18n` all PASS; domain `iam` tests 44 of 44
  (13 new trust properties over random invitation forests with cycles: independence symmetric
  and exactly the stated rule, no related voter ever counts, quorum of two, withdrawal never
  helps, an owner never vouches down their chain); i18n 64 of 64; module-boundaries 30 of 30.
  **Not run:** `trust.e2e.test.ts` (the Riya → Faisal + puppets scenario against real
  Postgres) and the route-matrix suite: Docker was not running, so Testcontainers could not
  start. No `pnpm verify`, no stack runs, no bundle check, no auditors.
- Decisions: D-654, D-655, D-656. New dependencies: none.
- Follow-ups: run `trust.e2e.test.ts`, the route matrix and `users.e2e.test.ts` with Docker up;
  ledger-auditor on the diff (permissions); `pnpm check:bundle` after a console build. In
  Elysium as it stands (the owner invited Riya, Riya invited everyone else) nobody is
  independent of Faisal, so he cannot become trusted until a second super admin or an admin the
  owner invited directly joins (D-656's note).

### 2026-10-07 · parent-sku · Parent SKU names a product and is its web address; duplicate N copies, one or many · built, lean-tested

- Delivered (owner's request, branch `parent-sku-slug`): a product's **parent SKU** is its SKU
  code without the size and colour (`ELY-HAWA-0020`, `parentSkuCode`); every new product's web
  address is it in lower case (`ely-hawa-0020`) on every create path (form, new-products
  spreadsheet, duplicate), whatever the request sends, so names may repeat (D-661).
  `parentSku` on product responses and list rows; shown in the product page header and as a list
  column; the new-product form no longer makes an address from the name. Duplicate takes
  `copies` 1 to 50, one transaction, consecutive numbers, variant codes following (D-662);
  `POST /v1/catalog/products/duplicate` and the list's bulk **Duplicate** copy many products in
  the list's order, all or nothing, at most 200 new products (D-663). Limits shared through
  `DUPLICATE_LIMITS` in `@elysium/contracts`. Preview seed finds its products by name now. No
  migration.
- Verification (lean, as asked): typecheck (server, console), eslint and prettier on every
  touched file, `check:routes` (the new route declared and matrix-tested), `check:api-client`
  (regenerated), `check:i18n` all PASS; domain catalog tests (new `parent-sku.test.ts`: slug =
  lower-cased parent SKU over random orgs, categories and sequences, consecutive copies, no two
  sequences share an address, read-back from codes), console `duplicate-copies.test.ts` (the
  copies field accepts exactly what the server schema accepts; the 200 cap), console catalog,
  i18n and preview setup tests: 171 of 171. **Not run:** Docker was off, so no Testcontainers:
  the new `variant-pricing.e2e.test.ts` case (3 copies on consecutive numbers with their variant
  codes, bulk 2 × 2 in order, all-or-nothing on an archived product, roles, limits) and the
  updated `catalog-deletes`, `storefront` e2e expectations are written, not run. No
  `pnpm verify`, no stack runs, no bundle check, no auditors.
- Decisions: D-661, D-662, D-663 (ASSUMED in D-663: archived products refused by the bulk route
  only; the 200 cap). New dependencies: none.
- Follow-ups: run `variant-pricing`, `catalog-deletes`, `storefront`, the route matrix and
  `catalog.db` with Docker up; ledger-auditor on the diff (the duplicate's lock order changed
  shape, though not order); `pnpm check:bundle` after a console build (strings and code are in
  the catalog route chunks).

## 2026-10-07 · wave 3 · super admins, Beownz online, Elysiam, the sign-in fix, M38b and M32 joined

- **Super admins** (branch `superadmin-power`, D-657 to D-660, migrations 0127 and 0128): a
  super admin's vote counts for anyone and one is enough; super admins show on the Staff page;
  super admins make super admins (the second at once, from the third on by every existing
  super admin's vote). Merged and live on both brands.
- **Parent SKU** (branch `parent-sku-slug`, D-661 to D-663): see the entry above. Merged and
  live. On the owner's instruction the 27 existing Elysiam products were renamed
  "Mens Cotton Hawaiian Shirt" with web addresses `ely-hawa-0002` to `ely-hawa-0028` (the old
  addresses kept in `previous_slugs` and redirected), by a script the owner ran.
- **Beownz's own ERP** at `https://erp.beownz.com`: `new-brand.sh beownz erp.beownz.com`
  (API 127.0.0.1:3502, `BRAND_BEHIND_CLOUDFLARE=true`), first deploy seeded the brand alone,
  certbot TLS, the first super admin invited (the owner's address). No website.
- **The brand is spelled Elysiam** (D-664): the seed, the website's text, CLAUDE.md; the
  white-label check bans `elysiam` too; the live brand's names changed by a script the owner
  ran. Technical names keep `elysium`.
- **Sign-in fix** (3dbbd36): the enrolment hatch walled `sign-in/email` and the password links
  for a browser still holding a half-enrolled session, so after leaving the two-step set-up
  every sign-in with the right password answered 403. Those paths now pass the hatch (they prove
  identity afresh); the new session is walled until the factor is real. A case added to
  `http-surface.test.ts` (not run: no Docker). Live on both brands.
- **M38b** (scan-to-pack and the packing video): `integration-wave2` merged in, migrations
  regenerated as 0129 and 0130 (schema SQL identical), API client regenerated, route gate PASS
  (514 routes), typecheck PASS; architecture §20, §22, §31, `docs/training/packing-station.md`,
  the runbook's nginx patch for video uploads, CLAUDE.md. Merged into `integration-wave2`; not
  deployed.
- **M32** (the mother ERP): `integration-wave2` merged in, the reporting grants regenerated as
  `0131_reporting_reads` (no schema drift), typecheck PASS (28 tasks);
  `docs/runbooks/mother-deploy.md`, architecture §30, decisions D-480 to D-499, CLAUDE.md.
  Merged into `integration-wave2`; not deployed (needs the owner's server and domain).
- Verification (lean, as the owner asked; full tests on Friday): typechecks, lint and prettier
  on touched files, domain tests for trust and super admin (26/26), the white-label test (5/5),
  the route and API client gates. **Not run:** `pnpm verify`, Testcontainers suites (Docker off),
  stack runs, bundle check, ledger-auditor and acceptance-auditor for M38b, M32 and this week's
  permission changes.
- Follow-ups for Friday: `pnpm verify`; `users.e2e`, `trust.e2e`, `http-surface`,
  `variant-pricing`, `catalog-deletes`, `storefront`, `pack-station` e2e; `packing.stack.ts`;
  the mother's `e2e:stack`; `check:bundle`; ledger-auditor (trust and super admin votes, the
  duplicate's locks, M38b's state path, M32's money reads and 0131 grants); acceptance-auditor
  for M38b and M32. Before the packing station is used live: the nginx hand patch for
  `/v1/files/content` on Elysiam's site.

## 2026-10-08 · wave 3 · Friday's tests: M38b and M32 tested, audited and fixed; everything live on both brands

- **Made live first** (the owner: "start the Friday work now and first make everything live"):
  both brands deployed at 4ab78ba (M38b, M32's brand side 0131), then d74ba47 (the trust fix,
  0132), 33e6c25 (D-666) and 13b9b59 (M38b's audit fixes, 0133, the white-label fix); the
  live nginx sites of both brands hand-patched for packing video uploads (96 MB on
  `/v1/files/content`, backups beside them, `nginx -t` passed).
- **Three ledger audits** (2026-10-07):
  - This week's permission changes: 2 critical. (C1) a super admin's own trust vote let their
    invitee approve that super admin's request — `checkerTrust` now drops the requester's vote,
    and trust needs an active org admin role (D-667, `trust.e2e`); (C2) whoever invites a super
    admin holds their password link — the owner chose: only the first super admin (or an owner)
    starts a super admin nomination or invite (D-666, `super-admin.e2e`, the Staff screen's
    button). Both fixed and deployed the same day.
  - M38b: 0 critical, 3 warnings (orphan video files, the guard registry and an append-only
    trigger on scans in 0133, the public upload buffering 90 MiB before its token was checked)
    and the notes (late video parts, retention carrying on, sales' recent sessions scoped in SQL,
    resellers refused, 409 on a duplicate file, D-665): all fixed on `m38b-audit-fixes`.
  - M32: 1 critical (the separation test's host list), 4 warnings (the nightly full pull
    swallowed by a tick, column write grants invisible to the guard, `?user=` in a read
    connection, trusted devices) and notes (unused reporting columns revoked in 0132, the acting
    owner re-read, the figures dated by their read, the mother's sign-in never walled): fixed.
- **M32 acceptance audit**: 5 gaps (the trusted-device test blocked by the sign-in limiter,
  tests for the full pull's key and concurrent pulls, the unreachable brand's badge, docs,
  unverified infra in decisions): fixed in 410f89d and a64c9b5.
- **Evidence:** `pnpm verify` at a64c9b5: format, lint, typecheck, 252 test files, 3829
  passed, 1 skipped, build, bundle PASS; then the white-label check found two brand-named
  storage keys in the packing station (fixed in 13b9b59), after which white-label, bundle,
  migrations, schema, routes (514), i18n and api-client all PASS. Stack runs: the mother's
  `e2e:stack` 4/4 (checks 1 and 2 against real brand APIs); `users.stack.ts` and
  `variant-pricing.stack.ts` 11/11; `packing.stack.ts` and `barcodes.stack.ts` 13/13. The
  mother's database and HTTP suites 44/44; trust, super admin and users 104/104.
- **Acceptance audits:** M38b, checks 1 to 3 evidenced (`pack-station.e2e` 27/27 with
  `packing.e2e`, the domain's fast-check 18/18, `pack-station-ui` 14/14, `packing.stack.ts`,
  retention with a clock: nothing at 23:59 Dhaka on day 7, deleted at 00:01 on day 8), docs gaps
  only, fixed here. M32, re-audited: every code and test gap closed (the mother's suites 114/114
  on 13b9b59), docs gaps fixed here. Both milestones done; M32 not deployed (needs a server).
- Decisions: D-665 (resellers refused on packing records), D-666 (only the first super admin
  adds super admins, RESOLVED by the owner), D-667. New dependencies: none.
- Open: a way to remove a super admin, and a super admin invited who never finishes signing up
  stays a required voter (D-667); the mother's server and domain from the owner, then its first
  deploy (unverified infra, decisions.md); a `pg_hba` rule limiting a brand's reporting port to
  `erp_analytics`; comparing the mother's P&L with the brand's own reports service.

## 2026-10-08 · M38c · IP camera recording for the packing station (built, not deployed)

- **The owner's request** (2026-10-08): the packing table's IP camera
  (`rtsp://192.168.20.111:554/stream1`, a user name and password) ready when the order slip is
  scanned, recording from two seconds before the first scanned item, and only an item verified
  as correct for the order starts it. Branch `m38c-ip-camera` from `integration-wave2` at
  3d8de8e; not merged, not deployed. Decisions **D-668 to D-676** (D-669, D-670, D-675, D-676
  ASSUMED), plus an "Unverified integrations" entry: never run against the owner's camera.
- **Built:**
  - `packing.cameras` (migration `0134_m38c_ip_camera_schema`, generated; `0135_m38c_ip_camera_policies`:
    RLS ENABLE and FORCE, grants without DELETE, triggers): RTSP address without credentials
    (`rtspUrlSchema` in `packages/contracts` and a database check), user name, a write-only
    password sealed with the brand's `STOREFRONT_CREDENTIALS_KEY` box (D-528), on/off, the
    recorder's status. `GET/POST /v1/packing/cameras`, `PUT /v1/packing/cameras/:id`
    (`update PackingVideo` to change, `update Order` to read names and states), audited with
    the fingerprint only; route matrix, fixtures, OpenAPI catalog, API client regenerated.
  - The window (`packages/domain/src/packing/camera.ts`, fast-check): `recording_from` = the
    first **accepted** scan's own time − 2 s, in the scan's transaction; `recording_to` at the
    finish (at most 15 minutes) with `packing.camera_cut` enqueued in the finishing transaction;
    an open recording closed at 15 minutes by the camera process. Triggers hold it.
  - The camera process `dist/main.camera.js` (`start:camera`): ffmpeg `-rtsp_transport tcp …
-map 0:v:0 -an -c copy -f segment -segment_time 1` into wall-clock-named segments (renamed
    by their span from the file times, not `-strftime`, which overwrites two segments opened in
    one second), the rolling buffer (last minute plus every uncut window, never over 30
    minutes), backoff reconnects, status per camera, masked logs; the cut (concat demuxer,
    `-c copy`, `+faststart`, parts under 86 MiB) kept through the new
    `FilesApi.storeProduced` and filed as `packing.videos` rows with `source = 'camera'`;
    retention and playback unchanged.
  - Console: Recording source per desk (`erp.pack.source`), the IP camera card (ready,
    offline with the reason, recording since, being cut, saved), Orders → Pack → Settings →
    IP cameras (React Hook Form with the contract schemas), the order page marking a camera's
    part; strings in bn and en.
  - Infra: Debian's ffmpeg 5.1 in the server image (about 470 MB uncompressed, measured);
    `camera` service in `infra/brand/docker-compose.brand.yml` (application role, `files` and
    `camera-buffer` volumes, no ports); the deploy script's logs name it. Docs: architecture
    §20, §22, §31; `docs/training/packing-station.md` (setting up an IP camera); the brand
    deploy runbook (the camera service, reachability, the password only in the ERP);
    `docs/plans/M38.md`; CLAUDE.md; build status.
- **Evidence:** domain 32/32 (14 new); contracts 7/7; the recorder, buffer and cut with a
  stand-in ffmpeg 10/10 (the password reaches ffmpeg and never the log); `camera.e2e.test.ts`
  11/11 and `pack-station.e2e.test.ts` 19/19 on real Postgres; console `pack-station-ui` 20/20;
  all touched suites together 116 files, 1862 passed, 1 skipped (`camera.ffmpeg.test.ts`: no
  ffmpeg on this PC). A real ffmpeg 5.1 in the server's pinned node base image
  (`docs/review/M38c/`): a synthetic H.264 stream and a **password-protected RTSP stream**
  (mediamtx 1.15.3, password with `!@#&`) recorded into one-second segments, a 5.000 s window
  cut to MP4 without re-encoding, starting no later than the window, and a wrong password
  reported as `auth_failed` with ffmpeg's line masked (`rtsp://***@…`). The camera process
  booted against a fresh database beside the worker and wrote `ffmpeg_missing` on the camera
  (no ffmpeg on Windows). Gates: format, lint (28 tasks), typecheck and build (18 tasks),
  routes (517), i18n, migrations, schema, api-client, white-label and bundle (249.9 of 250 KB,
  the camera code in the lazy pack-station chunk) all PASS.
- New dependencies: none (ffmpeg is an OS package in the image, D-675).
- **Not done:** `pnpm verify` as one run (its parts ran separately above); a Playwright stack
  spec for the camera screens and screenshots; the ledger-auditor (tenancy, permissions,
  files) and acceptance-auditor; a test against the owner's real camera (needs the deploy).
- **For the owner after the deploy:** Orders → Pack → Settings → IP cameras → Add camera: name,
  `rtsp://192.168.20.111:554/stream1`, the camera account's user name and password (typed
  there, never in chat); check it reads Ready; choose it under Recording source on the packing
  computer; pack one order and play its video. `stream2` is the smaller picture if
  `stream1`'s ~15 MB a minute is too much.

## 2026-10-08 · M38c · the ledger audit's findings fixed (not deployed)

- **Ledger audit** of 3d8de8e..36b40e0: 0 critical, 6 warnings, 5 notes, all fixed on
  `m38c-ip-camera` (decisions D-669 corrected, D-677 to D-682; migration
  `0136_m38c_camera_audit_fixes`, a trigger only):
  - W1 the camera's credentials were on ffmpeg's command line (readable by any user of the
    host). Now in a private ffconcat list (0600, removed five seconds after ffmpeg started);
    verified on the image's ffmpeg 5.1 that recording works this way and ffmpeg's argv holds
    neither the password nor `rtsp://`. What remains (memory, those seconds on disk) is root's
    to read, as `.env.brand` is; `hidepid=2` is in the runbook as optional hardening.
  - W2 a stored password no longer follows the address to another host or port; W3 protocol
    whitelists `file,rtsp,tcp` and `file`; W4 loopback, link-local, unspecified, one-word and
    odd numeric hosts refused by the shared schema, re-checked and resolved before every
    connection, and the `camera` service on a compose network with Postgres only; W5 ffmpeg runs
    with `PATH` and `TZ` only, and the camera process has its own configuration and compose
    environment (no other secrets); W6 a 2 GiB byte cap per camera, a 5 GiB free-disk floor
    (`disk_low`), dead cuts cleared, eight cameras per brand.
  - N1 the camera is fixed once a piece is in the box; N2/N4 the start held to the first
    accepted scan, by its scanner, on a camera that is on (domain rule and 0136's trigger); N3
    only the deployment's active brand; N5 a part over the ceiling filed as never arrived, and a
    failed cut forgets what it stored.
- **Evidence:** domain 34/34; contracts 10/10; the recorder and cut 14/14 and the camera config
  3/3 (stand-in ffmpeg with a bare environment); `camera.e2e.test.ts` 19/19 (8 new: W2, W6 cap
  and disk, N1, N2/N4, N3, N5 and a failing cut) and `pack-station.e2e.test.ts` 19/19 on real
  Postgres; console `pack-station-ui` 20/20. A real ffmpeg 5.1 in the server's base image
  against mediamtx with a password (`docs/review/M38c/`): 8 segments in 9 s through the private
  list, ffmpeg's argv without the password or `rtsp://`, its whitelist `file,rtsp,tcp`, its
  environment `PATH` and `TZ` (an `AUTH_SECRET` given to the parent did not reach it), a 5.000 s
  H.264 cut, a wrong password `auth_failed` and masked, `rtsp://valkey:6379/` `address_refused`
  without ffmpeg starting. The camera process booted against a fresh database with only its own
  variables. Gates: typecheck and build (18 tasks), lint, format, routes (517), i18n, migrations,
  schema (135), api-client (regenerated for the two error codes): PASS.
- New dependencies: none.

## 2026-10-08 · M38c · live view of the IP camera, and deleting a camera (not deployed)

- **Owner's request:** "add always live preview option for stream in use in the pack section.
  and add option to delete them also". Branch `m38c-live-preview` from `integration-wave2`
  (b672730). Decisions D-683 (ASSUMED), D-684; migration `0137_m38c_camera_preview_delete`
  (`preview_wanted_until`, `deleted_at`, `deleted_by`, the name unique among cameras in use, a
  check and a trigger keeping a deletion final).
- **Built:** the live view (a demand-driven second ffmpeg per camera in the camera process,
  frames on the new `camera-preview` volume, `GET /v1/packing/cameras/:id/preview`, the Pack
  screen's view with a Live badge before and during packing, the source chosen before an order
  is opened); deleting a camera (`DELETE /v1/packing/cameras/:id`, the settings' Delete with a
  confirmation, refused while it records, past videos playing); route matrix and fixtures,
  OpenAPI, API client; bn and en; training guide, architecture §31, runbook, plan status.
- **Evidence:** domain 37/37; preview, recorder and config units 20/20; `camera.e2e.test.ts`
  22/22 on real Postgres; console `pack-live-preview` 3/3, `pack-station-ui` 20/20; touched
  suites together 359 passed, 1 skipped; build, lint, format, routes (519), i18n, migrations,
  schema, api-client, white-label, bundle (249.9 KB): PASS. Not run: a stack spec (as asked),
  the preview against the image's real ffmpeg (to check on the server after deploy).
- New dependencies: none.

## 2026-10-10 · M38c · the live view's ledger audit fixed (not deployed)

- **Ledger audit** of b672730..79de53f: 0 critical, 3 warnings, 4 notes, fixed on
  `m38c-preview-fixes` (from `integration-wave2` at 79de53f); no migration. W1 a delete takes
  the camera's lock and then its open packings' before reading whether it records, and choosing
  a camera reads it with a shared lock before the session's (camera then session everywhere), so
  a delete and a first accepted scan never both win; W2 no live frame answers 204 (no error, no
  log), the console asks every 3 s while none comes and every 400 ms while frames do; W3 every
  private input list is removed at start, when a preview's ffmpeg cannot start and when a camera
  is deleted (with its frame), the preview directory emptied at start; N1 the frame read through
  one descriptor opened without following links; N3 the delete's audit names the packings that
  fell back; N4 a refused host stops a preview with `address_refused`, a stop during the host
  check starts nothing. N2 (any packing role may watch any camera) kept, noted in D-683.
- **Evidence:** `camera.e2e.test.ts` 24/24 on real Postgres (2 new: the delete-versus-first-scan
  race over six rounds, a deleted camera's lists and frame cleared); preview units 8/8 (1 skipped
  on Windows: a symbolic link needs rights); console `pack-live-preview` 3/3 (204 and the
  back-off); camera suites, `pack-station.e2e`, the route matrix, domain and console orders
  together 147 passed, 2 skipped; lint (28 tasks), format, typecheck, routes (519), i18n,
  api-client (regenerated): PASS. Decisions D-683 and D-684 reworded.

## 2026-10-10 · trust · removing a super admin, and stepping down (not merged or deployed)

- **Asked for:** a way to remove a super admin (D-667's open item). Branch `superadmin-removal`
  from `integration-wave2` (79de53f). Decisions D-685 to D-689, all ASSUMED for the owner to
  change. Migrations `0138_super_admin_removal_votes_schema` (the votes table) and
  `0139_super_admin_removal_policies` (RLS ENABLE and FORCE, the standard policy, SELECT,
  INSERT and DELETE for erp_app, the votes' guard trigger, `iam.demote_super_admin`, and
  0015's flag guard now refusing a plain clear by the application role).
- **Built:** `removalRefusal`, `stepDownRefusal` and `removalTally` in `@elysium/domain/iam`;
  `POST /v1/users/me/step-down`, `POST` and `DELETE /v1/users/:id/super-admin-removal`
  (route matrix and fixtures, OpenAPI catalog, API client regenerated, two error codes
  `SUPER_ADMIN_NOT_REMOVABLE` and `SUPER_ADMIN_LAST`); `superAdminRemoval` on the Staff rows;
  the Staff screen's Step down, Remove super admin / Vote to remove and Withdraw removal, each
  behind a confirmation, bn and en in the trust section; the removed person's sessions end, an
  admin role stays; every step audited (`iam.super_admin_removal_*`). Architecture §6, the org
  admin guide's "Super admins", build status.
- **Evidence:** domain `super-admin-removal.test.ts` 10/10 (fast-check) with
  `super-admin.test.ts` (19 together); `super-admin-removal.e2e.test.ts` 7/7 on real Postgres
  (refused for a non-super admin; four forged refusals as erp_app: a non-super admin calling
  the function, a super admin without the others' votes, a second super admin writing the
  first vote, a plain UPDATE of the flag; a non-first cannot start or remove the first; with
  three the first starts, the target cannot withdraw, another withdraws, every other votes;
  with two the first removes the second at once, the admin role stays, the old session is
  401, signed in again they cannot promote or remove; the last cannot step down; the first
  steps down, the next earliest becomes the first and an open removal of them is cleared; audit
  rows); with `super-admin`, `trust`,
  `users`, `bootstrap` and `tenancy` 133/133; `route-matrix` and `owner-link` 12/12; i18n,
  contracts and console users units 160/160. Typecheck (14 tasks), eslint and prettier on the
  touched files, check:routes (522), check:i18n, check:api-client, check:migrations,
  check:schema (138): PASS. Not run: full `pnpm verify`, a console stack spec or a look at the
  screen in a browser. The ledger-auditor found no blocker; its nit on old votes counting again
  is fixed (a removed super admin's nomination and removal votes go, e2e checked), and its
  should-fix on how "the first" is ordered is recorded as OPEN in D-689.
- New dependencies: none.

## 2026-10-11 · wave 3 · super admin removal live; the mother ERP live at elyerp.enfinito.cloud

- **Super admin removal** (D-685 to D-689, migrations 0138, 0139): verify green (3935 tests,
  every gate; rerun with 2 workers after the PC ran short of memory), deployed to both brands
  once the server came back from an outage (SSH and the sites timed out for a while; nothing
  had been changed).
- **The mother ERP at `https://elyerp.enfinito.cloud`**, on the brands server itself (the owner,
  D-690), replacing the old preview there (its stack stopped, its data volumes kept, its nginx
  site switched off). New `mother brands add` CLI (the read password from the environment,
  never a command line or output; audited as `system:operator`; `http.db.test.ts` 23/23).
  Set up by script: `new-env.sh`, the `mother-tunnel` account (no shell, `from=` the Docker and
  LAN ranges, `permitopen` 127.0.0.1:5541 and 5542, an sshd `Match` block, `sshd -t` first),
  the brands' `BRAND_REPORTING_DB_PORT` 5541 (Elysiam) and 5542 (Beownz), the mother deploy,
  certbot, the first owner (the owner's address, a one-time link), both brands registered and
  their `OWNER_LINK_PUBLIC_KEY` set, the brands redeployed. The first scheduled pull read both
  brands (Elysiam 12 days, Beownz 10 days). Lesson: `docker compose run` in a script piped to
  `bash -s` swallows the rest of the script unless its stdin is `/dev/null`.
- **Disk:** old `erp-server` images (about 2 GB each, one per deploy) had filled the server to
  42 GB free; removed all but the last two and old build cache (61 GB free), and
  `infra/brand/server-deploy.sh` now keeps only the last two images and prunes build cache
  older than 72 hours on every deploy.

## 2026-10-11 · M40 (mother) · brands on the server only; My account (not merged or deployed)

- **Asked for** (the owner, 2026-10-11): "for mother erp there might not be the option to add
  brands, that will be fixed as we do manually" and "we need better account management, two
  factor management, user friendly and more options". Branch `m40-mother-accounts` from
  `integration-wave2` (75dbe8e2). Decisions D-700 to D-705. Plan
  `docs/plans/M40-mother-accounts.md`.
- **Brands, server only (D-700):** `POST /v1/brands` and `POST /v1/brands/:id/owner-link-key`
  removed (404), the brand update's body strict (`readConnection` is a 400). CLI `brands list`,
  `set-connection` (`MOTHER_BRAND_READ_URL`, printed and audited only as its fingerprint,
  `brand.connection_changed`), `rotate-key` (prints only the `OWNER_LINK_PUBLIC_KEY=` line) and
  `test`; `add` and `set-connection` test the connection at once; `pnpm mother:brands …`. The
  Brands screen says in plain words that the operator adds, re-points and re-keys brands on
  the server, and keeps rename, staff console address, "read this brand", Test connection and
  the reads.
- **My account (D-701 to D-705):** `/account` (the header's name, Settings → My account) and
  `/v1/account`: name; password; two-step sign-in shown as required and never offered off,
  moved to a new phone in two steps (the new key waits 10 minutes bound to this session; the
  old phone works until the new one's first code; the other devices can be signed out with
  it); new recovery codes shown once with copy, download and print, closed only once "saved";
  devices (browser and system from the user agent, address masked, signed in, last active,
  this device marked; sign out one or all others). The password change, the new phone and new
  codes all ask for the password and a code held now (the app's, or a recovery code). Every
  change audited (`account.*`); each check runs under the person's lock, and five wrong
  answers in fifteen minutes refuse the checks (429). Better Auth's own account routes closed
  (`/two-factor/disable`, `/two-factor/get-totp-uri`, `/change-password`, the session routes,
  …) and its factor routes walled from an enrolled session. Migration
  `0002_session_last_active` (`auth.sessions.last_active_at`, touched at most once a minute).
  Pure `describeUserAgent` and `maskAddress` in `packages/mother-shared` (fast-check).
- **Ledger audit** (2 critical, 4 warnings, 7 notes), all fixed in cdc4be3e but one note: C1,
  recovery codes renewable with the password alone, which then passed as "a code held now"
  for a new phone; C2, Better Auth's `/two-factor/enable` and a signed-in `/verify-totp`
  answered password and code guesses round the lockout; W1, the lockout could be raced; W2,
  a percent-escaped account path skipped its limit; W3, a password change took the password
  alone; W4, the tests for those. N3 (audit a wrong code at confirm) left out: the caller
  already holds the new key.
- **Docs:** decisions D-700 to D-705, architecture §30, `docs/runbooks/mother-deploy.md` §5
  (add, re-point, re-key, list and test, with the commands) and §7, CLAUDE.md commands.
- **Evidence:** mother suites (`apps/mother-server/src`, `packages/mother-shared/src`,
  `apps/mother-console/src`, `scripts/mother-separation.test.mjs`) 162/162 in 13 files, among
  them `http.db.test.ts` 36/36 (the removed routes 404, the strict update, the CLI's list,
  re-point, re-key and test with no connection in any output or audit row, every My account
  action and refusal, Better Auth's routes 404 and its factor routes 404 for an enrolled
  session with nothing changed, twenty parallel wrong guesses giving exactly five answers),
  `rate-limit.test.ts`, and the console's `account.test.tsx` and `brands.test.tsx`. Typecheck
  and eslint (the three mother workspaces), prettier, check:i18n (both catalogues),
  check:migrations, check:schema: PASS. Not run: full `pnpm verify`, the mother stack spec (its
  tour now visits My account), a look at the screens in a browser.
- **Note:** the PC ran short of commit memory during the session (a browser tab held about
  11 GB) and Docker Desktop restarted twice; one early `http.db.test.ts` run failed nine tests
  before either was noticed, and every run since has passed.
- New dependencies: none (`@better-auth/utils`, already a dev dependency, is now a runtime
  one: the server checks TOTP codes itself).

## 2026-10-11 · M40 · account and two-step sign-in management, brand side (not merged or deployed)

- **Asked for:** the owner, 2026-10-11: "we need better account management, two factor
  management, user friendly and more options fully. also turn on and off two factors, reset
  and other stuffs." Branch `m40-accounts` from `integration-wave2` (75dbe8e2), worktree
  `D:/Projects/elysium-erp-acct`. Plan `docs/plans/M40.md`. Decisions D-691 to D-699, D-706 and
  D-707 (D-700 to D-705 went to the mother ERP's builder): D-691, D-692, D-694, D-696 and D-697
  ASSUMED for the owner to change; D-707 OPEN, the audit's leftovers. Migrations
  `0140_m40_two_factor_enabled_at` (a nullable column) and
  `0141_m40_two_factor_enabled_at_stamp` (its BEFORE trigger); the policy itself needs no
  migration (`org.settings`).
- **Built:** each brand's two-step policy (`security.two_factor` in `org.settings`; default
  org_admin, accounts, investor; super admins always) decided by `twoFactorRequirementFor` in
  `@elysium/domain/iam` and read by one function, `twoFactorStanding` in `packages/db/src/auth`,
  which the enrolment wall, the scanner sign-in and device check, the Staff list and My account
  use. Better Auth's password-only `/two-factor/disable`, `/get-totp-uri` and
  `/generate-backup-codes` HTTP paths closed, and its verify endpoints refused to a session whose
  factor is already on. Routes: `GET /v1/account`, `PATCH /v1/account/profile`,
  `GET /v1/account/sessions`, `DELETE /v1/account/sessions/:id`,
  `POST /v1/account/sessions/sign-out-others`, `POST /v1/account/two-factor/replace` and
  `/replace/confirm`, `POST /v1/account/two-factor/recovery-codes`,
  `POST /v1/account/two-factor/turn-off`, `GET` and `PUT /v1/security/two-factor-policy` (new
  subject `SecurityPolicy`, super admins only), `POST /v1/users/:id/sign-out-everywhere`,
  `POST /v1/users/:id/two-factor/turn-off`; route-matrix and cost-sweep fixtures, OpenAPI
  catalog, API client regenerated, per-address and per-session rate limits, eight error codes.
  Console: My account (`/account`, lazy, from the account menu: profile, password with "sign out
  my other devices", two-step set up / new phone / new recovery codes / turn off with the reason
  when it is disabled, devices), Settings → Security, the Staff screen's Required/Optional note,
  Sign out everywhere and Turn off two-step, a walled session opening on the set-up screen, the
  QR code drawn locally (`uqr`) on new `--scan-surface` / `--scan-ink` tokens; bn + en in a new
  `account` section. Architecture §6, the org admin guide, the README's "Your account" and a
  pointer from each staff guide, CLAUDE.md's stack line.
- **Audit:** the ledger-auditor found one blocker (C1: Better Auth's password-only paths let a
  stolen session and a password mint recovery codes or read the secret, then move or turn off
  the factor; and session-mode verify endpoints counted no failures) and six should-fixes (W2 an
  other-brand oracle in Staff turn-off, W3 no per-person bucket on password checks, W4 a
  malformed policy row failing open, W5 the brand-only sign-out returning in one click, W6
  missing tests, W7 a waiting new-phone secret surviving a reset): all fixed and tested. Its
  nits: the code check is now one transaction that restarts the count after a lock ends, the
  factor routes never replay, the owner has their own refusal, `requiresTwoFactor` needs the
  policy; the rest are D-707 (OPEN).
- **Evidence:** on Testcontainers Postgres, 40 files and 598 tests: `account.e2e.test.ts` 14 and
  `security-policy.e2e.test.ts` 15 (old password refused after a change, other sessions ended
  or kept; a new phone needs the password and the authenticator's code, the old phone works
  until the new code confirms, then only the new one; a recovery code refused there and not used
  up; the closed paths 404 and the session-mode verify 403; new recovery codes need a code and
  void the old; turn off allowed for warehouse, refused for org_admin and a super admin; ten
  wrong codes lock sign-in too; devices listed masked, one and all others ended, another
  person's session unreachable; the setting is a super admin's alone, walls a sales person at
  their next request and lets them in when switched off with nobody's factor removed, never
  reaches another brand's role, reads a hand-edited unknown role as the default; the reader
  refuses the wrong context; the `enabled_at` stamp; the scanner sign-in and a paired phone
  follow the setting; Staff sign-out everywhere and turn off with their refusals, 404 for
  another brand's person and D-404's second admin), every iam suite, `identity`, the platform
  auth/http/openapi/audit suites (route matrix, cost sweep, the new session-bucket units),
  `packing.e2e`, contracts and domain iam (`two-factor-policy`, `devices`, fast-check). Console
  units: the account logic (11) and page (8) tests with users, settings and i18n, 74/74; the
  stubbed Playwright login and smoke specs 13/13. `account.stack.ts` (new): the account page,
  renaming and setting up two-step sign-in passed in a real browser with axe clean in both themes
  (`docs/review/M40/`); turning it off and changing the password there were not run (below).
  Typecheck (28 tasks), eslint and prettier on the touched files, check:routes (535),
  check:i18n, check:api-client, check:migrations, check:schema (140), check:bundle (249.7 KB of
  250 after the set-up screens moved to their own chunk), check:white-label: PASS. Not run: the
  full `pnpm verify`.
- **Found and not fixed (needs the owner or the coordinator):** this worktree had no
  `packages/db/.env` until mid-session, so the test harness's runs against the shared dev
  Postgres (`TEST_DATABASE_URL`) set the cluster's `erp_app`, `erp_owner` and `erp_analytics`
  passwords to the harness fallbacks (`harness_*_password`); the dev stack's own `.env` passwords
  no longer match until they are set back (`ALTER ROLE … PASSWORD` with the values in
  `packages/db/.env`). Changing them was not permitted from here, which also stopped the rest of
  `account.stack.ts`; later runs used Testcontainers. Docker Desktop's port forwarding also
  wedged mid-session and was restarted.
- New dependencies: none new to the repo. `@elysium/db` gains `@elysium/domain` and runtime
  `@better-auth/utils` (D-706); the console gains `uqr` (catalog, zero dependencies) for the QR
  code.

## 2026-10-12 · M43 · premium order documents, English only (not merged or deployed)

- **Asked for:** the owner, 2026-10-11: "our order slip is not good design it must be advanced
  premium clean and effective like important details clear and bold and little big, like how
  standard company do. also we never wanted bangla language support, specially in invoices
  definitely not. everything will be handled in formal english language and clean premium design
  like modern big giant companies." Branch `m43-english-documents` from `integration-wave2`
  (02b3571a), worktree `D:/Projects/elysium-erp-m43`. Plan `docs/plans/M43.md`. Decisions D-750
  (RESOLVED, the owner's; supersedes D-036) to D-756. No migration (D-755: dropping
  `notify.templates.body_bn` and flipping the `locale` defaults waits until M41 and M42 have
  merged, so three branches do not each claim the next migration number).
- **Built:** `orders/order-documents.ts` (pure) redraws the invoice (A4), packing slip (A4, or A5
  with `?paper=a5`, refused for the other kinds) and parcel label (4 × 6 in): the order number
  large with a Code 128 barcode of exactly that number (what the packing station looks a code up
  by first), the cash to collect in a black-banded box, the recipient's name, full phone and
  address large and bold with thana and district from `name_en`, the courier with consignment and
  tracking (booked parcel, else the chosen courier), order date, channel, notes, the items with
  SKU, size and colour (new `CatalogApi.variantParts`) and on the invoice unit price, amount and
  subtotal, discount, delivery, total, paid, to collect; the brand's name, legal block and logo
  (the brand block's `logoFileId`, else the website's via a registry the storefront fills, bytes
  through new `FilesApi.publicImage` after the transaction; none prints the name alone). Inter
  only (`fonts.ts`; no Hind Siliguri uploaded), tabular figures on amounts, 1 px rules, black ink.
  Paper exact to Chromium's 1/75-inch print grid (A4 595.92 × 841.92 pt, A5 420 × 595.92, label
  288 × 432; the old A4 was 842.88 pt tall). Courier labels, the QR label sheet, stickers
  (`Tk 1,490`), payslips (now exact A4) and the till receipt in the same English style; money on
  paper and in messages is `Tk 1,250.00` through `takaText` (D-751; `formatMoneyText` in i18n
  for the till). The console prints packing slips (A4 and A5) from the order list and detail.
  M04's Bangla sample invoice is retired. English everywhere: `LOCALES = ['en']`, `bn.ts` and
  every `sections/*.bn.ts` deleted (and the owner console's `bn.ts`), `CUSTOMER_LOCALE`,
  `fontClassFor` and `localiseDigits` gone; no language switch in the console, palette, till,
  investor portal, tracking page or owner console; SMS renders `body_en` only, stores `en`,
  refuses a Bangla template; the template editor has one English body; emails have one English
  copy; storefront defaults `en`; `statusLabel` keeps `{ en, bn }` with English in both for the
  website; zones and areas shown in English, a zone's Bangla name optional; the training org's
  demo names and the preview's SMS templates English. `check-i18n.mjs` fails on any catalogue but
  `en` and on Bangla text in a value (the taka sign allowed on staff screens, D-751).
- **Evidence:** `order-documents.test.ts` (20: large and bold by the page's own type scale and
  weights, every field present, no Bengali-block character in any kind, the barcode decoded from
  the printed bars equals the order number and survives `normaliseScannedCode`, whole-module
  widths, totals add up, escaping, a buyer's own Bangla printed as typed); `documents-review.test.ts`
  against Gotenberg 8.37 (nine documents: page count and every `/MediaBox` within a point of the
  paper, Inter embedded, no Bangla, PNGs written); `pack-station.e2e.test.ts` opens the order at
  the real station with the code decoded from the slip (A4, A5) and the label; `notify.db.test.ts`
  (English body sent and stored as `en` though the template holds a Bangla `body_bn`; a Bangla
  template refused; no `bodyBn` in the list); domain email, money (`takaText` never writes the
  Bengali block and round-trips through `parseTaka`, fast-check) and text tests; the till's
  Playwright receipt spec (English, `Tk 1,500.00`, no Bengali-block character, one page);
  `check-i18n.test.mjs` (11). Server suites on Testcontainers: notify, orders e2e, pack-station,
  storefront buying, crm, loan reminders, hr e2e, deletes, migration, catalog, stickers, courier
  M15, desk, packing, openapi, module boundaries, route matrix: 19 files, 354 tests. Front-end,
  package and script units: 146 files, 2,156 tests. `pnpm verify` (under the heavy lock, `VITEST_MAX_WORKERS=2`): exit 0 — format, lint,
  typecheck (28 tasks), 274 test files / 4,094 tests passed (3 skipped, as before), build,
  check:bundle 249.0 KB of 250, check:white-label, check:migrations (no new migration),
  check:schema (140), check:routes (535), check:i18n (English only, 4,483 and 438 keys),
  check:api-client. Also: the till's Playwright spec 5/5, the console's stubbed specs 13/13,
  `shell-quality.stack.ts` 7/7 (no language button, `lang=en`, no Bangla on the page, axe
  clean both themes) and `crm.stack.ts` 4/4 (one English template body).
- **Audit:** the acceptance-auditor passed checks 1 to 3 and named three gaps, all closed: the
  progress entry, the verify result, and a document rendered from a real order (now
  `orders.e2e.test.ts` gathers one through the service with the seeded geography, Bangla
  names beside English, and finds no Bangla in any kind). Its other notes: a template stored
  in Bangla is now refused at send as well as at save; `check-white-label.mjs` still expected
  `bn.ts` (fixed); `shell-quality.stack.ts` check 1 had matched three cells since M39b's
  product list (now exact). The ledger-auditor was not run: the diff moves no money, stock,
  tenancy or permission (documents read inside the same scope as before; the logo read is
  one brand's public website image).
- **Screenshots** (`docs/review/M43/`): `invoice-a4.png`, `packing-slip-a4.png`,
  `packing-slip-a5.png`, `packing-slips-batch-a5.png`, `parcel-label-4x6.png`,
  `courier-label-4x6.png`, `qr-label-sheet-4x6.png`, `payslip-a4.png`, `sticker-38x25.png`,
  `till-receipt-80mm.png`; the console without its language button in `docs/review/M05/`
  (`*-en.png` retaken, the `*-bn.png` removed).
- **For the coordinator:** M41 and M42 add `bn` strings; on merge, delete the `bn` side (the
  i18n check refuses any `bn` file or Bangla value) and drop `locale` from new `notify.queue`
  calls. A follow-up migration drops `notify.templates.body_bn` and sets the four `locale`
  defaults to `en` (D-755). Staff screens still show `৳` through `<Money>` (D-751): switching
  them to `Tk` is the owner's call.

## 2026-10-12 · M42 · the unified inbox and customer panel (not merged or deployed)

- **Asked for:** the owner's brief of 2026-10-11: Messenger, Instagram and WhatsApp in one inbox in
  the brand's ERP, conversations owned like orders, and a customer panel beside the thread. Branch
  `m42-inbox` from `integration-wave2` (02b3571a), worktree `D:/Projects/elysium-erp-m42`. Plan
  `docs/plans/M42.md`. Decisions D-730 to D-747 (D-730 brings D-290's inbox back as a native module;
  D-747 OPEN, the owner's Meta set-up). Migrations `0142_m42_inbox_schema` (generated) and
  `0143_m42_inbox_policies` (RLS, grants, two update triggers); renumber at integration.
- **Built:** `@elysium/domain/inbox` (phones in a chat, the 24-hour window, stages, delivery
  status, property-tested); schema `inbox` (settings, channels, contacts, identities,
  conversations, messages, notes, interests, webhook_events; RLS ENABLE and FORCE, composite FKs);
  addresses found in a chat matched to the geography; the `inbox` module:
  `GET`/`POST /webhooks/meta/<org id>` (subscription check, raw body,
  `X-Hub-Signature-256` over the bytes and Meta's escaped-unicode form, stored then threaded by
  `inbox.process_webhook`), the Graph adapter for the Messenger Send API, the Messenger API for
  Instagram and the WhatsApp Cloud API (UNVERIFIED, fake by default, two keys to switch on), the
  send job `inbox.send_message`, 23 routes under `/v1/inbox` (`Conversation`,
  `ConversationAssignment`, `InboxChannel`), ownership with `x-acknowledge-owner: 1`
  (`INBOX_OWNER_ACK_REQUIRED`), the customer panel through `OrdersApi` (`customerPanel`,
  `customerReachable`, `inboxOrigin`, `deskAvailability`, new) and `CatalogApi.productSummaries`
  (new), the `order.created` listener (Customer stage), the auto-offer port for M41, four realtime
  events, nine error codes, OpenAPI entries and the API client. Console: `/inbox` (list, thread,
  panel), Settings → Inbox, the order desk from a chat (`/orders/new?conversation=`) and its fraud
  warning; strings in a new `inbox` section (bn a copy of en). nginx template forwards `/webhooks/`.
- **Audit:** ledger-auditor 0 critical, 3 warnings, all fixed and tested: W1 the panel listed every
  order of any buyer whose phone was typed (now the buyer profile's rule: brand-wide counters,
  orders in the viewer's `read Order` scope, a typed phone linked only for a reachable buyer or one
  the customer gave in the chat); W2 take-over-then-hand-on bypassed `ConversationAssignment` (now
  any change of someone else's ownership is a supervisor's); W3 any order taker could name a
  conversation and relink its contact (now only an inbox role names one, the listener never
  relinks and audits). Nits fixed: secrets fail closed, readable fingerprints in the audit,
  explicit conflict targets; webhook-body retention and a webhook rate limit are follow-ups (D-744).
- **Evidence:** `pnpm verify` exit 0 (1,060 s; 276 files, 4,128 passed, 3 skipped, none new). On
  Testcontainers Postgres:
  `inbox.e2e.test.ts` 19 tests (each channel's signed webhook opens or threads a conversation, a
  bad signature or another brand's address is a 401 that stores nothing, the same body and the
  same message id are ignored; replies sent by the real worker job through the real Graph adapter
  to a stand-in for Meta, with the Send API and Cloud API bodies, delivery and read receipts and
  WhatsApp statuses moving them forward only; free text outside the window refused at the route
  with `window_expired` and in the job without calling Meta; Meta's 4xx kept as `meta:190`; two
  people taking at once, one 409 naming the owner; a non-owner's note refused without the header
  and with it audited (`acknowledgedOwner`) and the owner told in their room; take-over and
  release refused to sales, hand-over to a supervisor only; the phone and address found in a
  chat, the matched buyer's counters and orders, Customer on an order from the chat through the
  worker's `order.created` subscription, Fraud sticky and on the desk, typed phones unlinked for
  an unreachable buyer, orders listed in the viewer's scope; notes, interests with live price,
  stock and photo and no cost; another brand sees nothing), `inbox.unit.test.ts` 19 (fixtures
  from Meta's examples, signature with the escaped-unicode form, the Graph adapter against a
  local HTTP server), domain 20 (fast-check: phones, window, stages, status order, addresses),
  console logic 6; the route matrix and cost sweep (560 routes); `catalog-deletes` (the inbox
  answers the catalog's references port). `inbox.stack.ts` 6/6 against the real API, worker and
  console with axe clean in both themes, screenshots in `docs/review/M42/`. check:routes 560,
  check:bundle 249,973 of 250,000 bytes (the inbox's height rule moved onto the panes with a class
  the data table already ships), check:i18n, check:schema (142 migrations), check:white-label,
  check:api-client: PASS.
- **Needs a person:** the live brand nginx sites need `webhooks` added to the API location regex by
  hand (`infra/brand/nginx-brand.conf`); the owner's Meta app, permissions and webhook
  subscriptions (D-747). The console's first download is 27 bytes under its 250 KB budget: M41's and
  M43's console changes must be measured together at integration.
- Follow-ups: bind M41's auto-offer engine to `CONVERSATION_OFFER` and filter the hand-over list
  by M41's work types (D-737); a retention sweep for webhook bodies whose job dead-lettered and a
  Valkey rate limit on the webhook (D-744); WhatsApp media download and templates, Meta's human
  agent tag, merging two contacts, feeding `marketing.leads` from chats (D-734, D-738, D-744).
- New dependencies: none.

## 2026-10-11 · M41 · order workflow, ownership and auto-assignment (not merged or deployed)

- **Asked for:** the owner's brief of 2026-10-11: the sales desk and the fulfilment hub work
  2 km apart; one person handles each order; whoever else touches it is warned at every step;
  new orders are offered evenly to the people active in the ERP and accepted like a ride offer.
  Branch `m41-order-workflow` from `integration-wave2` (02b3571a), worktree
  `D:/Projects/elysium-erp-m41`. Plan `docs/plans/M41.md`. Decisions D-710 to D-724 (D-712,
  D-714, D-715 and D-720 ASSUMED; D-724 OPEN, the owner's questions). Migrations
  `0142_m41_order_workflow_schema` and `0143_m41_order_workflow_policies` (renumbered at
  integration; M42 and M43 build in parallel).
- **Built:**
  - The owner's gate (`OwnershipGate`): one check behind every desk write, the header
    `x-acknowledge-owner`, `ORDER_HANDLED_BY_OTHER`, the audit row `order.acted_over_owner`,
    and the owner's room told.
  - Taking an order, where the loser of a race is told who won; release, hand over and a
    supervisor's reassign (`assignmentDecision`); the person named must be able to hold the
    order (`canHoldOrder`), on create as on assign.
  - Verification calls in `sales.call_attempts` (append-only) with the order's summary; due
    call-backs come first.
  - Presence in `team.presence`: a 30-second heartbeat; active, idle or away; "Not taking
    orders"; only changes are audited, through the named `auditNothingChanged`.
  - Desk profiles in `team.desk_profiles` (a new `team` module with `TeamApi`); a hub location
    counts as a location's use.
  - Auto-assign: the pure `pickAssignee` (generic, for M42's conversations); `sales.order_offers`;
    a one-statement accept; dispatch, expiry and minute-sweep jobs; outbox subscribers. Off by
    default under Settings → Order workflow.
  - The desk's and the hub's queues on `GET /v1/orders`, `mark-printed`, and the team board.
  - Subjects `Presence` (own) and `OrderWorkflow`; five events; route matrix, cost sweep,
    OpenAPI catalog and api-client; CORS allows the header.
  - Console:
    - the lazy work dock: heartbeat, offer card with a countdown, owner notices;
    - the order page's ownership banner, and a "go ahead?" before every desk action on
      somebody else's order;
    - the calls panel and the hub stage;
    - the sales desk's five tabs, with the status switch;
    - `/orders/hub` (print, pack, scan to hand over) and `/orders/team`;
    - Settings → Order workflow, and the Staff dialog's desk profile.
  - Strings in a new `workflow` section, in English in both locale files until M43. The
    invite/reset password screen became its own chunk, keeping the first download at 249.7 KB.
- **Audit:** the ledger-auditor found 0 critical and 3 warnings, all fixed and tested:
  - W1, deadlocks between expiries, the sweep and dispatchers (reproduced). Expiries and
    declines now enqueue the next dispatch; the sweep lapses one offer per transaction; a
    dispatcher counts every unanswered offer as busy; a concurrent test was added.
  - W2, creating an order for a colleague bypassed D-712.
  - W3, an order could be handed to a branch manager who cannot reach it.
  - Notes also acted on: offers are withdrawn whenever an order leaves `pending`, on any path;
    only orders with desk work left can be taken; a reseller sees no call notes; overdue
    offers are read per order; printed slips are locked in id order; and a call or a print
    emits no `order.edited` (which would have resent ncom.bd orders).
- **Evidence:**
  - `pnpm verify` exit 0: 275 files, 4105 tests, every check PASS
    (`D:/Projects/erp-tools/verify-m41-4.log`, on 3b739122, after every fix).
  - `workflow.e2e.test.ts` (14 tests): checks 1 to 5, the gate on every desk act, the
    assignment rules, the expiry and sweep concurrency, presence audit and desk profiles.
  - The domain's property tests (`assignment.test.ts`, `ownership.test.ts`).
  - Route matrix, cost sweep, tenancy guard, module boundaries and catalog deletes.
  - `order-workflow.stack.ts`: 6 of 6 in a real browser, axe clean in both themes, 30
    screenshots in `docs/review/M41/`; run with the touched specs (`advances`, `order-desk`,
    `order-lifecycle`, `packing`): 21 of 21 (`D:/Projects/erp-tools/stack-m41-5.log`). The
    stubbed `pnpm e2e`: 13 of 13.
  - The acceptance auditor's gaps closed: an expiry now provably moves the order to the next
    person (a busier agent who had not passed on it), the touched stack specs re-run, and the
    progress entry and plan status written.
- **New dependencies:** none.
- **Follow-ups (owner: human, D-724):**
  - Switch auto-assign on per brand.
  - Decide whether the packing station should warn a second packer.
  - Decide whether sales agents should see colleagues' orders read-only.
  - Decide whether to narrow the team board to a branch manager's branches.
- **Follow-up (claude):** M42 reuses `pickAssignee`, `TeamApi` and presence for conversations.

## 2026-10-12 · integration wave 2 · M41 merged onto M42 and M43 (not merged to main or deployed)

- **Merge:** `m41-order-workflow` into `integration-wave2`, keeping both sides. M41's strings
  are English only (`workflow.en.ts`, `registerSection({ en })`); its Bangla sections are gone.
  The permission matrix, subjects, spec-6 fixture, events, usage reasons, queues, CORS (one
  `x-acknowledge-owner` header for orders and conversations), the stack spec's people and the
  route fixtures carry both milestones. M42's migrations stay 0142 and 0143; M41's became
  `0144_m41_order_workflow_schema` (regenerated by drizzle-kit: the same SQL as M41's own) and
  `0145_m41_order_workflow_policies` (M41's hand-written RLS, grants and triggers, unchanged).
  The typed client was regenerated. The order desk's `areaLabel(matched, locale)` call left by
  the M42 and M43 merge (a console type error) now takes the one argument.
- **Evidence:** server build, `pnpm api:client`, `check:routes` (575 routes, PASS), every
  package's typecheck, lint of the touched packages, `check:migrations`, `check:schema`,
  `check-i18n`, and the contracts, domain assignment, i18n, CORS, module-boundaries and
  console workflow unit tests. The full verify and the stack specs are the integrator's.
- **Follow-up a, colleagues' orders (D-725, the owner's answer to D-724 (3)):** a sales agent
  opens any order of the brand under "Handled by …" (`read Order` at `org`); every desk act on a
  colleague's order answers with the owner's gate (409 `ORDER_HANDLED_BY_OTHER`, then through
  with the acknowledgement and the owner told), a hand-over with 403, and the hub's moves stay
  theirs alone (not offered, 404). The desk's and the hub's queues list the orders the caller
  works on; Orders → List with "Every agent" is the all-orders view. Buyers stay "customers of
  own orders", and the website's online-payments list now asks org-wide `read Customer` so its
  audience is unchanged. No cost field on any of it. Tests: the contracts' permission suite,
  `workflow`, `orders`, `desk`, `inbox`, `pack-station`, `packing` and `buying` e2e, all green.
- **Follow-up c, D-755's migration (D-757):** `0146_m43_english_defaults` sets the four `locale`
  defaults to `en` and drops `notify.templates.body_bn` (only ever a copy of `body_en` since
  D-750); the repository, the SQL fixtures and the tests no longer name it, and a new
  `notify.db.test.ts` case reads the columns back. `check:schema` PASS; `notify`, `crm`,
  `loans-reminders` and `migration` db tests green.
- **New dependencies:** none.
