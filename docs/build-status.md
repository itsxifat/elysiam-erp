# How much of the ERP is built

Last updated: **2026-10-02** (after the owner removed the fraud check). This is the short, plain-language view. The detail is in
`progress.md` (session log), `plans/` (one file per milestone) and `decisions.md`.

## Overall

```
Built     [##############------]  70%
```

- The plan has 33 milestones. Six are out on the owner's instruction: the Beownz reseller
  platform (M21, M22), the fraud check (M13, and its code deleted), the Chatwoot inbox (M27), the
  staff activity extension (M28) and the landing page builder (M29). So **27 count**.
- A milestone counts 100% when it is built, tested and passed its audits. A part-built one counts
  for the share that is done.
- Today: **18 done, 2 part-built, 7 not started.**

"Built" does not mean "live". Before real use, the owner still has to supply the items under
[What the owner needs to do](#what-the-owner-needs-to-do).

## By business area

| Area                                                                        | Built | In plain words                                                                                             |
| --------------------------------------------------------------------------- | ----: | ---------------------------------------------------------------------------------------------------------- |
| Foundation: sign-in, roles, five separate brands, audit log                 |  100% | Staff sign in, see only their brand and only what their role allows. Every change is logged.               |
| Products and stock                                                          |  100% | Products, sizes, prices, stock per warehouse and showroom, cost tracking. Stock can never go below zero.   |
| Accounting and wallets                                                      |  100% | Cash, bKash and bank wallets, double-entry books, P&L, balance sheet, month close.                         |
| Orders                                                                      |  100% | Order desk for agents, website order intake, buyer list.                                                   |
| Couriers and COD                                                            |  100% | Steadfast, Pathao, RedX booking, tracking page, COD cash matching, stuck-parcel list. Needs live accounts. |
| Customers, SMS, promo codes                                                 |  100% | Buyer profiles, birthday offers, lapsed-buyer list, SMS templates, promo codes at the order desk.          |
| Showrooms (POS)                                                             |  100% | A till that works offline, Bangla receipts, day closing per branch.                                        |
| HR and payroll                                                              |  100% | Employees, attendance, salary, staff loans, Bangla payslips.                                               |
| Investors                                                                   |   85% | Capital, profit share, withdrawals with approval. The investors' own login pages are not built yet.        |
| Moving old data in                                                          |   10% | Opening balances started. Importers for products, stock, dues and customers are next.                      |
| Advance payments and return reasons                                         |    0% | bKash advance recorded and verified, applied on delivery; why parcels come back.                           |
| Marketing                                                                   |    0% | Ad spend, Meta import, cost per delivered order, ROAS.                                                     |
| Targets and bonuses                                                         |    0% | Monthly sales targets split by week, bonus rules feeding payroll.                                          |
| Dashboards and leaderboard                                                  |    0% | Owner and super-admin dashboards, agent leaderboard.                                                       |
| Company loans                                                               |    0% | Loans the company takes, schedules, reminders.                                                             |
| Going live and hardening                                                    |    0% | Server deploy, monitoring, backups, load tests, security review.                                           |
| Fraud check, Chatwoot inbox, staff activity extension, landing page builder |     - | Removed by the owner on 2026-10-02. Not counted. The fraud check code was deleted.                         |
| Reseller platform (Beownz)                                                  |     - | Set aside by the owner. Not counted.                                                                       |

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
| M14a | Data migration and opening balances    |   10% | In progress                                               |
| M14b | Server deploy, monitoring, backups     |    0% | Needs a staging server from the owner                     |
| M15  | Pathao, RedX, tracking page            |  100% | RedX needs a merchant account to confirm its status words |
| M16  | Buyer profiles, SMS, promo codes       |  100% | SMS gateway not chosen yet; a stand-in is used            |
| M17  | Advance payments and return reasons    |    0% | Fraud half removed                                        |
| M18  | Marketing                              |    0% | Next                                                      |
| M19  | HR and payroll                         |  100% |                                                           |
| M20  | Targets and bonuses                    |    0% | Next                                                      |
| M21  | Reseller engine                        |     - | Set aside                                                 |
| M22  | Reseller portal                        |     - | Set aside                                                 |
| M23  | Showroom POS                           |  100% |                                                           |
| M24  | Dashboards and leaderboard             |    0% | Waits for M18 and M20                                     |
| M25  | Investors                              |   85% | Investor login pages missing                              |
| M26  | Company loans                          |    0% |                                                           |
| M27  | Unified inbox (Chatwoot)               |     - | Removed by the owner                                      |
| M28  | Staff activity extension               |     - | Removed by the owner                                      |
| M29  | Landing pages                          |     - | Removed by the owner                                      |
| M30  | Final hardening before launch          |    0% | Last                                                      |

## Being built now

Restarted on 2026-10-02, four at once, each on its own branch:

- **M14a** importing old data and opening balances
- **M17** bKash advance payments and return reasons
- **M18** ad spend and marketing numbers
- **M20** sales targets and bonuses

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
