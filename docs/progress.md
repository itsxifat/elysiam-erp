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
