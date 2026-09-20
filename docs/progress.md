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

### 2026-09-20 · M00 · Repo bootstrap and toolchain · partial (Docker blocked)

- Delivered: a pnpm + Turborepo monorepo where `pnpm verify` is the single gate. Six apps and nine packages compile; the API answers `/health/live`, the worker logs `ready`, and all four front ends serve. `pnpm verify` runs format check, lint, typecheck, 78 tests, build and the migration-immutability check, and exits 0 in ~25 s.
- The design token foundation (D-033) landed here rather than in M05, so no screen in this repo's history was ever written against a hard-coded colour. OKLCH semantic roles in light and dark, per-org brand accent derived from a hue/chroma pair (D-034), 36 px rows, hairline borders, motion at 120–200 ms, and Inter + Hind Siliguri vendored with a computed `size-adjust: 108.1%` so mixed bn/en strings share one baseline.
- Verification: `pnpm verify` exit 0; acceptance checks 2–7 PASS with evidence in the Verification Report; check 1 is PASS except its `compose up` step, which is BLOCKED on Docker. e2e: 3 Playwright specs (mount and token paint, theme repaint, keyboard reachability).
- Auditors: ledger-auditor n/a (M00 touches no money, stock, tenancy or permission code); acceptance-auditor run, gaps closed.
- Decisions/assumptions: D-039 (TypeScript pinned to 6.0.3, not 7.x), D-040 (packages compiled via project references, tests aliased to source).
- New dependencies, with reasons: `concurrently` — the server dev script runs `tsc -b --watch` alongside two `node --watch` processes, and tsx/esbuild cannot emit the decorator metadata NestJS DI needs. `@eslint/js` — the flat-config base ruleset. `happy-dom` — the DOM environment for the Vitest `dom` project. Everything else is named in architecture §3.
- Deviations from the milestone spec: TypeScript is pinned to 6.0.3 rather than the latest stable 7.0.2 (D-039) — TypeScript 7 removed the classic compiler API, so type-aware linting would stop working. The token test also asserts WCAG contrast, slightly beyond check 5's wording, because the OKLCH values are M00's deliverable and picking them by eye would not be verifiable; it found three real failures in the first draft.
- Follow-ups:
  - Install Docker Desktop + WSL2 (owner: human). **Blocks M01 entirely** and the `compose up` step of M00 check 1.
  - Chart and dataviz tokens deliberately omitted; M24 picks them with the `dataviz` skill rather than inheriting unvalidated placeholders (owner: claude, M24).
  - A lint rule banning `toFixed` / `parseFloat` outside `packages/domain/src/money` (owner: claude, M03, once that module exists to scope it against).
  - Production sourcemaps are off in the Vite builds; M14b turns them back on wired to Sentry upload (owner: claude, M14b).
  - The three SPA placeholder pages are scaffolding; M05 replaces them with the real console shell (owner: claude, M05).
- Next: M01, once Docker is available.
