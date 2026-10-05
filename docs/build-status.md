# How much of the ERP is built

Last updated: **2026-10-05** (the owner changed the shape of the system: one ERP per brand, a mother ERP above them, and each brand's ERP running its website, starting with Elysium Lifestyle BD's site. Wave 3 is planned and its first three milestones are being built). This is the short, plain-language view. The
detail is in `progress.md` (session log), `plans/` (one file per milestone) and `decisions.md`.

## Overall

```
Everything     [################----]  78%   (26.5 of 34 milestones)
First plan     [###################-]  98%   (M00 to M30)
Wave 3         [--------------------]   0%   (M31 to M37, started 2026-10-05)
```

- The first plan had 33 milestones. Six are out on the owner's instruction: the Beownz reseller
  platform (M21, M22), the fraud check (M13, and its code deleted), the Chatwoot inbox (M27), the
  staff activity extension (M28) and the landing page builder (M29). So **27 count** from it.
- **Wave 3 adds 7** (the owner's instruction of 2026-10-05, D-469): a separate ERP for each brand
  with no sign of the others, a mother ERP for the owner, and each brand's website run from its
  ERP. So **34 count** in all.
- A milestone counts 100% when it is built, tested and passed its audits. A part-built one counts
  for the share that is done.
- Today: **25 done, 2 part-built (M14b about 75%, M30 about 75%), 7 new ones being built or
  planned.**

"Built" does not mean "live". Before real use, the owner still has to supply the items under
[What the owner needs to do](#what-the-owner-needs-to-do).

## By business area

| Area                                                                        | Built | In plain words                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------------------------------- | ----: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Foundation: sign-in, roles, five separate brands, audit log                 |  100% | Staff sign in, see only their brand and only what their role allows. Every change is logged. An admin manages staff on a Staff screen: invite, roles, deactivate a leaver, reset a password or a lost phone, with a second admin for anyone who can move money.                                                                                 |
| Products and stock                                                          |  100% | Add a product in one form (sizes and colours as clicks, a price per variant, opening stock and photos), or many from a spreadsheet. Each product's page shows its stock everywhere and has receive, adjust, transfer, edit and archive. Categories, sizes, colours and showrooms are set up on one screen. Stock can never go below zero.       |
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
| Going live and hardening                                                    |   85% | The test site runs on the owner's server with demo data and one login per role. Security review done and every serious finding fixed; load test passed every target; screens pass an accessibility check in both themes; staff guides and a go-live checklist written. Backup drill, alerts and data-retention rules wait for a staging server. |
| One ERP per brand (wave 3)                                                  |    0% | Each brand gets its own copy of the ERP, its own database and web address. Nothing in it names another brand or a head office. Being built (M31).                                                                                                                                                                                               |
| The mother ERP (wave 3)                                                     |    0% | A separate site for the owner: every brand's numbers side by side and added up, and one button to open any brand's ERP. Being built (M32).                                                                                                                                                                                                      |
| The website run from the ERP (wave 3)                                       |    0% | The brand's website gets its products, menus, banners, offers, customers and orders from the ERP; its old admin panel is switched off. Elysium first. Catalog and content being built (M33); buying, offers, the switch-over and the old data next (M34 to M36).                                                                                |
| Fraud check, Chatwoot inbox, staff activity extension, landing page builder |     - | Removed by the owner on 2026-10-02. Not counted. The fraud check code was deleted.                                                                                                                                                                                                                                                              |
| Reseller platform (Beownz)                                                  |     - | Set aside by the owner. Not counted.                                                                                                                                                                                                                                                                                                            |

## By milestone

| ID   | What                                   | Built | Note                                                                                             |
| ---- | -------------------------------------- | ----: | ------------------------------------------------------------------------------------------------ |
| M00  | Project setup                          |  100% |                                                                                                  |
| M01  | Database and brand separation          |  100% |                                                                                                  |
| M02a | Sign-in and sessions                   |  100% |                                                                                                  |
| M02b | Roles, audit log, approvals            |  100% |                                                                                                  |
| M03  | Ledger (the books)                     |  100% |                                                                                                  |
| M04  | Background jobs, files, PDFs           |  100% |                                                                                                  |
| M05  | Console screens and design kit         |  100% | Redesigned 2026-10-03 at the owner's request (`plans/design-refresh.md`)                         |
| M06  | Products                               |  100% |                                                                                                  |
| M07  | Stock and costing                      |  100% |                                                                                                  |
| M08  | Accounts and wallets                   |  100% |                                                                                                  |
| M09  | Suppliers and purchases                |  100% |                                                                                                  |
| M10  | Order engine                           |  100% |                                                                                                  |
| M11  | Order desk, buyer list, website intake |  100% |                                                                                                  |
| M12  | Courier booking and COD                |  100% | Steadfast adapter not yet tried on a live account                                                |
| M13  | Fraud check                            |     - | Removed by the owner; code deleted                                                               |
| M14a | Data migration and opening balances    |  100% | Accountant must sign the pilot brand's report                                                    |
| M14b | Server deploy, monitoring, backups     |   75% | Test site live; backup and rollback drills still need a staging server                           |
| M15  | Pathao, RedX, tracking page            |  100% | RedX needs a merchant account to confirm its status words                                        |
| M16  | Buyer profiles, SMS, promo codes       |  100% | SMS gateway not chosen yet; a stand-in is used                                                   |
| M17  | Advance payments and return reasons    |  100% | Policy defaults need the client's OK                                                             |
| M18  | Marketing                              |  100% | Meta link untested until a real token exists                                                     |
| M19  | HR and payroll                         |  100% |                                                                                                  |
| M20  | Targets and bonuses                    |  100% | How a team bonus is shared needs the client's answer                                             |
| M21  | Reseller engine                        |     - | Set aside                                                                                        |
| M22  | Reseller portal                        |     - | Set aside                                                                                        |
| M23  | Showroom POS                           |  100% |                                                                                                  |
| M24  | Dashboards and leaderboard             |  100% | AI summary built but switched off                                                                |
| M25  | Investors                              |  100% | Investor login pages added 2026-10-02                                                            |
| M26  | Company loans                          |  100% |                                                                                                  |
| M27  | Unified inbox (Chatwoot)               |     - | Removed by the owner                                                                             |
| M28  | Staff activity extension               |     - | Removed by the owner                                                                             |
| M29  | Landing pages                          |     - | Removed by the owner                                                                             |
| M30  | Final hardening before launch          |   75% | Part 1 and its follow-ups done; part 2 (backup drill, alerts, retention, sign-off) needs staging |
| M31  | One ERP per brand                      |    0% | Being built                                                                                      |
| M32  | The mother ERP                         |    0% | Being built                                                                                      |
| M33  | Website products and content           |    0% | Being built                                                                                      |
| M34  | Website checkout, accounts, payment    |    0% | Next, after M33                                                                                  |
| M35  | Website offers, landing pages, ncom    |    0% | Next, after M33                                                                                  |
| M36  | Elysium website switched to the ERP    |    0% | After M34 and M35; moves the old site's data                                                     |
| M37  | Brand and mother servers, go-live      |    0% | Needs the owner's servers, domains and a date                                                    |

## Being built now

**Wave 3, from the owner's instruction of 2026-10-05.** The plan is `plans/wave3.md`.

1. **Being built, three at once:**
   - **M31, one ERP per brand.** Each brand runs its own copy with its own database. The
     all-brands screens leave it. Names come from the brand itself, so Oura's staff never see
     "Elysium". The owner can sign in through a one-time link from the mother ERP.
   - **M32, the mother ERP.** The owner's own site: totals and a row per brand for orders,
     sales, profit, cash, stock, COD and ad spend, the leaderboard, each brand's live lists,
     and "Open this brand's ERP".
   - **M33, the website's products and content in the ERP.** A Website section in the ERP for
     the site's settings, banners, menu and size charts, website fields on products and
     categories, and a signed connection the website reads from.
2. **Next:** M34 (checkout, shopper accounts, SSLCommerz, emails) and M35 (flash sales,
   discounts, landing pages, campaign links, Facebook pixel and Google Analytics, the ncom.bd
   link, the packing scanner).
3. **Then:** M36 rewires the Elysium website onto the ERP, removes its admin panel and
   database, and moves the old products, customers, open orders and offers over. M37 puts the
   brand ERPs and the mother ERP on their two servers and switches the site over, step by step
   with the owner.
4. **Still waiting from the first plan:** M30 part 2 (backup drill, alerts, data retention) on a
   staging server.

## Time left (estimate)

| Work                                   | Time left                                    |
| -------------------------------------- | -------------------------------------------- |
| M31, M32, M33 (in parallel)            | about 6 to 8 hours                           |
| M34 and M35                            | about 8 to 10 hours                          |
| M36 (website rewrite and the old data) | about 6 to 8 hours                           |
| M37 and M30 part 2                     | a few hours each, once the servers are ready |

## What the owner needs to do

Nothing here blocks building; each one blocks going live.

**New with wave 3 (2026-10-05):**

- **Deploy a security fix on the current website.** Its public settings address handed out the
  ncom.bd connection secrets to anyone. The fix is on the website repo's branch
  `fix/settings-public-allowlist`. After deploying it, issue new ncom keys (rotate them).
- **The courier-history fraud check** the old admin panel had: carry it into the ERP or not?
  You removed the ERP's own fraud check on 2026-10-02. Until you answer, it is not carried over.
- **Two servers:** which machine runs the brand ERPs and which runs the mother ERP, and the
  mother's web address.
- **Elysium's admin address:** `admin.elysium-lifestyle.bd` unless you prefer another.
  `elysium-lifestyle.bd/admin` will forward there.
- **Elysium's accounts for the website:** SSLCommerz, the email (SMTP) account, the Facebook
  pixel and Conversions API token, Google Analytics, ncom.bd.
- **The accountant:** the old website has no cost price for its stock. Before the switch-over
  the accountant fills in a cost per piece on a sheet the importer produces.
- **A date for the switch-over** of the website.

**From the first plan:**

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
10. **Four rules set by default that you may want changed** (`decisions.md`):
    - adding someone who already works for another brand is the super admin's job (D-412);
    - a supplier bill that arrives late is entered with today's date (D-414);
    - the approval limit counts one person's whole day of supplier payments, or of petty cash
      (D-415);
    - the tracking page pauses for an hour after 300 wrong tries for one brand (D-416).
11. **Sign the go-live checklist** (`docs/go-live-checklist.md`) when every row is ticked.
12. **Merging to `main`**: the finished work sits on stacked branches, and merging is left to the
    owner.

## How this file is kept

Updated at the end of every build session, together with `progress.md`.
