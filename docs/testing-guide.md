# Trying the ERP: a guide for the owner

This guide walks through every part of the ERP that is built, one business area at a time.
For each area it says who to sign in as, where to click, what you should see, and what to
try. The preview is full of made-up demo data, so nothing you do here touches a real brand,
a real courier or a real customer. Try anything.

## Before you start

**Where.** Everything is on one address:

| App                                              | Address                                                         |
| ------------------------------------------------ | --------------------------------------------------------------- |
| **Staff console**, where almost all work happens | https://elyerp.enfinito.cloud/                                  |
| **Investor portal**                              | https://elyerp.enfinito.cloud/portal/                           |
| **Showroom till**                                | https://elyerp.enfinito.cloud/pos/                              |
| **Order tracking**, the page buyers use          | https://elyerp.enfinito.cloud/portal/track/elysium-lifestyle-bd |

Your developer gives you a private file called `preview-credentials.local.md`. It lists one
sign-in per role, with an email, a password and the app it opens. Keep it to yourself: anyone
with it can sign in.

Every sign-in works in the brand **Elysium Lifestyle BD**. The super admin also sees the
other four brands and the training brand.

**Use Chrome or Edge.** To be two people at once (for example a sales agent and an
accountant), open a second person in an Incognito/InPrivate window, or in a different
browser.

**Two-step login.** The super admin, the org admin, accounts and the investor must set up
two-step login the first time they sign in. Every company account with money access has to.

1. Install an authenticator app on your phone: Google Authenticator, Microsoft
   Authenticator or similar.
2. Sign in. The screen shows a setup key, a long code in a grey box.
3. In the app choose "add account", then "enter a setup key", and type the key.
4. The screen shows recovery codes. Save them (the "Download codes" button), then tick
   "I have saved my recovery codes".
5. Type the 6-digit code the app shows and press **Confirm and continue**.

From then on, each sign-in asks for the current 6-digit code from the app. If several
people set this up at the same moment from one office, the system may say "Too many
attempts. Wait a minute and try again". Wait a minute and try again.

**Language and look.** The console starts in English. The icon at the top right switches
to Bangla, and the moon icon switches to the dark theme. The portal and the tracking page
start in Bangla; the language button at the top switches them to English.

**If something looks wrong**, note the screen, the sign-in you used and what you did. A
screenshot helps. Re-making the preview gives everyone new passwords and fresh demo data.

## What is already in the preview

- **Products:** six products with sizes (tees, polos, panjabi, shirts, denim, hoodies), in
  the main warehouse and the Dhanmondi showroom.
- **Orders:** 15 orders from made-up buyers ("Demo Buyer …", phone numbers starting
  `+8801980000`), in every state:
  - waiting;
  - confirmed;
  - on hold;
  - packed;
  - shipped;
  - delivered;
  - returned;
  - cancelled.
- **Couriers:** parcels with a pretend courier called **Demo Courier**, which never
  contacts a real company.
- **Money and people:**
  - two suppliers with purchases;
  - wallets (bank, bKash, office cash, showroom cash);
  - two investors;
  - a bank loan;
  - six employees with two months of payroll;
  - a sales target;
  - a day of showroom sales.
- **Waiting for you to approve:** September's payroll, a damaged-stock write-off, a
  supplier payment, an advance a buyer paid by bKash, and an investor's withdrawal request.

## 1. Orders and buyers

Sign in as **Sales agent**.

1. **Orders** in the left menu shows every order with its status. Try the filters (status,
   channel, agent, delivery zone) and the search box (an order number, a phone or a name).
2. Click an order to open it: the buyer, the address, the items, the money and a timeline
   of everything that happened to it.
3. Open a **Pending** order and press **Confirm**. The stock for it is now held.
4. **New order** (top right) is the order desk:
   - type a phone number (any number starting `01` and 11 digits long);
   - type a name and an address (pick the district and area);
   - add items;
   - optionally the promo code **EID10** for 10% off orders over ৳1,000;
   - save.
     The delivery charge follows the delivery zone.
5. **Queue** lists orders nobody has taken yet. **Claim** one to make it yours.
6. On an open order, **Record advance** records money a buyer paid ahead by bKash, Nagad
   or bank. Use a made-up transaction ID. Accounts must then check it (section 6).
7. **Customers** lists buyers with their orders, deliveries and lifetime value.
8. **Cancel order** on an order that is not shipped asks for a reason and gives the stock
   back.

Sign in as **Warehouse** for the next part.

9. **Invoice** and **Label** on an order produce a printable PDF.

10. An order's page shows only the next steps allowed for it: **Confirm**, **Mark packed**,
    **Hand to courier**, **Mark delivered**, **Partial delivery**, **Start return**,
    **Receive return**, **Hold**, **Release hold** and **Cancel**. Steps that need a reason
    or an amount open a small form first.
11. The **Parcel** panel on a packed order books it with a courier (the demo uses "Demo
    Courier"), shows its status and confirms the handover. Confirming the handover ships the
    order. When the courier later reports the parcel picked up or delivered, the order moves
    on by itself.
12. In **Orders**, tick several orders to **Pack** them or **Hand to courier** in one go.

## 2. Couriers and cash on delivery

Sign in as **Accounts** (or Warehouse for the first two items).

1. **Couriers → Parcels**: every parcel, its courier status and the money to collect.
2. **Stuck parcels**: parcels with no news for several days. The demo parcels are fresh,
   so this list fills by itself over the coming days.
3. **Settlements**: a courier's statement of the cash it collected. One Demo Courier
   statement is already imported and approved. Open it to see which parcels it paid for.
4. **Courier performance**: delivery and return rates per courier and zone.
5. **Returns to receive**: parcels on their way back to the warehouse.

## 3. Products and stock

Sign in as **Org admin** for products, **Warehouse** for stock.

1. **Catalog** lists the products. Open one to see its sizes, each with its own code and
   price. **New product** creates one; **Categories and attributes** holds the sizes and
   categories.
2. **Stock** shows how many of each item are in the warehouse and the showroom, and how
   many are held for orders.
3. **Stock → Transfers**: one transfer sent the showroom its opening stock. Make one:
   - choose from where to where and the items;
   - press **Dispatch**;
   - sign in as **Branch manager** and **Receive** it at the showroom.
4. **Stock → Adjustments**: report damaged or found stock. It is sent for approval before
   it changes anything. One write-off (a torn T-shirt) is waiting for the org admin.
5. **Stock counts**: count a shelf and compare it with the system.

## 4. Suppliers and purchases

Sign in as **Accounts**.

1. **Supply** lists the suppliers and what the brand owes each one.
2. **Supply entries** shows the purchases. **New supply entry** records goods received with
   their prices. It adds the stock and the money owed at once.
3. **Payments**: one payment to Demo Textile Mills went through. One to Demo Stitching
   House is waiting for a second person to approve (section 7).

Warehouse staff record a **receipt draft** with quantities only; accounts then adds the
prices.

## 5. Marketing and promotions

Sign in as **Marketing**.

1. **Marketing**: the dashboard of campaigns, ad spend, and the orders and revenue each
   campaign brought.
2. **Campaigns**: "Eid Festive Collection" and "Winter Preview", with daily ad spend.
   **Add campaign** creates one; type in a day's spend from your ads manager.
3. **Leads**: people who asked about a product. Change a lead's status as you follow up.
4. **Promo codes**: **EID10** is live. **New code** creates another: a percentage, a flat
   amount or free delivery, with limits and dates.
5. **Message templates**: the birthday offer and the loan reminder texts, in Bangla and
   English. No SMS leaves the preview; messages go to a stand-in.

## 6. Money: wallets, cash and statements

Sign in as **Accounts**.

1. **Accounts** shows every wallet (bank, bKash, office cash, showroom cash) and its
   balance. Click one for its cash book: every movement in and out.
2. **Record cash**: money in (for example scrap sold), money out (a bill) or petty cash.
   Petty cash needs a photo or PDF of the receipt and waits for approval.
3. **Transfers** moves money between wallets, for example bank to office cash.
4. **Statements**: the profit and loss and the balance sheet. They always balance.
5. **Ledger** shows every posting, for an accountant.
6. **Advances to check**: the bKash advance on Demo Buyer Habib's order is waiting.
   - Check it and press **Verify**, choosing the bKash wallet. This lowers what the
     courier collects.
   - Or reject it.
     The person who recorded an advance cannot check it.
7. **Periods**: close a finished month so nothing can be posted into it any more.

## 7. Approvals: the second pair of eyes

Sign in as **Org admin** (or **Super admin**).

**Approvals** lists everything that needs a second person.

1. Open **September payroll** and **Approve** it. HR can then pay it.
2. Approve or **Reject** the **stock write-off** and the **supplier payment**.

Nobody can approve their own request. That is deliberate, and the screen will say so if
you try.

## 8. Showroom and the till

Open the **till** at https://elyerp.enfinito.cloud/pos/ and sign in as **Branch manager**.

1. Choose the register **Dhanmondi till 1**.
2. **Open a shift**: count the cash in the drawer (type 5000) and press **Open shift**.
3. **Ring up a sale.**
   - In **Scan or type a code**, type `2000000000102` (Classic Cotton Tee, size M) and
     press Enter.
   - Add more items if you like, then **Pay**.
   - Choose cash, bKash or card, or split between them.
4. At the end, **Close the shift**: count the drawer. The screen shows what it expected and
   any difference.
5. The till keeps working with no internet. Sales made offline are sent when the connection
   returns.

In the **console** as **Branch manager** or **Org admin**, **Branches** shows each
showroom's sales and shifts. **Close the day** counts the showroom's cash once all shifts
are closed.

## 9. People, payroll and targets

Sign in as **HR**.

1. **People**: six employees, four of them linked to a sign-in. **Add an employee**
   creates one. National ID and phone are optional and are stored encrypted.
2. **Attendance**: last month's absences, late days and leave. Mark a day for someone.
   Days with nothing recorded count as present.
3. **Payroll**:
   - August is paid, and September is waiting for approval (section 7).
   - Open a run to see each person's payslip.
   - **Start a run** for a month, add a bonus, then **Send for approval**. A different
     person approves it, then **Pay** it from a wallet.
4. **Staff loans**: one employee has an advance being repaid from their salary.
5. **Performance → Targets**: the sales agent has this month's targets for confirmed
   orders and delivered revenue. **Bonus rules** shows the approved "Desk confirmations"
   rule.

Sign in as **Sales agent** and open **Performance** to see the agent's own progress
against the target.

## 10. Investors and loans

Sign in as **Accounts**.

1. **Investors**: two investors, their capital, last month's profit share and an agreement
   document.
2. A **withdrawal request** from Preview Investor is waiting.
   - **Review** it as Accounts.
   - A different person (the org admin) approves it under **Approvals**.
   - Accounts then presses **Pay**.
3. **Company loans**: a bank loan from Demo Bank Ltd with its instalment schedule. The
   first instalment is paid.

Then open the **investor portal** at https://elyerp.enfinito.cloud/portal/ and sign in as
**Investor** (two-step login, as above).
The investor sees:

- their position;
- the profit share;
- the withdrawal;
- the capital they put in;
- the agreement, which they can download.

They see nothing else of the business.

## 11. Order tracking (what a buyer sees)

Open https://elyerp.enfinito.cloud/portal/track/elysium-lifestyle-bd. You need no sign-in.
Type the order number and the four phone digits that the credentials file gives, then
press **Track**.
The buyer sees where the parcel is, in Bangla or English, and nothing else about the
order.

## 12. Dashboards and the whole group

1. As **Org admin**, **Analytics** shows the brand's orders, delivered revenue, profit,
   return rate, ad spend and return on ad spend for any dates. **Leaderboard** ranks the
   five brands for a month. **Export CSV** and **Export XLSX** download the figures.
2. As **Super admin**, switch brands with the brand name at the top left. **Analytics → All
   brands** and **Accounts → All brands** show the five brands side by side. Only the
   other brands' set-up is filled in. The demo work is all in Elysium Lifestyle BD.

## Not on screen yet

**Settings** is live: sign in as **Org admin** to see its five tabs (approval limits,
delivery zones, courier accounts, website order keys and showroom tills).

These work behind the scenes but have no screen yet. They are arriving with the next update:

- inviting staff and changing their roles (the sign-ins you were given were made for you);
- the page a new staff member opens from their invitation;
- password and two-step login resets for staff;
- **Audit log**, which shows "coming soon". **Resellers** is set aside for now.
