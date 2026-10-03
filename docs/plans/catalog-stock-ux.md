# Catalog and stock made easy

Not a milestone. The owner tried the test site and said adding a product, managing stock and
managing the catalog had "no easy option and even in some case there is no way". This pass
makes every product and stock task a brand's staff do every day short and obvious. Branch
`catalog-stock-ux`, from `integration-wave2` at `8556f42`. Decision ids D-420 to D-432.

> Planned on 2026-10-03 under continuous build mode (no approval pause; the plan is still
> written first). Another builder is redesigning the look in parallel and owns `packages/ui`,
> the shell and the tokens, so these screens use only the existing kit (DataTable, Dialog,
> ConfirmDialog, StatusBadge, Money, FileUpload, PermissionGate) and layout utilities.

## Audit (before)

Easy: done in a few obvious steps. Hard: possible, but too many steps or unclear. Impossible:
no screen, or the screen cannot do it.

| #   | Task                                                    | Before     | Why                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Create a product with sizes, colours, prices and photos | Hard       | Two screens: name and one price first, then a checkbox list on the product page to make the SKUs. No per-variant price, no photos until afterwards, no stock. Saved as Draft by default, so a new product could not be sold.             |
| 2   | Edit name, price, category, photos                      | Impossible | `PATCH /v1/catalog/products/:id` existed but no screen used it. Price: one price for every SKU at once only. Photos: upload worked, but showed an 8-character file id instead of the picture.                                            |
| 3   | Add a size or colour later                              | Easy       | "Add variants" on the product page.                                                                                                                                                                                                      |
| 4   | Archive or reactivate a product or SKU                  | Impossible | Product: route existed, no button. SKU: no route at all.                                                                                                                                                                                 |
| 5   | Change price, with history                              | Hard       | One price for all SKUs; history readable one SKU at a time from a dropdown of codes.                                                                                                                                                     |
| 6   | Manage categories (rename, nest)                        | Hard       | Create only. Rename, move and deactivate had a route and no screen. The screen was not linked from Catalog.                                                                                                                              |
| 7   | Manage attributes and values                            | Hard       | Create only; a typo in a size label could never be fixed (no route). Not linked from Catalog.                                                                                                                                            |
| 8   | Import many products from a spreadsheet                 | Impossible | Only a price importer existed; no product importer, no template.                                                                                                                                                                         |
| 9   | Receive new stock from a supplier, with cost            | Impossible | The supply form's item list showed only SKUs **already stocked at that location**, so a new product's first delivery could not be entered. Cost was typed in poisha.                                                                     |
| 10  | Receive opening stock                                   | Impossible | Only the one-time M14a importer (`pnpm migration`, run by the implementation team before go-live). Nothing for a product added later.                                                                                                    |
| 11  | Adjust stock (damage, loss, found) with approval        | Hard       | Separate screen, one SKU per request, chosen from a list of codes. A gain for a size not yet at that location was impossible.                                                                                                            |
| 12  | Transfer warehouse to showroom, send and receive        | Impossible | A brand is seeded with one warehouse and no showroom and no in-transit location, and no screen could create either; the transfer route refuses without an in-transit location. One SKU per transfer.                                     |
| 13  | Stock count                                             | Easy       | Stock → Counts: open, enter counted quantities, submit, close (variances go for approval).                                                                                                                                               |
| 14  | See stock per product, size, location; low stock        | Hard       | One flat list of SKU × location rows; no category filter, no product view, product names not linked, sizes shown only inside the code. Low-stock highlighting needs a reorder level, and no screen could set one, so "Low" never showed. |
| 15  | See a product's stock movement history                  | Impossible | `GET /v1/inventory/movements` existed; no screen read it.                                                                                                                                                                                |
| 16  | Print barcodes or labels                                | Easy       | Product page, label sheet PDF.                                                                                                                                                                                                           |

## What changes

### Server (each with tests against real Postgres)

1. **Per-variant price on create** (D-422). `POST /v1/catalog/products` takes optional
   `variantPrices: [{ valueIds, pricePoisha }]`. Matching is by the combination's variant key
   through a pure domain function (`variantPriceFor`); an override naming a combination the
   matrix does not produce is refused. The SKU is born at its price, so no history row.
2. **SKU archive and reactivate** (D-423). `PATCH /v1/catalog/skus/:id` `{ status }`,
   `update Catalog`. Stock stays where it is; an archived SKU is not sellable (the order desk
   and till already refuse one) but can still be transferred, counted and written off.
3. **Rename attributes and values** (D-424). `PATCH /v1/catalog/attributes/:id`
   `{ name?, position? }` and `PATCH /v1/catalog/attributes/:id/values/:valueId`
   `{ label?, position? }`, `update Catalog`. Codes stay fixed: they are inside printed SKU
   codes.
4. **Product spreadsheet import** (D-425). `POST /v1/catalog/imports/products/dry-run`
   (`read Catalog`) and `POST /v1/catalog/imports/products` (`create Catalog`). One row per
   product: `name, category, price_taka, sizes, colours, status, description`. Sizes and
   colours are lists (`S|M|L`), matched to the brand's size and colour values by code or
   label; category by code or name. Review is a pure domain function
   (`reviewProductImport`); commit is all or nothing through the same create path as the
   form, so codes are generated the same way.
5. **Stock and history by product** (D-427). `GET /v1/inventory/stock` takes `productId` and
   `categoryId`, and each row carries `productId` and its variant label;
   `GET /v1/inventory/movements` takes `productId`, and each row carries the location's code
   and name. Cost fields are unchanged and still stripped by `serializeFor()`.
6. **The first transfer creates the in-transit location** (D-428). When a brand has none, the
   dispatch creates `IN-TRANSIT` (org-level, kind `in_transit`) in the same transaction,
   audited. Nobody should have to know §8's holding place exists.

No new posting rule, no new movement kind, no migration. Stock still changes only through
movements (receipts, transfers, approved adjustments), and cost still enters only through a
supply receipt.

### Console

7. **The product page is the hub** (D-420). Header: name, status, category, code, with
   **Receive stock** as the primary action and Edit, Adjust, Transfer, Print labels, Archive
   or Reactivate beside it. Sections: a variant grid (size, colour, code, price, stock per
   location, total available, low-stock badge, per-SKU archive), photos as thumbnails,
   add sizes or colours, price history for the whole product, and the stock history.
   - Receive stock: supplier, location, cost per piece in taka (cost roles only) and a
     quantity per variant, posted as one supply entry; without `read Cost` it saves a
     quantity-only draft for accounts to price (D-005).
   - Adjust: location, lost or found, a reason (Damaged, Lost, Found, Count difference, or
     typed) and a quantity per variant; one adjustment request, which goes for approval.
   - Transfer: from, to and a quantity per variant (capped at what is available).
   - Edit: name, category, description, status. Prices are edited in the grid.
8. **New product is one form** (D-421, D-426). Name, category, price, status (Active by
   default). Sizes and colours as chips generate the variant grid; each row can override its
   price and take an opening quantity. Optional first stock (location, supplier, cost per
   piece) goes in as a supply receipt after the product is created. Optional photos are
   uploaded first and attached on create.
9. **Stock page.** Filters for location, category, search and low stock; product names link
   to the hub; quick actions Receive stock, Transfers, Adjustments and Counts.
10. **Catalog setup** (`/catalog/structure`, linked from the Catalog header as "Categories,
    sizes & colours"): categories with rename, move under a parent and deactivate; sizes,
    colours and other attributes with add value and rename; locations with add warehouse or
    showroom, rename and deactivate (D-429).
11. **Import** (`/catalog/import`): two tabs, New products and Prices. Download the template,
    check the file, see every problem with its line and column, then import.
12. **Supply entries** (D-430): the item picker searches the whole catalog, so a new
    product's first delivery can be entered, and cost is typed in taka.

### Tests

- `packages/domain`: `variantPriceFor`, `reviewProductImport` (unit and fast-check).
- `apps/server/src/modules/catalog/catalog-stock-ux.e2e.test.ts`: the new routes over HTTP
  against real Postgres: per-variant prices, SKU archive, renames, the importer
  (dry run, refusal, commit, all-or-nothing), stock and movements by product, cost withheld
  from the warehouse role, the first transfer creating in-transit, permissions refused for
  sales and warehouse.
- Route-matrix fixtures and manifest entries for every new route.
- `apps/console/e2e/catalog-stock.stack.ts`: as org admin, create a size and colour list and
  a showroom on the setup screen, a supplier, then a product with sizes, colours and opening
  stock; adjust; transfer and receive it; receive more stock from the hub; view the stock
  page. Screenshots in `docs/review/catalog-stock/`.

## Decisions

D-420 to D-432, recorded in `docs/decisions.md`.

## Status on 2026-10-03

Planned. Building.
