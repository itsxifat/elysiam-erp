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
