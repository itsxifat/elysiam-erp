# Training guides

Short guides for the people who use the ERP every day. Each one lists what your role can do,
where to click and who to ask when something goes wrong. For a guided tour of every screen
with demo data to practise on, see the owner's [testing guide](../testing-guide.md). The
role guides link to its sections rather than repeat them.

## Which guide is yours

| Guide                                                   | For                                                                     | Where you work   |
| ------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------- |
| [Sales agent](sales-agent.md)                           | Order desk staff who take, confirm and follow orders                    | Console          |
| [Accounts](accounts.md)                                 | The finance team: cash, suppliers, courier money, investors, loans      | Console          |
| [Warehouse](warehouse.md)                               | Packing, parcels, handing over to couriers, returns and stock           | Console          |
| [Branch manager](branch-manager.md)                     | Showroom managers: the till, the day's cash, showroom staff             | Till and console |
| [HR](hr.md)                                             | Staff records, attendance, payroll, staff loans and targets             | Console          |
| [Org admin](org-admin.md)                               | Each brand's administrator: staff accounts, settings and approvals      | Console          |
| [Stickers and scanning](stickers-and-scanning.md)       | Adding products and stock in hand, barcode stickers, the scanner        | Console          |
| [Prices and buying prices](prices-and-buying-prices.md) | Prices by size and colour, bulk price changes, buying prices and margin | Console          |
| [The packing station](packing-station.md)               | Scanning each piece against the order, the packing video                | Console          |

- A **super admin** works like an org admin in every brand and also sees the group views.
  Read the org admin guide.
- **Marketing** has no guide yet. See the testing guide,
  [section 5](../testing-guide.md#5-marketing-and-promotions).
- **Investors** use the investor portal. They need only the sign-in steps below.

## Sign in for the first time

Nobody can sign up on their own. An org admin invites you from the Staff screen.

1. The admin gives you a link that ends in `/accept-invite#token=…`. It works once, for three
   days. Open the whole link.
2. On **Set your password**, choose a password of at least 12 characters. A short sentence is
   easier to remember than a jumble. Type it again in **Type it again** and press
   **Set password**.
3. Press **Go to sign in** and sign in with your email and the new password. Staff sign in to
   the console, showrooms to the till, and investors to the investor portal.

If the page says the link has expired or was already used, ask the admin for a new one.

## Two-step sign-in

Org admins, accounts, investors and super admins must use two-step sign-in, unless the brand's
super admin changes the list (**Settings** → **Security**): they can require it for other roles
too, such as sales. Super admins always use it. The first time you sign in, or at your next
click after your role is added to the list, **Set up two-step verification** appears. It takes
about a minute.

1. Install an authenticator app on your phone, such as Google Authenticator or Microsoft
   Authenticator.
2. In the app choose to add an account and scan the QR code on the screen. If the camera will
   not read it, use the **Setup key** in the grey box instead: press **Copy**, or read it out.
3. The screen shows your **Recovery codes**. Press **Download codes** and keep the file
   somewhere safe that is not your phone. They are shown once only. Tick
   **I have saved my recovery codes**.
4. Type the 6-digit code the app shows and press **Confirm and continue**.

From then on every sign-in asks for the current 6-digit code. Codes change every 30 seconds.
If your phone is not with you, press **Use a recovery code instead**. Each recovery code works
once. If the screen says "Too many attempts", wait a minute and try again. After ten wrong codes
in a row two-step sign-in locks for a quarter of an hour.

Anyone else may switch it on for themselves too, from **My account** (below).

## Your account

The round button with your initials at the top right opens your account menu. **My account**
there holds everything about your own sign-in:

- **Profile**: change the **Name** colleagues see and press **Save name**. Your email is how
  you sign in and is not changed here.
- **Password**: type your **Current password**, the **New password** (at least 12 characters)
  and the same again, and press **Change password**. Leave **Sign out my other devices** ticked
  if anyone else might be signed in as you.
- **Two-step sign-in**: whether it is on, whether your role requires it, when you set it up and
  how many recovery codes are left.
  - **Set up two-step sign-in** if it is off.
  - **Set up on a new phone** when you change phones: enter your password and a code from the
    old phone (or a recovery code), scan the new QR code with the new phone and type its code.
    The old phone keeps working until you finish, and stops after.
  - **New recovery codes** makes ten new ones; the old ones stop working. Copy, download or
    print them, and keep them away from your phone.
  - **Turn off** needs your password and a current code. It is greyed out, with the reason
    beside it, when your role requires two-step sign-in or you are a super admin.
- **Devices**: every phone and computer signed in as you, with the browser, the address (its
  last part hidden), when it signed in and when it was last used. **Sign out** ends one; **Sign
  out all other devices** ends every one but this. If you see one you do not know, sign it out
  and change your password.

## Switch brand

If you work for more than one brand, the brand name at the top of the console is a button.
Press it and choose the brand. Everything on screen then belongs to that brand. If you work
for one brand only, its name is shown without a button.

## Theme and language

The controls at the top right of the console:

- **Search or jump to…** (or **Ctrl K**) opens a search box: type a screen ("transfers"), or
  what you want to do ("new order", "add product", "invite"), and press Enter;
- the bell shows what is waiting for you;
- the moon or sun button switches between the dark and light themes;
- the **বাংলা** / **English** button switches the language (the console starts in English);
- the round button with your initials opens your account menu, with **My account** and
  **Sign out**.

The menu on the left groups the screens (Sell, Products and stock, Money, People, Admin). Click
a group's name to fold it away; the button at the bottom left folds the whole menu to icons.
Settings is at the bottom of the menu.

The investor portal and the buyers' tracking page start in Bangla, and the language button at
the top switches them. The till has its own language and theme buttons.

## Forgotten password or lost phone

There is no "forgot password" link. Only an org admin can reset a sign-in.

- **Forgotten password.** Ask an org admin. They give you a new link that works once, for one
  hour. Your old password stops working and you are signed out everywhere.
- **New phone, old one still with you.** Move it yourself: **My account** →
  **Set up on a new phone**.
- **Lost phone.** If you still have a recovery code, sign in with it and use **Set up on a new
  phone** with the same recovery code; then tell an org admin. Without one, tell an org admin
  at once: they reset your two-step sign-in, and at your next sign-in you set it up again on
  the new phone.
- **A second admin.** For org admins, accounts, HR, branch managers, warehouse staff and
  investors, a second org admin must approve the reset before it takes effect. This can take
  some time, so ask early. Sales and marketing staff are reset by one admin.
- **More than one brand.** If you work in more than one brand, only a super admin can reset
  your sign-in.

## Keep these to yourself

Never share your password, a 6-digit code, a recovery code, or an invite or reset link. That
includes colleagues, admins and chat groups. Anyone who has one can act as you. An admin never
needs your password, and sends your link to you alone.
