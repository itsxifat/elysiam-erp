# Prices and buying prices

For the people who price products and enter what the stock cost: org admins, and accounts for
buying prices. A sales or warehouse login sees the selling prices but never a buying price, an
average cost or a margin. Sign-in help is in the [README](README.md).

Prices are typed in taka with up to two decimals (`1490` or `1490.50`). A price of zero, a minus
sign or text is refused before anything is saved.

## Price a new product by size or colour

1. **Catalog** → **New product**, then pick the sizes and colours. A table appears with one row
   per size and colour.
2. **Quick prices**: type a price under a size (for example **XL 1690**) and every colour of XL
   takes it; type one under a colour and every size of that colour takes it. A price typed in a
   row wins over both, and a row left blank takes the **Selling price** at the top. Each row's
   grey figure is the price it will be created at; **Own price** marks rows that differ from the
   main price.
3. **Regular price**: a "was" price the website shows struck through (৳1,990 crossed out beside
   ৳1,490). It must be above the price. Leave it blank for none.
4. **Many rows at once**: tick rows (or the box at the top for all of them), type a price,
   regular price, pieces or cost in the bar that appears and press **Apply**. The arrow at the end
   of a row copies that row to every row below it.
5. **Cost per piece**: each row has its own, whether the pieces are already in hand or come from
   a supplier. The **Cost per piece** under **Stock** fills any row left blank.

## Change prices on the product page

1. Open the product and press **Edit prices**. Every price and regular price becomes a box.
2. Change one or two boxes by hand, or use **Change many prices**:
   - **Choose**: **All**, **None**, or a size or colour button to choose every variant of it;
     you can also tick rows.
   - **Which price**: the selling price or the regular price.
   - **Change**: **Set to**, **Add**, **Subtract**, **Raise by (%)** or **Lower by (%)**, then the
     **Amount**, and **Round to** if you want round figures (৳10, ৳50, ৳100).
   - Press **Preview**. The new figures go into the boxes and the changed rows are marked. It
     says how many prices will change, and names any that would fall to nothing or below a
     regular price; fix those first.
3. Type **Why** (it is kept in the price history, for example "Eid +10%") and press
   **Save prices**. Every change is saved together, or none.

**Price history** at the bottom of the page lists every change of every size and colour: when,
which variant, the price before and after, the regular price before and after, and why.

## Buying prices

On the product page a cost role sees, for each variant:

- **Avg. cost**: the average of everything it was bought at (it moves only when stock arrives);
- **Last bought**: the last price, with the date and the supplier;
- **Margin**: (price − average cost) ÷ price, worked out on the screen. A red margin sells below
  cost.

**Buying prices** (below the variants) holds each variant's **standard buying price**: what you
normally pay. Type it per variant, or use **Same for all** and **Fill**, then **Save**. The next
time stock of that variant is received, its cost box starts at the standard price for that
supplier, else the standard price, else the last price. You can always type over it: what you
receive at is what enters the books.

For the whole catalogue at once, or a different standard price per supplier, use **Supply** →
**Buying prices**: **Download the spreadsheet**, fill `standard_cost_taka` (put a supplier's code
under `supplier` for that supplier's own price; leave a row blank to keep it), then **Choose a
CSV file**, **Check the file** and **Import**. Nothing is imported if any line has a problem.

## Receive stock with a cost per variant

1. On the product page press **Receive stock**, choose the supplier and the location.
2. Type the **Quantity** of each size and colour. Each row's **Cost** is filled in from its
   standard or last buying price (the small grey words say which); change any of them. **Cost
   per piece** at the top fills rows still blank.
3. Check the total and press **Receive stock**. Each variant's average cost moves by its own
   price.

On **Supply** → **Entries**, **Add a product** puts every size and colour of a product on the
entry at once; type the quantities that arrived (rows left without a quantity are not received)
and the costs (filled in the same way once a supplier is chosen; **Fill blanks** with one figure
for the rest).

## Add or stop sizes and colours

In **Sizes and colours** on the product page:

- **Add**: press a size or colour that is not on yet. Each new variant is listed with the price it
  will start at (the same size's price in the other colours, else the **Price for new variants**);
  change any, then **Save sizes and colours**.
- **Stop selling a size in every colour**: press it off. The list says what will stop and how many
  pieces it still has; its stock stays and can still be moved or written off. If an order is
  holding pieces of it, it is refused until that order is dispatched or cancelled.
- Adding colours to a product that had only sizes offers to archive the old size-only variants.
- A size or colour archived in Catalog setup is not offered for new variants. If this product
  already sells it, it still shows, so you can press it off.

## Copy a product, and the product list

- **Duplicate** (product page, or the row menu on the list) makes a copy under a new name with the
  same category, description, sizes, colours, prices, photos and website details. It has no
  stock and starts as a draft, off the website. Variants with an archived size or colour are left
  out of the copy, and a product in an archived category cannot be copied until the category is
  restored or the product moved.
- The **product list** shows each product's photo, stock, whether the website shows it and its
  prices. The **⋯** button on a row opens, duplicates, shows or hides it on the website, and
  archives it. Tick rows to do the same to many: show or hide on the website, set a size chart,
  move to a category, archive, or print their stickers.
- **Delete** (org admins: the row menu, the product page's header, and the bin on each variant
  row) first says what uses the product or variant. Something made by mistake that nothing uses
  is deleted for good. Anything with stock, a sale or a receipt is offered **Archive** instead,
  which keeps its history.

## Also on the product page

- **Edit variant** (the pencil on a row): a supplier's own barcode for that variant, and its
  weight if it differs from the product's.
- **Edit**: the product's **Weight per piece (g)**, which couriers are told.
- **Photos**: each photo can belong to a colour, so the website shows the red photos when a
  shopper picks red.
- A category's **Website** dialog (Catalog setup) can set a **Size chart** that every new product
  in that category starts with.
