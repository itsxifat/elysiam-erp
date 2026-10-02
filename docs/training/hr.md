# HR guide

For the people team. You keep staff records and salaries, record attendance, prepare the
monthly payroll, record staff loans and set sales targets and bonus rules. Each payroll run
and each bonus rule is approved by a second person before it counts.

To practise on the preview, see the testing guide,
[section 9](../testing-guide.md#9-people-payroll-and-targets). Sign-in help is in the
[README](README.md).

## Your screens

**People** (with **Attendance**), **Payroll** (with **Staff loans**), **Performance** and
**Approvals**.

## Add an employee

1. **People** → **Add an employee**. Fill in the **Employee code**, **Full name**,
   **Designation** and **Join date**.
2. Choose **Paid by** (cash, bank, bKash or Nagad) and, if not cash, the
   **Account or wallet number**. The **National ID number** and **Phone number** are optional.
   These three are stored encrypted, and only their last digits are shown again.
3. Under **Salary**, set the **Basic salary** and any allowance, with **Applies from**. A raise
   is a new version with a later date; past payslips keep the figures they were paid on.

## Attendance

1. **People** → **Attendance**, choose the month.
2. Mark a day for someone with **Record this day**: present, late, half day, absent, paid or
   unpaid leave, weekly off or holiday.
3. Or **Import from the device**: paste the CSV, say which column is which, press
   **Check the file**, then **Apply to the month**.

## Monthly payroll

1. **Payroll** → **Start a run** for the month.
2. Open the run. Under **Bonuses and one-off deductions**, **Add** any. **Target bonuses** →
   **Apply bonus rules** adds the bonuses earned on targets.
3. Read **Before you send this**, then press **Send for approval**.
4. Someone else approves it in **Approvals**: an org admin or another HR user. Never you.
5. Once approved, press **Pay** and choose the wallet in **Pay from**. Accounts can also pay
   it. Each person's **Payslip PDF** is then on the run.

## Staff loans

1. **Payroll** → **Staff loans** → **Record a loan**: the employee, the **Amount**, the number
   of **Instalments** and the **First instalment** month.
2. Someone else presses **Pay out**: accounts, an org admin or another HR user. Instalments
   then come out of the payslip by themselves.

The rules, which the system enforces:

- Nobody records a staff loan to themselves.
- Nobody pays out a loan they recorded, or a loan to themselves.
- Nobody changes their own payout account. A second person does.

## Changes only HR makes

A branch manager may add showroom staff (paid in cash) and keep their record, but only HR or
an org admin changes a payout method or account, the login linked to an employee, or brings
back someone who left.

- **Add an employee** has a **Branch** field. Choose the showroom for showroom staff, so
  that branch's manager sees them; leave **No branch** for head-office staff.
- **Edit** on a row changes the name, designation, department, branch, status and leaving
  date, and the payout method and account, phone, national ID and **Linked sign-in**. Only
  what you change is saved. The account number, phone and national ID are never shown back:
  leave them empty to keep what is on file.
- **Linked sign-in** lists the brand's people by name and a shortened email. One already
  linked to someone else is shown but cannot be chosen.

The linked login matters: it lets an agent see their own targets, and it lets the system stop
someone paying a loan to themselves. Nobody changes the link or the payout account on their
own record: a second person in HR does.

## Targets and bonus rules

- **Performance** → **Targets** → **Set target**: a person, a month, a measure (confirmed
  orders, delivered orders or delivered revenue) and the target. **Recompute progress**
  refreshes the figures.
- **Bonus rules** → **Add rule** or **Add version**, **Preview**, then **Send for approval**.
  A second person approves it before payroll can use it.
- **Productivity** shows pickup times and orders handled per active hour.

## Approvals you decide

In **Approvals** you decide payroll runs and bonus rules that someone else raised. Nothing
else, and never your own.

## If something goes wrong

- Ask your org admin about access, approvals and record changes with no screen.
- Payroll figures look wrong: do not send the run. Close it with **Close this run** and start
  again, or ask the accountant.
- Never share your password, a code, or an invite or reset link. Staff ID and account numbers
  never go into chat or email.
- If you lose your phone, tell your org admin at once. Your reset needs a second admin.
