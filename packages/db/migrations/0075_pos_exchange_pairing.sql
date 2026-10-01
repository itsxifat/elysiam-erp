-- An exchange's replacement sale pairs with one return of the same brand (M23; D-195).
--
-- `exchange_return_id` was stored as the till sent it: any uuid, another brand's
-- return, or a return already paired with a different sale. The service now checks
-- the return is this branch's and unpaired, and holds the sale for review with
-- `exchange_mismatch` when it is not, writing no link. These constraints are the
-- floor under that check: the link names the brand's own return (D-047's composite
-- key) and no return pairs with two sales.
ALTER TYPE "pos"."hold_reason" ADD VALUE 'exchange_mismatch';--> statement-breakpoint
ALTER TABLE "pos"."sales" ADD CONSTRAINT "pos_sales_org_id_exchange_return_id_fk" FOREIGN KEY ("org_id","exchange_return_id") REFERENCES "pos"."returns"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pos_sales_org_exchange_return_key" ON "pos"."sales" USING btree ("org_id","exchange_return_id") WHERE "pos"."sales"."exchange_return_id" is not null;