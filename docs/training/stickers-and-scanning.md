# Products, stock in hand, stickers and the scanner

For the people who add products, count the stock in, print the barcode stickers and use a
barcode scanner. Org admins and accounts do everything here; warehouse staff count stock and
print stickers, and accounts enters what the counted pieces cost. Sign-in help is in the
[README](README.md).

## Add a product with the stock you already have

1. **Catalog** → **New product**.
2. **Product**: the name, the category, the selling price in taka, the status (**Active** is on
   sale at once) and a description if you like.
3. **Photos**: press **Add photos** and choose several at once. Drag them into order, or use
   the arrow buttons; the first is the cover (the star button makes any photo the cover).
   The crop button cuts a photo to the shop's shape (3 wide, 4 tall): drag the photo, or use
   the arrow keys, zoom until it fills the frame, then **Use this crop**.
4. **Sizes and colours**: press the sizes and colours the product comes in. A table appears
   with one row per size and colour. In each row you can change the price, and type the
   **Pieces** you have of it now.
5. **Stock**: choose **Already in hand (opening stock)** for stock the shop already holds, or
   **Received from a supplier** for a delivery. Pick the location, and type the **Cost per
   piece**: one figure for all, or a different one in a row's **Cost per piece** box (in both
   modes; prices by size, regular prices and costs per variant are in
   [Prices and buying prices](prices-and-buying-prices.md)).
6. **Website details** (optional): open it to choose whether the product shows on the website,
   featured or new arrival, the shelf, tags, size chart, material, care and the words a search
   engine shows.
7. Press **Create product**. When it says **Product created**, press **Print stickers**: there
   is one sticker for every piece you typed.

If something fails half way (a photo, the stock), the product is already saved: press **Try the
rest again** and only what is left is sent.

## Count stock in, shelf by shelf

Use **Stock** → **Stock in hand** for stock the shop held before it started on the ERP.

1. Choose the **Location** the pieces are in.
2. Scan each piece's sticker into **Scan or type a barcode**. Each scan adds one piece. To add
   a product without stickers yet, type three letters of its name under **Add a product** and
   type the pieces of each size.
3. Type the **Cost per piece** (one for all, or per line).
4. Press **Post stock in hand**. The pieces are in stock, and the entry is in the list below.
   Press the printer button on its row to print a sticker for every piece.

Warehouse staff see **Save for accounts** instead: the pieces wait as a draft until accounts
presses **Enter costs and post**. If the draft is changed (on another phone) while accounts has
it open, posting stops and shows the new pieces: check them, then post again.

## Undo an entry made by mistake

If a shelf was counted in twice, or an entry has the wrong pieces or cost, press the undo
button on its row in **Stock in hand** (accounts or an org admin), say why, and press **Ask to
reverse**. A second admin approves it in **Approvals**; then the entry's pieces come out of
stock and the books are put back. Enter the stock again correctly as a new entry.

It works only while opening stock is open, and only while the products still carry the cost the
entry brought them in at. If the same product has since come in at another cost (another entry,
a delivery), correct it with a stock count instead.

## Print stickers

You can print stickers from the end of the new-product form, after receiving stock on a
product page or in **Supply**, from a **Stock in hand** entry, from a product page
(**Barcode stickers** → **Print stickers**, or the printer button beside a size's barcode), and
from **Stock**: tick the rows and press **Print stickers for the chosen rows**.

1. **Print on**: the sticker roll in your thermal printer (38 × 25, 40 × 30 or 50 × 25 mm), or
   an A4 sticker sheet (3 × 8 or 4 × 10).
2. On a half-used A4 sheet, set **Start at position** to the first unused sticker (1 is top
   left, then along the row).
3. Untick **Print the price on the sticker** if the tag should not show the price. The ERP
   remembers your choice of paper and price for next time.
4. Change any count, then press **Print**. The PDF opens in a new tab; print it from there. If
   no tab opened, use **Open** or **Download**.

For a thermal printer, print at **actual size** (not "fit to page") with the paper size set to
the roll's sticker size. More than a thousand stickers come as several files: print them one
after another.

## Use the barcode scanner

A USB or Bluetooth scanner works anywhere in the console, with nothing to set up:

- **On any screen**, scan a sticker and the product opens, with the scanned size and colour
  marked. If nothing has that barcode, the screen says so.
- **On a stock screen** (receiving stock, stock in hand, a transfer, an adjustment, a count),
  each scan adds that piece to the list, or one more if it is already there. A sticker of
  another product is refused with a message.
- Scanning into a text box (a name, a note) types the code there instead. Click outside the
  box first.
- **On a phone**, press the camera button (bottom right, or **Scan with camera** on a stock
  screen) and hold the sticker in the frame. It shows only on phones whose browser can read
  barcodes.

## Count a shelf by scanning

1. **Stock** → **Stock counts**: choose the location and press **Start a count**.
2. Scan every piece on the shelf into **Scan each piece on the shelf**. Each scan counts one;
   the counted column goes up as you scan. Two people can scan the same count from two
   devices.
3. If you need to type a figure instead (a piece without a sticker), type it in the counted
   column; changing a figure that was already counted asks **Why the count was typed**.
4. Press **Finish counting**, then **Send differences for approval**, as before.

## Close the opening stock (org admin)

Once every piece the shop held is counted in, open **Stock** → **Stock in hand** and press
**Close opening stock** (if an entry is waiting to be undone, approve or reject that in
**Approvals** first). From then on, stock arrives only from suppliers, transfers, returns
and approved adjustments, and **Already in hand** is no longer offered.

If something was missed, press **Ask to reopen** and say what was found. A second admin decides
it in **Approvals**; once approved, the window is open again until you close it.

A brand that was already trading on the ERP (or had opened its books with the data import) when
this arrived starts with opening stock closed: ask to reopen it if you need to count stock in.
