# How much of the ERP is built

Last updated: **2026-10-03** (M30 part 1 built: the security review and fixes, load test, accessibility pass, training guides and go-live checklist; part 2 waits for a staging server). This is the short, plain-language view. The
detail is in `progress.md` (session log), `plans/` (one file per milestone) and `decisions.md`.

## Overall

```
Built     [###################-]  98%
```

- The plan has 33 milestones. Six are out on the owner's instruction: the Beownz reseller
  platform (M21, M22), the fraud check (M13, and its code deleted), the Chatwoot inbox (M27), the
  staff activity extension (M28) and the landing page builder (M29). So **27 count**.
- A milestone counts 100% when it is built, tested and passed its audits. A part-built one counts
  for the share that is done.
- Today: **25 done, 2 part-built (M14b about 75%, M30 about 70%).** Both are waiting for a
  staging server.

"Built" does not mean "live". Before real use, the owner still has to supply the items under
[What the owner needs to do](#what-the-owner-needs-to-do).

## By business area

| Area                                                                        | Built | In plain words                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation: sign-in, roles, five separate brands, audit log                 |  100% | Staff sign in, see only their brand and only what their role allows. Every change is logged. An admin manages staff on a Staff screen: invite, roles, deactivate a leaver, reset a password or a lost phone, with a second admin for anyone who can move money.                                                                                 |
| Products and stock                                                          |  100% | Products, sizes, prices, stock per warehouse and showroom, cost tracking. Stock can never go below zero.                                                                                                                                                                                                                                        |
| Accounting and wallets                                                      |  100% | Cash, bKash and bank wallets, double-entry books, P&L, balance sheet, month close.                                                                                                                                                                                                                                                              |
| Orders                                                                      |  100% | Order desk for agents, website order intake, buyer list. Each order shows only its allowed next steps (confirm, pack, hand to courier, deliver, return, hold); courier updates move orders on by themselves; bulk pack.                                                                                                                         |
| Couriers and COD                                                            |  100% | Steadfast, Pathao, RedX booking, tracking page, COD cash matching, stuck-parcel list. Needs live accounts.                                                                                                                                                                                                                                      |
| Customers, SMS, promo codes                                                 |  100% | Buyer profiles, birthday offers, lapsed-buyer list, SMS templates, promo codes at the order desk.                                                                                                                                                                                                                                               |
| Showrooms (POS)                                                             |  100% | A till that works offline, Bangla receipts, day closing per branch.                                                                                                                                                                                                                                                                             |
| HR and payroll                                                              |  100% | Employees, attendance, salary, staff loans, Bangla payslips.                                                                                                                                                                                                                                                                                    |
| Investors                                                                   |  100% | Capital, profit share, withdrawals with approval. Investors sign in to their own pages with two-step login and see only their own money.                                                                                                                                                                                                        |
| Moving old data in                                                          |  100% | Products, stock with cost, supplier dues, wallet balances, courier COD and customers load once before go-live, checked first, all-or-nothing. The accountant gets a report to sign. A training brand with demo data.                                                                                                                            |
| Advance payments and return reasons                                         |  100% | bKash, Nagad or bank advance recorded by the agent and checked by accounts before it counts; used on delivery, refunded on cancel; a reason on every return, with a report.                                                                                                                                                                     |
| Marketing                                                                   |  100% | Campaigns, ad spend (typed or imported from Meta), which campaign brought each order, cost per delivered order, ROAS, leads. Meta link needs a real token.                                                                                                                                                                                      |
| Targets and bonuses                                                         |  100% | Monthly targets per agent split by week, progress as orders come in, bonus rules approved by a second person and paid through payroll, pickup time and orders per hour. Team targets wait for the client's rule (D-273).                                                                                                                        |
| Dashboards and leaderboard                                                  |  100% | A daily summary per brand, an owner's dashboard per brand and an all-brands view for the super admin, a fair leaderboard that never shows another brand's revenue or profit, automatic problem alerts, exports. An AI summary exists but is off.                                                                                                |
| Company loans                                                               |  100% | Loans the company takes: flat or reducing-balance schedules, a reminder once per instalment, repayments split into principal and interest, approval above the threshold, statements. A mistaken loan is voided by a second person.                                                                                                              |
| Going live and hardening                                                    |   80% | The test site runs on the owner's server with demo data and one login per role. Security review done and every serious finding fixed; load test passed every target; screens pass an accessibility check in both themes; staff guides and a go-live checklist written. Backup drill, alerts and data-retention rules wait for a staging server. |
| Fraud check, Chatwoot inbox, staff activity extension, landing page builder |     - | Removed by the owner on 2026-10-02. Not counted. The fraud check code was deleted.                                                                                                                                                                                                                                                              |
| Reseller platform (Beownz)                                                  |     - | Set aside by the owner. Not counted.                                                                                                                                                                                                                                                                                                            |

## By milestone

| ID   | What                                   | Built | Note                                                                                      |
| ---- | -------------------------------------- | ----: | ----------------------------------------------------------------------------------------- |
| M00  | Project setup                          |  100% |                                                                                           |
| M01  | Database and brand separation          |  100% |                                                                                           |
| M02a | Sign-in and sessions                   |  100% |                                                                                           |
| M02b | Roles, audit log, approvals            |  100% |                                                                                           |
| M03  | Ledger (the books)                     |  100% |                                                                                           |
| M04  | Background jobs, files, PDFs           |  100% |                                                                                           |
| M05  | Console screens and design kit         |  100% |                                                                                           |
| M06  | Products                               |  100% |                                                                                           |
| M07  | Stock and costing                      |  100% |                                                                                           |
| M08  | Accounts and wallets                   |  100% |                                                                                           |
| M09  | Suppliers and purchases                |  100% |                                                                                           |
| M10  | Order engine                           |  100% |                                                                                           |
| M11  | Order desk, buyer list, website intake |  100% |                                                                                           |
| M12  | Courier booking and COD                |  100% | Steadfast adapter not yet tried on a live account                                         |
| M13  | Fraud check                            |     - | Removed by the owner; code deleted                                                        |
| M14a | Data migration and opening balances    |  100% | Accountant must sign the pilot brand's report                                             |
| M14b | Server deploy, monitoring, backups     |   75% | Test site live; backup and rollback drills still need a staging server                    |
| M15  | Pathao, RedX, tracking page            |  100% | RedX needs a merchant account to confirm its status words                                 |
| M16  | Buyer profiles, SMS, promo codes       |  100% | SMS gateway not chosen yet; a stand-in is used                                            |
| M17  | Advance payments and return reasons    |  100% | Policy defaults need the client's OK                                                      |
| M18  | Marketing                              |  100% | Meta link untested until a real token exists                                              |
| M19  | HR and payroll                         |  100% |                                                                                           |
| M20  | Targets and bonuses                    |  100% | How a team bonus is shared needs the client's answer                                      |
| M21  | Reseller engine                        |     - | Set aside                                                                                 |
| M22  | Reseller portal                        |     - | Set aside                                                                                 |
| M23  | Showroom POS                           |  100% |                                                                                           |
| M24  | Dashboards and leaderboard             |  100% | AI summary built but switched off                                                         |
| M25  | Investors                              |  100% | Investor login pages added 2026-10-02                                                     |
| M26  | Company loans                          |  100% |                                                                                           |
| M27  | Unified inbox (Chatwoot)               |     - | Removed by the owner                                                                      |
| M28  | Staff activity extension               |     - | Removed by the owner                                                                      |
| M29  | Landing pages                          |     - | Removed by the owner                                                                      |
| M30  | Final hardening before launch          |   70% | Part 1 done; part 2 (backup drill, alerts, retention, the owner's sign-off) needs staging |

## Being built now

The owner set the order on 2026-10-02: **build everything, make it testable by a person, host it
on the owner's server, then do M30's review and fixes.** The first three steps are done:

1. **Done: M14b** one-server test site on the owner's server, with HTTPS, a deploy script and
   runbooks. Production deploy config and monitoring are written; the backup and rollback drills
   wait for a staging server.
2. **Done: the missing buttons and screens**: order steps, parcel panel, bulk pack, Settings,
   HR's Pay button, and the Staff screen (invite, roles, leavers, password and two-step resets).
3. **Done: the preview kit**: demo data in every area, one login per role, and the plain testing
   guide (`docs/testing-guide.md`).
4. **Done: M30 part 1**:
   - a security review, with every serious finding fixed: four money-control holes, a
     login rate-limit bypass, and the ways round those fixes a second review found;
   - a load test, with every target met by a wide margin;
   - an accessibility check of every screen in both themes;
   - a guide per role and a go-live checklist for the owner to sign;
   - `pnpm admin:bootstrap`, which creates the first super admin on a new database.
5. **Next: M30 part 2** on a staging server: the timed backup restore, alert rules and how
   long each kind of data is kept. Then the owner signs the go-live checklist.

## Time left (estimate)

| Work                                | Time left          |
| ----------------------------------- | ------------------ |
| M30 part 2 (needs a staging server) | about 2 to 3 hours |

## What the owner needs to do

Nothing here blocks building; each one blocks going live.

1. **Try the test site** with `docs/testing-guide.md` and say what feels wrong or missing.
2. **Change the server password** (`passwd` on the server): it was shared in a chat.
3. **A git remote** (GitHub or similar). Without it the automatic checks (CI) have never run.
4. **Courier accounts**: Steadfast, Pathao and a RedX merchant account, to test against the real
   services.
5. **An SMS gateway** the brands already use, or a choice of one (D-012).
6. **Who may run a showroom till** (D-161), and three small showroom policy questions in
   `decisions.md`.
7. **The accountant**: review the chart of accounts, then sign the opening balances (M14a).
8. **A staging server** for the deploy, backup and rollback drills (M14b and M30 part 2).
9. **Two pricing calls:** is 20% the right most an agent may take off an order or write off at
   the door (D-364, D-365), and should going over it wait for approval instead of being
   refused? Also, should the login cookie be limited to the API's own address (M30 finding A4)?
10. **Sign the go-live checklist** (`docs/go-live-checklist.md`) when every row is ticked.
11. **Merging to `main`**: the finished work sits on stacked branches, and merging is left to the
    owner.

## How this file is kept

Updated at the end of every build session, together with `progress.md`.
