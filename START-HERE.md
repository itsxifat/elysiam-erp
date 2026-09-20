# Elysium ERP × Claude Code: start here

This kit lets Claude Code build the ERP one milestone at a time, and each milestone proves itself with tests before you merge it.

Claude writes the code. You own four things it can't do:
- get decisions from the client
- create accounts and credentials
- review the code that handles money and security
- test with real people during the pilot

## What's in the kit
```
CLAUDE.md                          Always-loaded project memory: stack, invariants, workflow
docs/architecture.md               Engineering spec (source of truth), read section by section
docs/milestones.md                 33 session-sized milestones with acceptance checks
docs/decisions.md                  Resolved decisions, assumed defaults, open client questions
docs/progress.md                   Session log (Claude appends one entry per session)
docs/plans/                        Claude writes each milestone's plan here for your approval
docs/client-spec/                  The client's original Bangla spec (PDF)
.claude/skills/milestone/SKILL.md  /milestone <ID>: the per-session workflow
.claude/agents/ledger-auditor.md       Read-only reviewer for money, stock, tenancy, permissions
.claude/agents/acceptance-auditor.md   Read-only check that acceptance checks are really proven
.claude/rules/*.md                 Path-scoped rules; they load only when matching files are touched
```

## One-time setup
1. **Machine.** Use a development machine or a dedicated dev VM, not a server that runs production services. Don't give Claude Code production credentials.
2. **Install:** Node LTS, pnpm, Docker, git and Claude Code. Run `claude update`; Opus 5 needs Claude Code v2.1.219 or later.
3. **Repo.** Create an empty repo called `elysium-erp` and copy the kit's contents, including the hidden `.claude/` folder, into its root. Then:
   ```
   git add -A && git commit -m "chore: add Claude Code build kit"
   ```
4. **First launch.** Run `claude` in the repo, trust the folder, and run `/context`. CLAUDE.md should appear under Memory files.

## Model and effort
- **Default launch:**
  ```
  claude --model opus --effort xhigh
  ```
- **MAX milestones** (tenancy, ledger, stock, suppliers, accounts, orders, courier/COD, payroll, reseller, POS, investors, hardening; each is marked in milestones.md):
  ```
  claude --model opus --effort max
  ```
- Max applies only to that session. Anthropic's docs warn it can overthink, which is why the kit reserves it for the milestones where a mistake costs money.
- Keep auto mode (the default permission mode), so `/goal` can run turn after turn without waiting on you.

## Session 1: kickoff prompt (paste as-is)
```
You're the lead engineer on the Elysium Mother ERP. This repository holds only the build kit so far: CLAUDE.md, docs/, and .claude/ (a /milestone skill, two auditor subagents, path-scoped rules). We'll build the whole system milestone by milestone over many sessions. This first session is orientation, then M00.

1. Read CLAUDE.md, docs/architecture.md (in full, this once), docs/milestones.md, docs/decisions.md and docs/progress.md. Then open docs/client-spec/elysium-erp-module-spec.pdf (the client's original spec, in Bangla) and compare it with architecture §1. List anything the client asked for that the architecture or milestones miss, weaken or contradict.

2. Check the environment: node, pnpm, docker, docker compose, git, and your Claude Code version. Report versions and anything missing.

3. Critique the plan like a senior engineer who has shipped ERPs. Where would you push back? Which milestone looks too big or too small for one session? Which acceptance checks are weak or unverifiable?

4. Reply with a briefing of at most ~30 lines:
   - the 5 invariants you consider most dangerous to get wrong, in your own words
   - gaps or contradictions from step 1, each with a concrete fix (a decisions.md row or a milestone edit)
   - your critique from step 3
   - questions for me that block M00–M03 (real blockers only; everything else gets a documented default)

Don't write code yet. After I answer, apply the agreed doc changes in one commit ("docs: kickoff adjustments"), then run /milestone M00.
```

## Every later session: the loop
1. Merge the previous milestone and start clean:
   ```
   git checkout main && git pull
   ```
2. Launch Claude Code, using `--effort max` for MAX milestones:
   ```
   claude --model opus --effort xhigh
   ```
3. Start the milestone:
   ```
   /milestone M07
   ```
4. Read the plan in `docs/plans/M07.md`, answer Claude's questions, and reply `approved` (or give your edits).
5. Set a goal so Claude keeps going until the milestone is proven done. The goal checker reads only the conversation, which is why the skill makes Claude print a Verification Report.
   ```
   /goal Milestone M07 is complete: in this session every acceptance check for M07 in docs/milestones.md was run and shown as PASS in a Verification Report with evidence, `pnpm verify` exited 0, ledger-auditor reported 0 critical (or n/a), acceptance-auditor said READY, docs/progress.md has an M07 entry, and all work is committed on the m07 branch. Stop after 120 turns.
   ```
6. **Review before merging.** Read the Verification Report and the "review by hand" list, click through the UI for UI milestones, then merge.
7. **New milestone, new session.** Run `/clear` or exit. Fresh context per milestone keeps quality high.

## Parallel tracks (after M14b and the pilot start)
Track A (M15 → M16 → M17) and Track B (M18 → M19 → M20) touch different modules, so they can run side by side in separate git worktrees:
```
git worktree add ../erp-track-b -b track-b main
cd ../erp-track-b && pnpm i && claude --model opus --effort xhigh
```
Merge Track A first. Then rebase Track B onto main, run `pnpm verify`, and merge it. The same pattern works later:
- M21–M22 alongside M23
- M25–M26 alongside M27–M29

## Recovery prompts
- **Session ended mid-milestone** (context or usage limit):
  ```
  claude --continue
  ```
  then:
  ```
  /milestone M07
  ```
  The skill finds `docs/plans/M07.md` and the branch history and resumes without redoing finished work.
- **Tests red and Claude going in circles:** run `/goal clear`, then send:
  ```
  Stop. Summarize the failing tests, your root-cause hypothesis with evidence, and two ways forward with trade-offs. Don't change code yet.
  ```
- **Went the wrong way:** run `/rewind` to return to a checkpoint, or `git reset --hard <last good commit>` on the milestone branch.
- **Client changed a requirement:**
  ```
  Add decision D-0xx to docs/decisions.md: <the change>. List which merged milestones and which future milestone sections it affects, and propose edits to those sections. Don't touch code in this session.
  ```
- **Pilot fixes:**
  ```
  Fix session. Read the pilot follow-ups in docs/progress.md, triage them by severity, and propose a plan where every fix gets a regression test first. Wait for my approval.
  ```

## Gates only you can clear
| Gate | Before | Prepare |
|---|---|---|
| G0 | M00 | Dev machine, tools installed, empty repo, Claude Code updated |
| G1 | M12 | Primary courier API credentials (sandbox if offered) and 2–3 real settlement export files |
| G2 | M13 | The `fraudjs` package (path or npm name) and any courier access it needs |
| G3 | M14a / M14b | Staging and production infrastructure:<br>- managed Postgres (Singapore)<br>- 2 VMs<br>- a Cloudflare zone and R2 buckets<br>- Sentry<br>- a secrets manager<br><br>Real data exports:<br>- products<br>- counted stock with unit costs<br>- supplier dues<br>- wallet balances<br>- customer order history<br><br>Also:<br>- choose the pilot brand<br>- have the client's accountant review the chart of accounts |
| G4 | After M14b | Pilot: one brand live for 2–3 weeks; log issues as follow-ups |
| G5 | M15, M16 | Other couriers' credentials; an SMS gateway account (apply early for a branded sender ID) |
| G6 | M18 | Meta business verification, ad account access, system-user tokens, dataset/pixel IDs per brand |
| G7 | M19 | Payroll rules (components, deductions) and a sample export from the biometric attendance software |
| G8 | M21 | Client answers to D-015–D-018: reseller delivery charge, return fee, payout timing, slabs |
| G9 | M25 | Investor profit-share method (D-019) and sample agreements |
| G10 | M27 | A Chatwoot host on the same parent domain as the console; WhatsApp numbers; a TikTok business account and developer app; Telegram bots; a decision on "Google" (D-021) |
| G11 | M28 | A signed staff monitoring policy (D-022) and managed Chrome on office PCs |
| G12 | M29 | Landing page domains, hosting account, Turnstile keys |

Start the slow external items early. Meta business verification, WhatsApp numbers and SMS sender IDs can take weeks, so apply for them during Phase 1.

## Your review checklist
- **Money and stock milestones:**
  - read the posting-rule tests
  - verify one golden-books scenario by hand, once
- **Permission milestones:** log in as a Sales user and confirm no cost figure appears anywhere, including in network responses.
- **Integration milestones:** run one real sandbox transaction per provider.
- **Before go-live:**
  - the client's accountant signs off the opening balances
  - you have watched a restore drill succeed
