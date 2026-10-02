# Month-end close

Closing a brand's month so nothing more posts into it (architecture §7; D-081, D-093). One
brand at a time; each brand's accounts user (or org admin) runs it in the first days of the
next month. Business dates are Asia/Dhaka (invariant 8).

## Rules the system enforces

- A month can be closed only once it has ended in Dhaka, by `org_admin` or `accounts`
  (**Accounts → Periods**, `/accounts/periods`).
- Closing a month locks every date before it too (D-093).
- A closed month takes no new journal. A courier settlement dated in it posts to the
  earliest open month and keeps its own date as a reference (D-037).
- Reopening is a `period_reopen` approval that only a super admin can decide, never
  auto-approved (D-071), and only the latest closed month can be reopened (`PERIOD_LATER_CLOSED`).
  Prefer a correcting entry in the open month to a reopen.

## Before closing: the checklist

Work through it for the month being closed, in this order. Each item is a screen that
already exists; nothing here edits the books by hand (invariant 2).

1. **Orders.** No order of the month stuck in a non-final state that should have moved:
   **Courier → Stuck** re-poll; returns received (**Courier → Returns**).
2. **Courier settlements.** Every statement for the month fetched or uploaded and approved
   (**Courier → Settlements**); exceptions resolved. The COD reconciliation report
   (`GET /v1/courier/reports/cod-reconciliation`) shows no unexplained difference.
3. **Wallets and cash.** Each wallet's cash book (**Accounts → Wallets**) agrees with the
   bank and bKash statements and the counted hand cash. Transfers between wallets recorded
   (**Accounts → Transfers**).
4. **Showrooms.** Every till closing of the month posted (**Branches → a branch**); closing
   variances decided in **Approvals**.
5. **Stock.** The nightly reconciliation reported no drift for the month (it alerts on any;
   `monitoring.md`). Any count session of the month submitted and closed
   (**Stock → Counts**); adjustments approved.
6. **Purchasing.** Goods received are entered with their bills; supplier payments recorded.
7. **Payroll.** The month's payroll run approved and posted (**Payroll**).
8. **Investors and advances.** Any profit declaration and withdrawal for the month decided.
9. **Approvals.** Nothing for the month left pending (**Approvals**).
10. **Reports.** Trial balance, profit and loss and balance sheet for the month
    (**Accounts → Reports**). The trial balance balances; the numbers make sense against
    last month. Export them for the accountant.

## Close

**Accounts → Periods** → the month → **Close**. From that moment a posting dated in the
month is refused (`PERIOD_CLOSED`).

Record it:

| Brand | Month | Closed on | Trial balance exported | Accountant reviewed | By  |
| ----- | ----- | --------- | ---------------------- | ------------------- | --- |
|       |       |           |                        |                     |     |

## A mistake found after closing

1. Prefer a correcting entry in the open month (a reversal through the flow that made the
   original, or an adjustment), with a note naming the closed month.
2. If the closed month must change, **Accounts → Periods** → **Ask to reopen**, with the
   reason. A super admin decides it in **Approvals**. Reopen, correct, close again, and
   re-export the reports.
