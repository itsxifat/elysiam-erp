-- A flash claim belongs to one whole line of its own order, of its own SKU, charged at the
-- price the units were claimed at, and names its offer and the offer's SKU together (M35a
-- ledger audit W4, W12, re-audit W2 and the acceptance audit; D-542).
--
-- Generated, then reordered by hand: the two unique keys the new foreign keys reference
-- have to exist first. `order_lines_flash_claim_key` is redundant with the primary key as a
-- constraint; it is the target of the claim's six-column foreign key. A line's quantity and
-- price never change in place (an edit replaces the lines), and an order whose lines hold
-- claims refuses an edit of its lines. `order_line_id` is NOT NULL with no default: 0103
-- created `promo.flash_claims` in this same branch, so no database holds a claim yet.
ALTER TABLE "sales"."order_lines" ADD CONSTRAINT "order_lines_flash_claim_key" UNIQUE("org_id","order_id","id","sku_id","qty","unit_price_poisha");--> statement-breakpoint
ALTER TABLE "promo"."flash_sale_items" ADD CONSTRAINT "flash_sale_items_org_id_id_sku_id_key" UNIQUE("org_id","id","sku_id");--> statement-breakpoint
ALTER TABLE "promo"."flash_claims" DROP CONSTRAINT "flash_claims_org_id_flash_sale_item_id_fk";
--> statement-breakpoint
DROP INDEX "promo"."flash_claims_org_order_item_idx";--> statement-breakpoint
ALTER TABLE "promo"."flash_claims" ADD COLUMN "order_line_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "promo"."flash_claims" ADD CONSTRAINT "flash_claims_org_id_item_sku_fk" FOREIGN KEY ("org_id","flash_sale_item_id","sku_id") REFERENCES "promo"."flash_sale_items"("org_id","id","sku_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promo"."flash_claims" ADD CONSTRAINT "flash_claims_order_line_fk" FOREIGN KEY ("org_id","order_id","order_line_id","sku_id","qty","sale_price_poisha") REFERENCES "sales"."order_lines"("org_id","order_id","id","sku_id","qty","unit_price_poisha") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flash_claims_org_line_idx" ON "promo"."flash_claims" USING btree ("org_id","order_line_id");--> statement-breakpoint
CREATE INDEX "flash_claims_org_order_idx" ON "promo"."flash_claims" USING btree ("org_id","order_id");
