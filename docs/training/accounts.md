# Accounts guide

For the finance team. You keep the brand's wallets and cash, record purchases and supplier
payments, check advance payments, reconcile courier cash, close each month, and handle
investors and company loans. Your role must use two-step sign-in (see the
[README](README.md)).

To practise on the preview, see the testing guide, sections
[2](../testing-guide.md#2-couriers-and-cash-on-delivery),
[4](../testing-guide.md#4-suppliers-and-purchases),
[6](../testing-guide.md#6-money-wallets-cash-and-statements) and
[10](../testing-guide.md#10-investors-and-loans). The month-end steps are in
[month-end-close.md](../runbooks/month-end-close.md).

## Your screens

**Accounts**, **Supply**, **Couriers**, **Investors**, **Company loans**, **Approvals**,
**Payroll**, **People** (read only), **Branches**, **Marketing** (ad spend only) and
**Settings** (courier accounts and till registers). You also read orders, buyers and stock.

## Cash, every day

1. **Accounts** → **Wallets and cash** → **Record cash**. Choose **Cash in**, **Cash out** or
   **Petty cash**, the wallet, the category and the amount, then **Record**.
2. **Petty cash** needs a receipt photo (**Attach the receipt**). It waits for a checker when
   it is at or above the brand's threshold.
3. **Count a drawer** records the counted cash in a wallet. A difference goes to a checker
   before it posts.
4. **Transfers** moves money between two wallets, for example bank to office cash. Add the
   **Bank charge** if there was one.
5. **Wallets** → **Add wallet** sets up a bank account, bKash or a hand-cash drawer. Only
   accounts can add one; an org admin cannot.

## Advances paid by buyers

1. **Accounts** → **Advances** → **To verify** lists the advances agents recorded.
2. Check the money is in the wallet. Press **Verify** and choose **Wallet it arrived in**, or
   **Reject** with the reason. Verifying lowers what the courier collects.
3. **To refund** lists advances owed back. Send the money, then press **Record refund**.

You cannot verify an advance you recorded yourself. A wrong match is undone on the order with
**Undo verification**.

## Suppliers and purchases

1. **Supply** → **Suppliers** → **New supplier**.
2. **Supply entries** → fill in the supplier, location, invoice number and each line's
   quantity and **Unit cost**, then **Price and receive**. Stock and the amount owed update at
   once.
3. **Returns** → **New return** sends goods back to a supplier.
4. **Payments** → **Record payment**. At or above the threshold it waits for a checker.

## Courier cash

1. **Couriers** → **Settlements** → **Fetch from courier** brings in the courier's
   statements. **Open** one to see which parcels it pays for and its **Exceptions**.
2. Press **Request approval** to post it, or **Reject** with the reason.
3. **Stuck parcels** shows parcels with no news. This is where cash on delivery goes missing.

There is no upload screen for a courier's statement yet. Fetching works once the brand's
courier connection has been verified and switched on.

## Month end

1. **Statements**: profit and loss, the balance sheet and aging.
2. **Ledger**: the trial balance, the day book and any account's lines.
3. **Periods** → choose the month → **Close month**. Nothing can then be posted into it. To
   change a closed month, press **Request reopen** with the reason. Only a super admin decides.

## Investors, loans and payroll

- **Investors**: **Add investor**, **Record capital**, **Declare distribution** (an org admin
  approves it). A withdrawal takes three people: one presses **Request withdrawal**, a second
  accounts user presses **Review** and names the account, and a third person (an org admin or
  another accounts user) approves it in **Approvals**. Then press **Pay**.
- **Company loans**: **Add a lender**, **Record a loan**, then **Pay instalment**. A large
  instalment waits for a checker.
- **Payroll**: once a run is approved, open it and press **Pay**, choosing **Pay from**.
  **Staff loans** → **Pay out** a loan HR recorded. You never pay out a loan you recorded, or
  one to yourself.
- **Marketing** → **Spend**: type in a day's ad spend from the ads manager.

## Approvals you decide

In **Approvals** you decide supplier payments, courier settlements, investor withdrawals and
loan repayments that someone else raised. You never decide your own.

You do **not** decide petty cash or closing differences. Those go to an org admin (or, for
small showroom differences, the branch manager).

## If something goes wrong

- Ask your org admin about access and approvals. Ask the client's accountant about postings.
- A posted entry is never edited or deleted. If one is wrong, do not balance it out with an
  invented entry. Ask your org admin and the accountant how to correct it.
- Never share your password, a code, a recovery code, or an invite or reset link.
- If you lose your phone, tell your org admin at once. Your reset needs a second admin.
