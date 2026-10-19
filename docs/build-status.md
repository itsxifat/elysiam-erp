# How much of the ERP is built

Last updated: **2026-10-19** (Customer numbers and people (M48) live on both brands (2026-10-19, 3f8b4184); phone calls through Envo (M47) live on both brands (2026-10-19, e70fe2e9), with the owner's answers of 2026-10-19 (recordings played from Envo, a wrap-up after every call, the caller panel); Labels and Packaging, with terminals, printers and lots (M46), live on both brands; order ownership and auto-assign, the unified inbox, the English-only slips, the alive inbox, selling from the chat and voice messages and calls (M41 to M45) are live too; the owner asked for minimal tests until the product is final). This is the short, plain-language view. The
detail is in `progress.md` (session log), `plans/` (one file per milestone) and `decisions.md`.

## Overall

```
Everything     [###################-]  97%   (about 43.6 of 45 milestones)
First plan     [###################-]  98%   (M00 to M30)
Wave 3         [##################--]  93%   (M31 to M39)
Wave 4         [###################-]  99%   (M40 to M48; broad tests deferred, D-758)
```

- The first plan had 33 milestones; six are out on the owner's instruction (M13, M21, M22, M27,
  M28, M29), so **27 count** from it. **Wave 3 adds 9** (D-469, D-600, D-620) and **wave 4 adds 9**
  (M40 to M43, 2026-10-11; M44 and M45, 2026-10-12; M46, 2026-10-17; M47, 2026-10-18; M48,
  2026-10-19), so **45 count** in all.
- A milestone counts 100% when it is built, tested and passed its audits; a part-built one counts
  for the share that is done.
- Today: **33 done** (M32 and M38 on 2026-10-08), **3 part-built**: M14b and M30 (wait for a
  staging server) and M37 (Elysiam's and Beownz's ERPs online; the mother's server to come).

"Built" does not mean "live". Before real use, the owner still has to supply the items under
[What the owner needs to do](#what-the-owner-needs-to-do).

## By business area

| Area                                                                        | Built | In plain words                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Foundation: sign-in, roles, five separate brands, audit log                 |  100% | Staff sign in, see only their brand and only what their role allows. Every change is logged. An admin manages staff on a Staff screen: invite, roles, deactivate a leaver, reset a password or a lost phone, with a second admin for anyone who can move money.                                                                                                          |
| Products and stock                                                          |  100% | Add a product in one form (sizes and colours as clicks, a price per variant, opening stock and photos), or many from a spreadsheet. Each product's page shows its stock everywhere and has receive, adjust, transfer, edit and archive. Categories, sizes, colours and showrooms are set up on one screen. Stock can never go below zero.                                |
| Accounting and wallets                                                      |  100% | Cash, bKash and bank wallets, double-entry books, P&L, balance sheet, month close.                                                                                                                                                                                                                                                                                       |
| Orders                                                                      |  100% | Order desk for agents, website order intake, buyer list. Each order shows only its allowed next steps (confirm, pack, hand to courier, deliver, return, hold); courier updates move orders on by themselves; bulk pack.                                                                                                                                                  |
| Couriers and COD                                                            |  100% | Steadfast, Pathao, RedX booking, tracking page, COD cash matching, stuck-parcel list. Needs live accounts.                                                                                                                                                                                                                                                               |
| Customers, SMS, promo codes                                                 |  100% | Buyer profiles, birthday offers, lapsed-buyer list, SMS templates, promo codes at the order desk.                                                                                                                                                                                                                                                                        |
| Showrooms (POS)                                                             |  100% | A till that works offline, Bangla receipts, day closing per branch.                                                                                                                                                                                                                                                                                                      |
| HR and payroll                                                              |  100% | Employees, attendance, salary, staff loans, Bangla payslips.                                                                                                                                                                                                                                                                                                             |
| Investors                                                                   |  100% | Capital, profit share, withdrawals with approval. Investors sign in to their own pages with two-step login and see only their own money.                                                                                                                                                                                                                                 |
| Moving old data in                                                          |  100% | Products, stock with cost, supplier dues, wallet balances, courier COD and customers load once before go-live, checked first, all-or-nothing. The accountant gets a report to sign. A training brand with demo data.                                                                                                                                                     |
| Advance payments and return reasons                                         |  100% | bKash, Nagad or bank advance recorded by the agent and checked by accounts before it counts; used on delivery, refunded on cancel; a reason on every return, with a report.                                                                                                                                                                                              |
| Marketing                                                                   |  100% | Campaigns, ad spend (typed or imported from Meta), which campaign brought each order, cost per delivered order, ROAS, leads. Meta link needs a real token.                                                                                                                                                                                                               |
| Targets and bonuses                                                         |  100% | Monthly targets per agent split by week, progress as orders come in, bonus rules approved by a second person and paid through payroll, pickup time and orders per hour. Team targets wait for the client's rule (D-273).                                                                                                                                                 |
| Dashboards and leaderboard                                                  |  100% | A daily summary per brand, an owner's dashboard per brand and an all-brands view for the super admin, a fair leaderboard that never shows another brand's revenue or profit, automatic problem alerts, exports. An AI summary exists but is off.                                                                                                                         |
| Company loans                                                               |  100% | Loans the company takes: flat or reducing-balance schedules, a reminder once per instalment, repayments split into principal and interest, approval above the threshold, statements. A mistaken loan is voided by a second person.                                                                                                                                       |
| Going live and hardening                                                    |   85% | The test site runs on the owner's server with demo data and one login per role. Security review done and every serious finding fixed; load test passed every target; screens pass an accessibility check in both themes; staff guides and a go-live checklist written. Backup drill, alerts and data-retention rules wait for a staging server.                          |
| One ERP per brand (wave 3)                                                  |  100% | Each brand has its own ERP, database and web address, and nothing in it names another brand or a head office. Elysiam's runs at erp.elysium-lifestyle.bd and Beownz's at erp.beownz.com (M31).                                                                                                                                                                           |
| The mother ERP (wave 3)                                                     |  100% | A separate site for the owner: every brand's numbers side by side and added up, and one button to open any brand's ERP. Built and tested; it goes online when the owner names its server and domain (M37).                                                                                                                                                               |
| The website run from the ERP (wave 3)                                       |  100% | The new website at `demo.elysium-lifestyle.bd` gets everything from Elysiam's ERP; the ERP is its admin panel: products, banners, menu, size charts, checkout, accounts, payment, emails, discounts, flash sales, campaign links, tracking and ncom (M33 to M36).                                                                                                        |
| Barcode stickers and packing (wave 3)                                       |  100% | Products with stock in hand and cost, one barcode sticker per piece, scanning anywhere, and the packing station: every piece checked against the order, a video kept until 7 days after delivery. Live on both brands (M38). An IP camera over the packing table can now film it instead, from 2 seconds before the first correct piece (M38c, built, not yet deployed). |
| Fraud check, Chatwoot inbox, staff activity extension, landing page builder |     - | Removed by the owner on 2026-10-02. Not counted. The ERP's own inbox (M42) and a manual Fraud mark replaced them on 2026-10-12.                                                                                                                                                                                                                                          |
| Reseller platform (Beownz)                                                  |     - | Set aside by the owner. Not counted.                                                                                                                                                                                                                                                                                                                                     |

## By milestone

| ID   | What                                            | Built | Note                                                                                                                                                                                                                                                           |
| ---- | ----------------------------------------------- | ----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M00  | Project setup                                   |  100% |                                                                                                                                                                                                                                                                |
| M01  | Database and brand separation                   |  100% |                                                                                                                                                                                                                                                                |
| M02a | Sign-in and sessions                            |  100% |                                                                                                                                                                                                                                                                |
| M02b | Roles, audit log, approvals                     |  100% |                                                                                                                                                                                                                                                                |
| M03  | Ledger (the books)                              |  100% |                                                                                                                                                                                                                                                                |
| M04  | Background jobs, files, PDFs                    |  100% |                                                                                                                                                                                                                                                                |
| M05  | Console screens and design kit                  |  100% | Redesigned 2026-10-03 at the owner's request (`plans/design-refresh.md`)                                                                                                                                                                                       |
| M06  | Products                                        |  100% |                                                                                                                                                                                                                                                                |
| M07  | Stock and costing                               |  100% |                                                                                                                                                                                                                                                                |
| M08  | Accounts and wallets                            |  100% |                                                                                                                                                                                                                                                                |
| M09  | Suppliers and purchases                         |  100% |                                                                                                                                                                                                                                                                |
| M10  | Order engine                                    |  100% |                                                                                                                                                                                                                                                                |
| M11  | Order desk, buyer list, website intake          |  100% |                                                                                                                                                                                                                                                                |
| M12  | Courier booking and COD                         |  100% | Steadfast adapter not yet tried on a live account                                                                                                                                                                                                              |
| M13  | Fraud check                                     |     - | Removed by the owner; code deleted                                                                                                                                                                                                                             |
| M14a | Data migration and opening balances             |  100% | Accountant must sign the pilot brand's report                                                                                                                                                                                                                  |
| M14b | Server deploy, monitoring, backups              |   75% | Test site live; backup and rollback drills still need a staging server                                                                                                                                                                                         |
| M15  | Pathao, RedX, tracking page                     |  100% | RedX needs a merchant account to confirm its status words                                                                                                                                                                                                      |
| M16  | Buyer profiles, SMS, promo codes                |  100% | SMS gateway not chosen yet; a stand-in is used                                                                                                                                                                                                                 |
| M17  | Advance payments and return reasons             |  100% | Policy defaults need the client's OK                                                                                                                                                                                                                           |
| M18  | Marketing                                       |  100% | Meta link untested until a real token exists                                                                                                                                                                                                                   |
| M19  | HR and payroll                                  |  100% |                                                                                                                                                                                                                                                                |
| M20  | Targets and bonuses                             |  100% | How a team bonus is shared needs the client's answer                                                                                                                                                                                                           |
| M21  | Reseller engine                                 |     - | Set aside                                                                                                                                                                                                                                                      |
| M22  | Reseller portal                                 |     - | Set aside                                                                                                                                                                                                                                                      |
| M23  | Showroom POS                                    |  100% |                                                                                                                                                                                                                                                                |
| M24  | Dashboards and leaderboard                      |  100% | AI summary built but switched off                                                                                                                                                                                                                              |
| M25  | Investors                                       |  100% | Investor login pages added 2026-10-02                                                                                                                                                                                                                          |
| M26  | Company loans                                   |  100% |                                                                                                                                                                                                                                                                |
| M27  | Unified inbox (Chatwoot)                        |     - | Removed by the owner                                                                                                                                                                                                                                           |
| M28  | Staff activity extension                        |     - | Removed by the owner                                                                                                                                                                                                                                           |
| M29  | Landing pages                                   |     - | Removed by the owner                                                                                                                                                                                                                                           |
| M30  | Final hardening before launch                   |   75% | Part 1 and its follow-ups done; part 2 (backup drill, alerts, retention, sign-off) needs staging                                                                                                                                                               |
| M31  | One ERP per brand                               |  100% | Done; Elysium's runs at erp.elysium-lifestyle.bd                                                                                                                                                                                                               |
| M32  | The mother ERP                                  |  100% | Done 2026-10-08; online once the owner names a server and domain                                                                                                                                                                                               |
| M33  | Website products and content                    |  100% | Done; live in Elysium's ERP                                                                                                                                                                                                                                    |
| M34  | Website checkout, accounts, payment             |  100% | Done; live in Elysium's ERP (SSLCommerz needs the store's keys)                                                                                                                                                                                                |
| M35  | Website offers, tracking, ncom                  |  100% | Done: discounts and flash sales live; campaign links, tracking, ncom, scanner app and labels joined, live with the next deploy                                                                                                                                 |
| M36  | The new Elysium website on the ERP              |  100% | Done; live at demo.elysium-lifestyle.bd (campaign links and tracking arrive with M35b)                                                                                                                                                                         |
| M37  | Servers, addresses, go-live                     |   60% | Elysiam's and Beownz's ERPs and the mother ERP (elyerp.enfinito.cloud) live; the final domains to come                                                                                                                                                         |
| M38  | Barcode stickers, strict stock, scan-to-pack    |  100% | Done 2026-10-08; stickers, stock in hand, scanner and the packing station with video, live                                                                                                                                                                     |
| M39  | Catalog management: delete, variant prices      |  100% | Done and live: delete or archive everywhere; prices by size or colour, bulk price changes, buying price per variant, margins, standard buying prices, duplicate product, regular price                                                                         |
| M40  | My account and two-step sign-in                 |  100% | Done and live 2026-10-11: My account, a two-step rule per role, sign out everywhere; the mother's brands set on the server only                                                                                                                                |
| M41  | Order ownership, calls, auto-assign             |  100% | Live 2026-10-12: take an order, warnings for everyone else, call log, Uber-style offers (off until turned on), hub queues, team board                                                                                                                          |
| M42  | Unified inbox and customer panel                |  100% | Live 2026-10-12: Messenger, Instagram and WhatsApp in one inbox with the customer panel; receives nothing until the Meta app is connected                                                                                                                      |
| M43  | Premium slips, English only                     |  100% | Live 2026-10-12: new slip, invoice and labels; Bangla removed everywhere                                                                                                                                                                                       |
| M44  | A fast, alive inbox; selling from the chat      |  100% | Live 2026-10-12: full-window inbox, names and photos, motion and sounds, saved replies, size and quantity spotting in English and Bangla, product picker, order placed from the chat                                                                           |
| M45  | Voice messages and calls                        |  100% | Live 2026-10-12: voice messages both ways, calls ringing in the browser; untested against Meta until the owner tries them (Messenger calling is not offered in Bangladesh)                                                                                     |
| M46  | Labels and Packaging, terminals, printers, lots |  100% | Live 2026-10-17: label and packing terminals with people and cameras, network and browser printers, automatic labels on booking, a print log with reprint reasons, orders in several lots; untested on real printers                                           |
| M47  | Phone calls through Envo                        |   95% | Live 2026-10-19 (e70fe2e9) on both brands, the owner's answers included: Envo connections, extensions for staff, Call buttons, the phone in the console, call logs, recordings played from Envo, wrap-ups and the caller panel; untested against the live Envo |
| M48  | Customer numbers and people                     |   95% | Live 2026-10-19 (3f8b4184) on both brands: several numbers per buyer with staff notes, shared numbers, orders for someone else, change buyer and merge, the caller panel's numbers; no screen tests yet                                                        |

## Being built now

1. **Online now:** Elysiam's ERP at `https://erp.elysium-lifestyle.bd` and Beownz's at
   `https://erp.beownz.com`, with the packing station and video; the website at
   `https://demo.elysium-lifestyle.bd`.
2. **Live, not yet merged to main:** phone calls through Envo (M47, branch `m47-envo-calls`)
   and customer numbers and people (M48, branch `m48-customer-numbers`), deployed from
   `integration-wave2`.
3. **Ready, waiting for the owner:** the mother ERP needs its own server and domain.
4. **Then:** the final addresses (M37). Removing a super admin, and stepping down, is built
   (2026-10-10, branch `superadmin-removal`, not merged or deployed).

## Time left (estimate)

| Work                                                   | Time left            |
| ------------------------------------------------------ | -------------------- |
| The mother ERP on its server (once the owner names it) | about 1 to 2 hours   |
| Final addresses and go-live (M37)                      | about 2 to 3 hours   |
| **All building**                                       | **about half a day** |

## What the owner needs to do

Nothing here blocks building; each one blocks going live.

**New 2026-10-18 (phone calls through Envo, M47), once it is deployed** (step by step in
`decisions.md` D-857):

- **In Envo**, for each brand's own SIP server: an API key with the read, calls and webphone
  scopes and the brand's ERP address (`https://erp.elysium-lifestyle.bd`, `https://erp.beownz.com`)
  under Allowed browser origins; Web phone on for each extension used in the browser; recording
  on where calls should be kept.
- **In the ERP**, Settings → Calls: add the connection (`https://envo.enfinito.cloud` and the API
  key) and press Test. Then make a webhook in Envo's Developers → Webhooks to the address the ERP
  shows, paste its signing secret back into the connection, switch it on, and give each agent an
  extension.
- **Each agent**: allow the microphone in Chrome the first time the phone asks.
- **Six questions** (`decisions.md`): who may hear recordings (D-841), how long to keep them (365
  days for now, D-842), whether an unanswered call counts as a verification attempt (D-838),
  whether an inbound call links the caller's newest open order by itself (D-835), whether the
  ring-back of your own Call answers by itself (D-843), and whether a Call from the inbox asks
  the conversation's owner first (D-853).

**New 2026-10-08 (the IP camera, M38c):**

- After the next deploy, enter the packing table's camera in Packaging → Cameras (it was Orders →
  Pack → Settings → IP cameras before M46): its address `rtsp://192.168.20.111:554/stream1`, the camera account's user name and
  password (typed there, never sent in chat). Check it reads **Ready**, choose it on the packing
  computer, pack one order and play its video. Say if `stream2` (smaller files) should be used.

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
