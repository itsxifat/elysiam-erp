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
