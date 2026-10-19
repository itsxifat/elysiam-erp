ALTER TABLE "sales"."customers" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD CONSTRAINT "customers_email" CHECK ("sales"."customers"."email" is null
          or (char_length("sales"."customers"."email") between 3 and 254 and "sales"."customers"."email" ~ '^[^@[:space:]]+@[^@[:space:]]+$'));--> statement-breakpoint
-- M49 (D-894): a saved address can be removed from the buyer's address book (orders keep their own copy of where they went).
GRANT DELETE ON "sales"."customer_addresses" TO "erp_app";
