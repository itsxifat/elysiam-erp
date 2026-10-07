# How much of the ERP is built

Last updated: **2026-10-07** (Beownz's own ERP online at erp.beownz.com; the brand spelled Elysiam; super admins, trust votes, parent SKU web addresses and bulk duplicate live; M38b scan-to-pack and M32 the mother ERP built and joined, their tests on Friday). This is the short, plain-language view. The
detail is in `progress.md` (session log), `plans/` (one file per milestone) and `decisions.md`.

## Overall

```
Everything     [###################-]  96%   (about 34.6 of 36 milestones)
First plan     [###################-]  98%   (M00 to M30)
Wave 3         [##################--]  91%   (M31 to M39)
```

- The first plan had 33 milestones; six are out on the owner's instruction (M13, M21, M22, M27,
  M28, M29), so **27 count** from it. **Wave 3 adds 9** (D-469, D-600, D-620), so **36 count** in all.
- A milestone counts 100% when it is built, tested and passed its audits; a part-built one counts
  for the share that is done.
- Today: **31 done**, **5 part-built**: M14b and M30 (wait for a staging server), M32 and M38
  (built and joined, their full tests on Friday), M37 (Elysiam's and Beownz's ERPs online).

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
| One ERP per brand (wave 3)                                                  |  100% | Each brand has its own ERP, database and web address, and nothing in it names another brand or a head office. Elysiam's runs at erp.elysium-lifestyle.bd and Beownz's at erp.beownz.com (M31).                                                                                                                                                  |
| The mother ERP (wave 3)                                                     |   90% | A separate site for the owner: every brand's numbers side by side and added up, and one button to open any brand's ERP. Built and joined; full tests on Friday; needs its own server and domain from the owner (M32).                                                                                                                           |
| The website run from the ERP (wave 3)                                       |  100% | The new website at `demo.elysium-lifestyle.bd` gets everything from Elysiam's ERP; the ERP is its admin panel: products, banners, menu, size charts, checkout, accounts, payment, emails, discounts, flash sales, campaign links, tracking and ncom (M33 to M36).                                                                               |
| Barcode stickers and packing (wave 3)                                       |   90% | Products with stock in hand and cost, one barcode sticker per piece (rolls, A4, 45 × 35 mm, custom), scanning anywhere (M38a, live). The packing station checks every piece against the order and records a video kept until 7 days after delivery (M38b, built; tests on Friday).                                                              |
| Fraud check, Chatwoot inbox, staff activity extension, landing page builder |     - | Removed by the owner on 2026-10-02. Not counted. The fraud check code was deleted.                                                                                                                                                                                                                                                              |
| Reseller platform (Beownz)                                                  |     - | Set aside by the owner. Not counted.                                                                                                                                                                                                                                                                                                            |

## By milestone

| ID   | What                                         | Built | Note                                                                                                                                                                                   |
| ---- | -------------------------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M00  | Project setup                                |  100% |                                                                                                                                                                                        |
| M01  | Database and brand separation                |  100% |                                                                                                                                                                                        |
| M02a | Sign-in and sessions                         |  100% |                                                                                                                                                                                        |
| M02b | Roles, audit log, approvals                  |  100% |                                                                                                                                                                                        |
| M03  | Ledger (the books)                           |  100% |                                                                                                                                                                                        |
| M04  | Background jobs, files, PDFs                 |  100% |                                                                                                                                                                                        |
| M05  | Console screens and design kit               |  100% | Redesigned 2026-10-03 at the owner's request (`plans/design-refresh.md`)                                                                                                               |
| M06  | Products                                     |  100% |                                                                                                                                                                                        |
| M07  | Stock and costing                            |  100% |                                                                                                                                                                                        |
| M08  | Accounts and wallets                         |  100% |                                                                                                                                                                                        |
| M09  | Suppliers and purchases                      |  100% |                                                                                                                                                                                        |
| M10  | Order engine                                 |  100% |                                                                                                                                                                                        |
| M11  | Order desk, buyer list, website intake       |  100% |                                                                                                                                                                                        |
| M12  | Courier booking and COD                      |  100% | Steadfast adapter not yet tried on a live account                                                                                                                                      |
| M13  | Fraud check                                  |     - | Removed by the owner; code deleted                                                                                                                                                     |
| M14a | Data migration and opening balances          |  100% | Accountant must sign the pilot brand's report                                                                                                                                          |
| M14b | Server deploy, monitoring, backups           |   75% | Test site live; backup and rollback drills still need a staging server                                                                                                                 |
| M15  | Pathao, RedX, tracking page                  |  100% | RedX needs a merchant account to confirm its status words                                                                                                                              |
| M16  | Buyer profiles, SMS, promo codes             |  100% | SMS gateway not chosen yet; a stand-in is used                                                                                                                                         |
| M17  | Advance payments and return reasons          |  100% | Policy defaults need the client's OK                                                                                                                                                   |
| M18  | Marketing                                    |  100% | Meta link untested until a real token exists                                                                                                                                           |
| M19  | HR and payroll                               |  100% |                                                                                                                                                                                        |
| M20  | Targets and bonuses                          |  100% | How a team bonus is shared needs the client's answer                                                                                                                                   |
| M21  | Reseller engine                              |     - | Set aside                                                                                                                                                                              |
| M22  | Reseller portal                              |     - | Set aside                                                                                                                                                                              |
| M23  | Showroom POS                                 |  100% |                                                                                                                                                                                        |
| M24  | Dashboards and leaderboard                   |  100% | AI summary built but switched off                                                                                                                                                      |
| M25  | Investors                                    |  100% | Investor login pages added 2026-10-02                                                                                                                                                  |
| M26  | Company loans                                |  100% |                                                                                                                                                                                        |
| M27  | Unified inbox (Chatwoot)                     |     - | Removed by the owner                                                                                                                                                                   |
| M28  | Staff activity extension                     |     - | Removed by the owner                                                                                                                                                                   |
| M29  | Landing pages                                |     - | Removed by the owner                                                                                                                                                                   |
| M30  | Final hardening before launch                |   75% | Part 1 and its follow-ups done; part 2 (backup drill, alerts, retention, sign-off) needs staging                                                                                       |
| M31  | One ERP per brand                            |  100% | Done; Elysium's runs at erp.elysium-lifestyle.bd                                                                                                                                       |
| M32  | The mother ERP                               |   90% | Built and joined; stack run, verify and audits on Friday; needs a server and domain                                                                                                    |
| M33  | Website products and content                 |  100% | Done; live in Elysium's ERP                                                                                                                                                            |
| M34  | Website checkout, accounts, payment          |  100% | Done; live in Elysium's ERP (SSLCommerz needs the store's keys)                                                                                                                        |
| M35  | Website offers, tracking, ncom               |  100% | Done: discounts and flash sales live; campaign links, tracking, ncom, scanner app and labels joined, live with the next deploy                                                         |
| M36  | The new Elysium website on the ERP           |  100% | Done; live at demo.elysium-lifestyle.bd (campaign links and tracking arrive with M35b)                                                                                                 |
| M37  | Servers, addresses, go-live                  |   35% | Elysiam's and Beownz's ERPs live on the brands server; the mother's server and the final domains to come                                                                               |
| M38  | Barcode stickers, strict stock, scan-to-pack |   90% | Stickers, stock in hand and the scanner live (M38a); packing station and video built and joined (M38b), tests on Friday                                                                |
| M39  | Catalog management: delete, variant prices   |  100% | Done and live: delete or archive everywhere; prices by size or colour, bulk price changes, buying price per variant, margins, standard buying prices, duplicate product, regular price |

## Being built now

1. **Online now:** Elysiam's ERP at `https://erp.elysium-lifestyle.bd` and Beownz's at
   `https://erp.beownz.com`; the website at `https://demo.elysium-lifestyle.bd`.
2. **Built and joined, tested on Friday:** M38b (the packing station and video) and M32 (the
   mother ERP); with them, the full test run of everything built lean this week: super admins
   and trust votes, parent SKU addresses and bulk duplicate, the sign-in fix.
3. **Then:** the packing station goes live on Elysiam (one server setting for video uploads),
   the mother ERP goes on its own server, and the final addresses (M37).

## Time left (estimate)

| Work                                                   | Time left          |
| ------------------------------------------------------ | ------------------ |
| Friday's tests and fixes (M38b, M32, this week's work) | about 4 to 6 hours |
| The mother ERP on its server (once the owner names it) | about 1 to 2 hours |
| Final addresses and go-live (M37)                      | about 2 to 3 hours |
| **All building**                                       | **about 1 day**    |

## What the owner needs to do

Nothing here blocks building; each one blocks going live.

**New with wave 3 (2026-10-05):**

- **Deploy a security fix on the current website.** Its public settings address handed out the
  ncom.bd connection secrets to anyone. The fix is on the website repo's branch
  `fix/settings-public-allowlist`. After deploying it, issue new ncom keys (rotate them).
- **The courier-history fraud check** the old admin panel had: carry it into the ERP or not?
  You removed the ERP's own fraud check on 2026-10-02. Until you answer, it is not carried over.
- **Two DNS records in Cloudflare** (DNS only, grey cloud): `erp` and `demo`, both A to
  `103.129.209.29`. Elysium's ERP goes online as soon as `erp` resolves.
- **Change the server password**: it was shared in chat again on 2026-10-05.
- **The mother ERP's server and address**, when it resumes.
- **Elysium's accounts for the website:** SSLCommerz, the email (SMTP) account, the Facebook
  pixel and Conversions API token, Google Analytics, ncom.bd.
- **Stock cost:** enter each product's cost per piece as you upload its stock in hand (the
  owner's choice; nothing is imported from the old site).
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
