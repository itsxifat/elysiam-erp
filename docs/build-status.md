# How much of the ERP is built

Last updated: **2026-10-02** (M14a, M17, M18, M20, M24, M25 and M26 finished). This is the short, plain-language view. The
detail is in `progress.md` (session log), `plans/` (one file per milestone) and `decisions.md`.

## Overall

```
Built     [###################-]  93%
```

- The plan has 33 milestones. Six are out on the owner's instruction: the Beownz reseller
  platform (M21, M22), the fraud check (M13, and its code deleted), the Chatwoot inbox (M27), the
  staff activity extension (M28) and the landing page builder (M29). So **27 count**.
- A milestone counts 100% when it is built, tested and passed its audits. A part-built one counts
  for the share that is done.
- Today: **25 done, 1 being built (M14b), 1 not started (M30).**

"Built" does not mean "live". Before real use, the owner still has to supply the items under
[What the owner needs to do](#what-the-owner-needs-to-do).

## By business area

| Area                                                                        | Built | In plain words                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foundation: sign-in, roles, five separate brands, audit log                 |  100% | Staff sign in, see only their brand and only what their role allows. Every change is logged.                                                                                                                                                     |
| Products and stock                                                          |  100% | Products, sizes, prices, stock per warehouse and showroom, cost tracking. Stock can never go below zero.                                                                                                                                         |
| Accounting and wallets                                                      |  100% | Cash, bKash and bank wallets, double-entry books, P&L, balance sheet, month close.                                                                                                                                                               |
| Orders                                                                      |  100% | Order desk for agents, website order intake, buyer list.                                                                                                                                                                                         |
| Couriers and COD                                                            |  100% | Steadfast, Pathao, RedX booking, tracking page, COD cash matching, stuck-parcel list. Needs live accounts.                                                                                                                                       |
| Customers, SMS, promo codes                                                 |  100% | Buyer profiles, birthday offers, lapsed-buyer list, SMS templates, promo codes at the order desk.                                                                                                                                                |
| Showrooms (POS)                                                             |  100% | A till that works offline, Bangla receipts, day closing per branch.                                                                                                                                                                              |
| HR and payroll                                                              |  100% | Employees, attendance, salary, staff loans, Bangla payslips.                                                                                                                                                                                     |
| Investors                                                                   |  100% | Capital, profit share, withdrawals with approval. Investors sign in to their own pages with two-step login and see only their own money.                                                                                                         |
| Moving old data in                                                          |  100% | Products, stock with cost, supplier dues, wallet balances, courier COD and customers load once before go-live, checked first, all-or-nothing. The accountant gets a report to sign. A training brand with demo data.                             |
| Advance payments and return reasons                                         |  100% | bKash, Nagad or bank advance recorded by the agent and checked by accounts before it counts; used on delivery, refunded on cancel; a reason on every return, with a report.                                                                      |
| Marketing                                                                   |  100% | Campaigns, ad spend (typed or imported from Meta), which campaign brought each order, cost per delivered order, ROAS, leads. Meta link needs a real token.                                                                                       |
| Targets and bonuses                                                         |  100% | Monthly targets per agent split by week, progress as orders come in, bonus rules approved by a second person and paid through payroll, pickup time and orders per hour. Team targets wait for the client's rule (D-273).                         |
| Dashboards and leaderboard                                                  |  100% | A daily summary per brand, an owner's dashboard per brand and an all-brands view for the super admin, a fair leaderboard that never shows another brand's revenue or profit, automatic problem alerts, exports. An AI summary exists but is off. |
| Company loans                                                               |  100% | Loans the company takes: flat or reducing-balance schedules, a reminder once per instalment, repayments split into principal and interest, approval above the threshold, statements. A mistaken loan is voided by a second person.               |
| Going live and hardening                                                    |    0% | Server deploy, monitoring, backups, load tests, security review.                                                                                                                                                                                 |
| Fraud check, Chatwoot inbox, staff activity extension, landing page builder |     - | Removed by the owner on 2026-10-02. Not counted. The fraud check code was deleted.                                                                                                                                                               |
| Reseller platform (Beownz)                                                  |     - | Set aside by the owner. Not counted.                                                                                                                                                                                                             |

## By milestone

| ID   | What                                   | Built | Note                                                      |
| ---- | -------------------------------------- | ----: | --------------------------------------------------------- |
| M00  | Project setup                          |  100% |                                                           |
| M01  | Database and brand separation          |  100% |                                                           |
| M02a | Sign-in and sessions                   |  100% |                                                           |
| M02b | Roles, audit log, approvals            |  100% |                                                           |
| M03  | Ledger (the books)                     |  100% |                                                           |
| M04  | Background jobs, files, PDFs           |  100% |                                                           |
| M05  | Console screens and design kit         |  100% |                                                           |
| M06  | Products                               |  100% |                                                           |
| M07  | Stock and costing                      |  100% |                                                           |
| M08  | Accounts and wallets                   |  100% |                                                           |
| M09  | Suppliers and purchases                |  100% |                                                           |
| M10  | Order engine                           |  100% |                                                           |
| M11  | Order desk, buyer list, website intake |  100% |                                                           |
| M12  | Courier booking and COD                |  100% | Steadfast adapter not yet tried on a live account         |
| M13  | Fraud check                            |     - | Removed by the owner; code deleted                        |
| M14a | Data migration and opening balances    |  100% | Accountant must sign the pilot brand's report             |
| M14b | Server deploy, monitoring, backups     |    0% | Needs a staging server from the owner                     |
| M15  | Pathao, RedX, tracking page            |  100% | RedX needs a merchant account to confirm its status words |
| M16  | Buyer profiles, SMS, promo codes       |  100% | SMS gateway not chosen yet; a stand-in is used            |
| M17  | Advance payments and return reasons    |  100% | Policy defaults need the client's OK                      |
| M18  | Marketing                              |  100% | Meta link untested until a real token exists              |
| M19  | HR and payroll                         |  100% |                                                           |
| M20  | Targets and bonuses                    |  100% | How a team bonus is shared needs the client's answer      |
| M21  | Reseller engine                        |     - | Set aside                                                 |
| M22  | Reseller portal                        |     - | Set aside                                                 |
| M23  | Showroom POS                           |  100% |                                                           |
| M24  | Dashboards and leaderboard             |  100% | AI summary built but switched off                         |
| M25  | Investors                              |  100% | Investor login pages added 2026-10-02                     |
| M26  | Company loans                          |  100% |                                                           |
| M27  | Unified inbox (Chatwoot)               |     - | Removed by the owner                                      |
| M28  | Staff activity extension               |     - | Removed by the owner                                      |
| M29  | Landing pages                          |     - | Removed by the owner                                      |
| M30  | Final hardening before launch          |    0% | Last                                                      |

## Being built now

- **M14b** getting ready for a server: production images, deploy config, monitoring, backups,
  runbooks. Its last checks need a staging server from the owner.

M14a, M17, M18, M20, M24, M26 and M25's investor pages finished on 2026-10-02 and are joined on the
branch `integration-wave2`, where every check passes (2,568 tests).

## What the owner needs to do

Nothing here blocks building; each one blocks going live.

1. **A git remote** (GitHub or similar). Without it the automatic checks (CI) have never run.
2. **Courier accounts**: Steadfast, Pathao and a RedX merchant account, to test against the real
   services.
3. **An SMS gateway** the brands already use, or a choice of one (D-012).
4. **Who may run a showroom till** (D-161), and three small showroom policy questions in
   `decisions.md`.
5. **The accountant**: review the chart of accounts, then sign the opening balances (M14a).
6. **A staging server** for the deploy, backup and rollback drills (M14b).
7. **Merging to `main`**: the finished work sits on stacked branches, and merging is left to the
   owner.

## How this file is kept

Updated at the end of every build session, together with `progress.md`.
