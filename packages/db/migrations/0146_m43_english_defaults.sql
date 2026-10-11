ALTER TABLE "notify"."templates" DROP CONSTRAINT "notify_templates_bodies";--> statement-breakpoint
ALTER TABLE "notify"."emails" ALTER COLUMN "locale" SET DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "notify"."messages" ALTER COLUMN "locale" SET DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "storefront"."customer_accounts" ALTER COLUMN "locale" SET DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "storefront"."web_orders" ALTER COLUMN "locale" SET DEFAULT 'en';--> statement-breakpoint
ALTER TABLE "notify"."templates" DROP COLUMN "body_bn";--> statement-breakpoint
ALTER TABLE "notify"."templates" ADD CONSTRAINT "notify_templates_bodies" CHECK (length("notify"."templates"."body_en") between 1 and 1000);