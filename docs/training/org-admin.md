# Org admin guide

For each brand's administrator. You decide who can sign in and what they may do, keep the
brand's settings, approve what others raise, and look after the catalogue and the dashboards.
Your role must use two-step sign-in (see the [README](README.md)). The super admin works the
same way in every brand.

To practise on the preview, see the testing guide, sections
[3](../testing-guide.md#3-products-and-stock),
[7](../testing-guide.md#7-approvals-the-second-pair-of-eyes) and
[12](../testing-guide.md#12-dashboards-and-the-whole-group).

## Your screens

Almost everything in the brand, plus **Staff**, **Settings** and **Analytics**. **Catalog**
holds **New product**, **Categories and attributes** and **Import prices**. **Analytics** has
the brand dashboard, the **Leaderboard**, and **Export CSV** and **Export XLSX**.

## Invite someone

1. **Staff** → **Invite someone**.
2. Type their **Email** and **Full name**, and choose the **Role**. A branch manager needs at
   least one branch ticked. Press **Invite**.
3. **Give them this link** appears. Press **Copy link** and send it yourself, to that person
   only, by a channel only they read. It works once, for three days.
4. If they have ever worked for another brand in the ERP, you cannot add them: the screen
   says a super admin adds them here. Ask the super admin. They are added with the same
   sign-in, so they keep one password for both brands.

They show as **Invited** until they set a password. If the link is lost, open **Manage** and
press **Send a new invite link**.

## Change someone's access

- **Manage** → tick the **Roles**, use **Limit to branches** where needed, then
  **Save roles**. It applies on their next click; nobody needs to sign in again.
- **Deactivate**, with a reason, for someone who leaves. Their roles here end and they are
  signed out at once. Everything they recorded stays.
- You cannot change your own access. Only a super admin changes a super admin.

## Reset a password or a lost phone

1. **Manage** → **Reset password** (a link that works once, for one hour) or
   **Reset two-step verification** (they set it up again at the next sign-in). Give a
   **Reason**; it is recorded and shown to the approver.
2. For anyone who can raise or approve requests (org admins, accounts, HR, branch managers,
   warehouse) and for investors, the reset waits under **Sign-in resets waiting** for another
   org admin to **Approve**.
3. Once approved, the admin who asked presses **Get the link** and passes it on within 24
   hours.

Nobody decides a reset they asked for or a reset of themselves. Someone who also works in
another brand can only be reset by a super admin.

## Settings

1. **Approval thresholds**: for each request type, type an amount in taka and press **Set**.
   A request under it is approved at once; at or above it, a second person decides. With no
   threshold, every request waits. Lowering one applies now. Raising one, or setting the
   first, waits for another org admin. Some types are always decided by a second person.
2. **Delivery zones**: **Add zone** or **Edit**: a code, the English and Bangla names, the
   **Charge** and the default courier. The order desk prices deliveries from these.
3. **Courier accounts**: **Set up a courier**: label, adapter, **Sandbox** or **Live**, the API
   keys, the webhook secret, the settlement wallet and **Active**. Keys are stored encrypted and
   never shown again; leave a key blank to keep the saved one. An adapter marked
   **Unverified** cannot be activated until the installation turns it on.
4. **Website order keys**: **Issue a key**, then copy the secret: it is shown only once.
   **Revoke** a key when a site is retired or its secret leaks.
5. **Till registers**: **Add register** with the branch, a code such as `T1`, a name, the shelf
   it sells from and the branch's hand-cash wallet (bKash and card wallets are optional).
   **Activate** or **Deactivate** a till.

## Approvals as checker

**Approvals** lists everything waiting for a second person. Open each one, check it, then
**Approve** or **Reject**.

- You decide every type except reopening a closed month, which only a super admin decides.
- You never decide your own request, or one raised by whoever gave you your role, directly
  or further up.
- A branch manager's cash out shows as **Petty cash**. Check the receipt photo.

## Discounts

Sales agents and branch managers may price an order at most 20% below the catalogue. You may
go further. When an agent asks, take the order yourself on the order desk. At the till, a
sale above the seller's limit waits in **Branches** → **Held for review** for you to
**Post** or **Void**.

## Deleting and archiving

Anything nobody has used yet can be deleted for good: a category, a size or colour, a product
or variant added by mistake, a stock location, a supplier, a discount, a flash sale, an SMS
template, an ad campaign or a size chart. Anything that stock, orders, the till, supply or the
books already use is **archived** instead: it is hidden from new work and stays wherever it
was used, and you can restore it.

1. Press the bin button beside the row (on **Catalog** → **Categories and attributes**,
   **Website** → **Size charts**, **Campaigns**, **Marketing** → **Campaigns** or **Supply**).
2. The window first checks what uses it and lists it in plain words, with counts.
3. It offers only what works:
   - **Delete for good** when nothing uses it.
   - **Empty and delete** for a category or a size chart: choose where its products go (or
     none). A category's subcategories move up one level and its menu entries follow the
     products. Product codes already printed keep their old category letters.
   - **Archive** when something uses it. For a size or a colour, tick **Also archive its variants**
     to stop selling them in one step.
   - **Restore** when it is archived. A restored discount comes back paused: switch it on when
     you are ready.
4. If something started using it while the window was open, it says so and shows the new list.

- A category or discount that a live discount names cannot be deleted. Archive the discount
  first. Discounts are never changed after they are made.
- An archived category's products leave the website until you move them or restore it.
- **Branches** are never deleted. **Branches** → the gear button renames one, or switches it off
  once nothing runs there (no till switched on, no open shift, no money in its wallets, no staff,
  no stock). A switched-off branch opens no new till and no shift until you switch it back on.
- A supplier with an opening balance in the books stays; deactivate it instead.
- **Expense and income heads** are on **Accounts** → **Wallets**. Add your own, rename or archive
  them. They are never deleted, so the books keep every entry against them.
- Every delete is recorded with what was deleted.

## Permissions that surprise people

- **Accounts cannot decide petty cash or closing differences.** They come to you (small
  showroom differences can also go to the branch manager).
- **You cannot add wallets or verify advances.** Accounts does both: **Accounts** →
  **Wallets** → **Add wallet**, and **Accounts** → **Advances**.
- **Warehouse staff can open the supply page `/supply/entries`** though it is not in their
  menu. They choose the supplier there and enter what arrived; accounts prices it.
- **A branch manager's cash out** from a branch wallet needs a receipt photo and, at or above
  the threshold, your approval.
- **Self-dealing is refused.** Nobody records a staff loan to themselves, pays out a loan they
  recorded, or changes their own payout account. A branch manager keeps showroom records, but
  payout details, linked logins and bringing back leavers are HR's.
- **Investors:** you read them and approve distributions and withdrawals. Accounts adds
  investors, links each one's **Portal sign-in**, and records, reviews and pays withdrawals.
- **Approval limits count the day.** A supplier payment, petty cash or a branch cash out is
  compared with the same person's total for the day (supplier payments: to any supplier).
  Paying one bill in small pieces does not get round the limit.

## Not on screen yet

- **Audit log** is a placeholder. **Resellers** is out of scope.
- Uploading a courier's statement (statements are fetched only), the thana list on a delivery
  zone, adding a new courier company for the brand, and an exchange from the order page.

## If something goes wrong

- Ask the super admin or ERP support.
- If you think someone else is using an account, **Deactivate** it at once, then find out.
- Never share your password, a code or a recovery code. Send each invite or reset link to its
  person alone, never to a group chat.
- If you lose your phone, tell another org admin or the super admin at once. Your reset needs
  a second admin.
