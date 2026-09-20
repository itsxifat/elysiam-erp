---
name: milestone
description: Runs one Elysium ERP milestone from docs/milestones.md end to end. Covers loading context, planning, building with tests, verifying against the acceptance checks, updating the docs and committing. Use whenever the user types /milestone <ID>, or asks to start, resume or finish a milestone or "the next milestone".
argument-hint: '[milestone-id, e.g. M07]'
---

# Milestone $ARGUMENTS

Work only on milestone $ARGUMENTS.

If no ID was given:

1. Read docs/progress.md.
2. Pick the first milestone in docs/milestones.md whose dependencies are all done.
3. Ask the user to confirm it before continuing.

This workflow exists so every session leaves the repo in a verified, documented state that the next session can trust. The steps below are ordered for that reason.

## 1. Load context

1. Run `git status --short` and `git log --oneline -10`. If the tree has uncommitted work that doesn't belong to $ARGUMENTS, stop and ask.
2. Read the last two entries in docs/progress.md.
3. Read the rest of the milestone's context:
   - the $ARGUMENTS section of docs/milestones.md
   - every docs/architecture.md section that milestone cites
   - the rows of docs/decisions.md it references or that mention $ARGUMENTS
4. If docs/plans/$ARGUMENTS.md already exists, this is a resume:
   - read the plan and `git log` for the milestone branch
   - continue from the first unfinished task
   - don't redo finished work
5. Study the code this milestone will touch. Use the Explore subagent for broad searches so this conversation stays focused.
6. If a dependency milestone isn't done, or one of its open follow-ups blocks this work, say so and stop.

## 2. Plan, then wait for approval

Write docs/plans/$ARGUMENTS.md. It must cover:

- the scope in your own words, including what is explicitly out of scope
- data model changes: tables, columns, RLS, grants, migrations
- domain functions, and which invariants get property or integration tests
- API endpoints, events and realtime payloads, and UI screens
- assumptions you'll make (as new decisions.md rows), and the main risks
- an ordered task list, with a verification step after each chunk

Show the user a short summary. Wait for approval or edits, and don't touch product code until you have it.

## 3. Build

- Create or switch to the branch `mNN-<slug>` (lower-case ID).
- Work in vertical slices, in this order:
  1. schema and migration
  2. domain logic with tests
  3. service and API, with tests
  4. UI
  5. e2e tests

  After each slice, run the relevant tests and fix any failures before moving on.

- Follow the CLAUDE.md invariants and the path rules in .claude/rules/. If a rule conflicts with the plan, the rule wins; note the change in the plan.
- If a credential is missing or a decision is OPEN:
  - implement the documented default behind configuration
  - update the decisions.md row
  - keep going
- Don't widen the scope. Record extra ideas as follow-ups.
- Commit at every green slice using Conventional Commits (`feat(mNN): …`, `test(mNN): …`).

## 4. Verify

1. Run `pnpm verify` and fix everything until it exits 0.
2. Run every acceptance check for $ARGUMENTS, plus `pnpm e2e` for any flows you touched.
3. If the diff touches any of these, run the `ledger-auditor` subagent on it and fix every CRITICAL finding:
   - ledger, inventory or tenancy
   - permissions
   - reseller payouts, investor money or payroll
4. Run the `acceptance-auditor` subagent with $ARGUMENTS and close the gaps it reports.
5. Print a Verification Report in this format. The user's /goal check reads it from this conversation, so every line must show real evidence.

```
VERIFICATION REPORT: $ARGUMENTS
pnpm verify ............... exit 0 (<duration>)
Check 1: <text> ........... PASS: <test file › test name, or command + key output>
Check 2: ...
e2e ....................... PASS: <specs>
ledger-auditor ............ 0 critical, <n> warnings (<summary>)   [or: n/a]
acceptance-auditor ........ READY
Skipped/unverified ........ <none | what and why>
```

## 5. Close out

- Add an entry to docs/progress.md using the template at the top of that file.
- Update docs/decisions.md with any new assumptions or unverified integrations.
- If the design changed, update docs/architecture.md and add a decision row.
- If the commands changed, update the Commands section of CLAUDE.md.
- Make the final commit.
- Tell the user:
  - the branch is ready to merge
  - what they should review by hand (the milestone's riskiest parts)
  - anything only they can do: credentials, client questions, manual QA
