# Warehouse guide

For the people who pack orders, book parcels, hand them to couriers, receive returns and keep
the stock right. You see every order in the brand, but you do not take new orders.

To practise on the preview, see the testing guide, sections
[1](../testing-guide.md#1-orders-and-buyers) (steps 9 to 12),
[2](../testing-guide.md#2-couriers-and-cash-on-delivery) and
[3](../testing-guide.md#3-products-and-stock). Sign-in help is in the [README](README.md).

## Your screens

**Orders**, **Couriers** (**Parcels**, **Stuck parcels**, **Returns**), **Stock**, **Catalog**
and **People** (your own record).

## Pack

1. Open **Orders** → **All orders** and set the status filter to **Confirmed**.
2. Tick the orders to pack. Press **Print invoices** and **Print labels**.
3. Pack the boxes, then press **Pack selected**. For one order, open it and press
   **Mark packed**.

## Book the parcel and hand it over

1. Open a packed order. In the **Parcel** panel press **Book with courier**. The booking is
   queued; the consignment and tracking appear when the courier answers.
2. **Couriers** → **Parcels**: tick booked parcels and press **Print labels** for 4 × 6
   labels.
3. When the rider takes the box, press **Confirm handover** in the order's **Parcel** panel.
   This ships the order: the units leave stock and the books record it. A handover can only be
   dated today or yesterday.
4. For many boxes at once, tick them in **All orders** and press **Hand selected to courier**.
   **Hand to courier** on one order also takes an optional consignment number.

After that the courier's updates move the order to delivered or returned by themselves. Use
**Mark delivered** or **Partial delivery** only when the courier has not reported it. Type the
amount the rider collected, and say why if it differs from the cash to collect.

## Chase stuck parcels

**Couriers** → **Stuck parcels** lists parcels with no news for some days, unclear courier
statuses and failed bookings.

- **Ask the courier again** asks the courier for fresh news.
- **Export for the courier** gives a list to send them.
- **Add note** records what you did or were told. Notes cannot be edited later.

## Receive returns

1. **Couriers** → **Returns** lists parcels on their way back. Press **Receive** when one
   arrives. (On the order, **Receive return** does the same.)
2. For each line, count the **Sellable** and the **Damaged** units. If anything is damaged,
   choose the **Damaged location**.
3. Choose the **Return reason**, add an **Inspection note**, and save.

Sellable units go back on the shelf. Damaged units go to the damaged location. Writing them
off is a separate request that someone else approves.

## Stock

- **Stock levels**: on hand, held for orders and available, per location.
- **Transfers** → **New transfer**: choose from where to where and the items, then
  **Dispatch**. The stock is in transit until the other end presses **Receive**.
- **Adjustments**: choose **Write-off** or **Gain**, the location, the item, the quantity and
  the reason, then **Send for approval**. Nothing moves until an org admin approves.
- **Stock counts** → **Start a count**. Type what you count, press **Finish counting**, then
  **Send differences for approval**.

## Goods from a supplier

The receipt draft screen is not in your menu. It is at `/supply/entries` on the console
address, and the page is open to your role. Today its supplier list is empty for your role,
so a draft cannot be finished there. Until that is fixed, give accounts the supplier, the
invoice number, and each item and quantity that arrived. Accounts records the supply entry.

## If something goes wrong

- Ask your org admin about access, stock that does not match and approvals that wait too long.
- A parcel the courier lost or damaged: add a note on it in **Stuck parcels** and tell your
  org admin.
- Never share your password, a code, or an invite or reset link.
- If you lose your phone, tell your org admin at once. Your reset needs a second admin.
