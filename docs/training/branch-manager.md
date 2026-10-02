# Branch manager guide

For showroom managers. You run the till, close each shift and each day, keep the branch's
cash honest, and look after the showroom's stock and staff. You see your own branch, not the
others.

To practise on the preview, see the testing guide,
[section 8](../testing-guide.md#8-showroom-and-the-till). Sign-in help is in the
[README](README.md).

## Your screens

- **The till** (its own address, on the showroom computer).
- In the console: **Orders** and **Customers** for your branch, **Catalog**, **Stock**,
  **Accounts** (your branch's wallets), **Branches**, **Approvals**, **People** (your branch's
  staff), **Performance** and **Settings** → **Till registers**.

## Start of the day at the till

Signing in and opening a shift need an internet connection.

1. Open the till and sign in. Choose the brand if asked.
2. **Choose this till's register**. The till remembers it.
3. **Open a shift**: count the drawer, type it in **Opening cash** and press **Open shift**.

## Sell

1. Scan the barcode, or type the code in **Scan or type a code** and press Enter.
2. Change quantities with **One more** and **One fewer**; **Remove line** drops one.
3. To discount a line, press **F4**. Enter a **Percent** or an **Amount (taka)** and press
   **Apply discount**.
4. Press **Pay** (**F2**). Take cash, bKash or card, or split between them. For cash, type
   **Cash handed over**; the **Change** shows. Press **Complete sale**.
5. **Print receipt**, then **New sale**.

**Your discount limit at the till is 20% of a line.** You may type more, but the sale is then
held for review and does not count until someone whose limit covers it (an org admin) posts
it. Promo codes are not available at the till yet.

**Returns and exchanges:** **Returns** → type the **Receipt number** → **Find receipt**
(needs a connection). Choose what comes back and **Refund by**, then **Refund and return**, or
**Refund and start exchange** to sell the replacement.

## When the internet is down

- The status shows **Offline — sales are kept on this till**. Keep selling. Sales are saved
  on this computer, in this browser.
- When the connection returns, they are sent by themselves. **Queue** shows each sale as
  **Waiting**, **Synced** or **Needs attention**. Press **Sync now** to send at once, or
  **Send again** on one that failed.
- Do not clear the browser's data, use a private window, or switch computers while sales are
  waiting. They exist only on this till until they sync.
- If the till shows **Signed out — sign in to send waiting sales**, sign in again when you
  have a connection.

## Close the shift and the day

1. At the till, **Close shift**: count the drawer and type **Counted cash**. The screen shows
   what it expected and the difference. Press **Close shift**. If sales are still waiting to
   sync, sync them first.
2. In the console, **Branches** → **Open dashboard** for your branch → **Held for review**.
   For each item, press **Post** or **Void** with a note. You cannot resolve a sale you rang
   up, or a discount above your own limit; ask someone else.
3. **Close the day**: count each till wallet, type the **Counted** amount and press
   **Close the day**. This needs every shift closed and every held sale resolved. A
   difference goes to a checker, never to you.

## Branch cash

**Accounts** → **Record cash** on your branch's wallet. A **Cash out** or **Petty cash** from
your branch needs a receipt photo (**Attach the receipt**). At or above the brand's
threshold it waits for an org admin, and shows in **Approvals** as petty cash. **Count a
drawer** records a counted wallet outside the till.

You may move money between your branch's wallets with **Transfers**, but not record a transfer
charge (accounts does that from the bank's statement), and you cannot switch off a wallet's
daily count. If you mark an order delivered short, the same limits as at the order desk
apply: a reason, and at most 20% of the cash to collect.

## Showroom staff

- **People** lists your branch's staff. **Attendance**: mark a day for someone with
  **Record this day**.
- Your role may keep a staffer's showroom record, but not their payout method or account,
  their linked login, or bringing back someone who left. HR does those.
- Ask HR to add new showroom staff. The **Add an employee** form has no branch field yet, so
  it cannot place someone in your branch.

## Stock and approvals

- **Stock** → **Transfers**: press **Receive** when a transfer arrives at your showroom.
- **Adjustments** and **Stock counts** work as in the [warehouse guide](warehouse.md#stock).
- In **Approvals** you decide stock write-offs, stock gains and closing differences for your
  branch, under the brand's threshold, that someone else raised. Larger ones go to an org
  admin.
- Orders you take on the order desk follow the same 20% limit as sales agents
  ([sales agent guide](sales-agent.md#your-discount-limit)).

## If something goes wrong

- The till will not sync, a sale shows **Needs attention**, or the drawer is short: tell your
  org admin the same day.
- Ask your org admin about access, larger discounts and approvals.
- Never share your password, a code, or an invite or reset link. Never let anyone sell under
  your sign-in.
- If you lose your phone, tell your org admin at once. Your reset needs a second admin.
