-- Fraud signals: the cross-org phone tables and the four tenant ones (M13; §5, §10).
--
-- Written to match `packages/db/src/schema/fraud/index.ts` statement for
-- statement. The isolation policies and the grants follow in 0046, the integrity
-- triggers in 0047.
--
-- Two tables here have **no `org_id`**: `fraud.phone_signals` and
-- `fraud.provider_checks`. That is §5's first cross-org exception and the only
-- one in the system that is written to rather than only read. It is safe because
-- of the column list, not because of a policy: there is nowhere in either table
-- to put an order number, a customer name, an address, an amount, a brand or a
-- user id, so an org reading them learns how many parcels a number has sent back
-- and cannot learn whose. They are declared in `GLOBAL_TABLES` in
-- `packages/db/src/rls.ts`, which is what keeps M01's tenancy guard from
-- reporting them as an oversight.
--
-- The number itself is never stored. The key is HMAC-SHA256 of the E.164 form
-- under a server secret (§10). A plain digest would not be a hash of anything
-- useful: the whole Bangladeshi mobile space is about a billion candidates, and a
-- laptop enumerates that in minutes. The key is what makes a leaked copy of this
-- table worthless.

CREATE SCHEMA "fraud";
--> statement-breakpoint
CREATE TABLE "fraud"."phone_signals" (
	"phone_hash" text PRIMARY KEY NOT NULL,
	"orders_total" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"returned" integer DEFAULT 0 NOT NULL,
	"cancelled" integer DEFAULT 0 NOT NULL,
	"last_incident_at" timestamp with time zone,
	"manual_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_signals_hash_shape" CHECK ("fraud"."phone_signals"."phone_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "phone_signals_counts_non_negative" CHECK ("fraud"."phone_signals"."orders_total" >= 0 and "fraud"."phone_signals"."delivered" >= 0 and "fraud"."phone_signals"."returned" >= 0 and "fraud"."phone_signals"."cancelled" >= 0),
	CONSTRAINT "phone_signals_flags_is_array" CHECK (jsonb_typeof("fraud"."phone_signals"."manual_flags") = 'array')
);
--> statement-breakpoint
CREATE TABLE "fraud"."provider_checks" (
	"phone_hash" text NOT NULL,
	"provider" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"delivered" integer DEFAULT 0 NOT NULL,
	"returned_or_cancelled" integer DEFAULT 0 NOT NULL,
	"ratio" numeric(5, 4),
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"raw" jsonb,
	CONSTRAINT "provider_checks_phone_hash_provider_pk" PRIMARY KEY("phone_hash","provider"),
	CONSTRAINT "provider_checks_hash_shape" CHECK ("fraud"."provider_checks"."phone_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "provider_checks_counts_non_negative" CHECK ("fraud"."provider_checks"."total" >= 0 and "fraud"."provider_checks"."delivered" >= 0 and "fraud"."provider_checks"."returned_or_cancelled" >= 0),
	CONSTRAINT "provider_checks_ratio_range" CHECK ("fraud"."provider_checks"."ratio" is null or ("fraud"."provider_checks"."ratio" >= 0 and "fraud"."provider_checks"."ratio" <= 1))
);
--> statement-breakpoint
CREATE TABLE "fraud"."rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"allow_min" smallint DEFAULT 70 NOT NULL,
	"warn_min" smallint DEFAULT 40 NOT NULL,
	"require_advance_min" smallint DEFAULT 20 NOT NULL,
	"provider_enabled" boolean DEFAULT false NOT NULL,
	"provider_ttl_minutes" integer DEFAULT 4320 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "rules_org_id_key" UNIQUE("org_id"),
	CONSTRAINT "rules_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "rules_bands_decrease" CHECK ("fraud"."rules"."allow_min" > "fraud"."rules"."warn_min" and "fraud"."rules"."warn_min" > "fraud"."rules"."require_advance_min"),
	CONSTRAINT "rules_bands_in_range" CHECK ("fraud"."rules"."allow_min" <= 100 and "fraud"."rules"."require_advance_min" >= 0),
	CONSTRAINT "rules_provider_ttl_positive" CHECK ("fraud"."rules"."provider_ttl_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "fraud"."phone_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"phone_hash" text NOT NULL,
	"severity" smallint DEFAULT 1 NOT NULL,
	"reason" text NOT NULL,
	"created_by" text NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by" text,
	"cleared_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "phone_flags_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "phone_flags_hash_shape" CHECK ("fraud"."phone_flags"."phone_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "phone_flags_reason_length" CHECK (length("fraud"."phone_flags"."reason") between 3 and 500),
	CONSTRAINT "phone_flags_severity_range" CHECK ("fraud"."phone_flags"."severity" between 1 and 3),
	CONSTRAINT "phone_flags_cleared_together" CHECK (("fraud"."phone_flags"."cleared_at" is null and "fraud"."phone_flags"."cleared_by" is null and "fraud"."phone_flags"."cleared_reason" is null)
        or ("fraud"."phone_flags"."cleared_at" is not null and "fraud"."phone_flags"."cleared_by" is not null and "fraud"."phone_flags"."cleared_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "fraud"."overrides" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"phone_hash" text NOT NULL,
	"trust_score" smallint NOT NULL,
	"reason" text NOT NULL,
	"decided_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "overrides_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "overrides_hash_shape" CHECK ("fraud"."overrides"."phone_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "overrides_reason_length" CHECK (length("fraud"."overrides"."reason") between 10 and 500),
	CONSTRAINT "overrides_score_range" CHECK ("fraud"."overrides"."trust_score" between 0 and 100)
);
--> statement-breakpoint
CREATE TABLE "fraud"."order_phones" (
	"org_id" uuid NOT NULL,
	"order_id" uuid NOT NULL,
	"phone_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_phones_org_id_order_id_pk" PRIMARY KEY("org_id","order_id"),
	CONSTRAINT "order_phones_hash_shape" CHECK ("fraud"."order_phones"."phone_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "fraud"."rules" ADD CONSTRAINT "rules_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fraud"."phone_flags" ADD CONSTRAINT "phone_flags_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fraud"."overrides" ADD CONSTRAINT "overrides_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "fraud"."order_phones" ADD CONSTRAINT "order_phones_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "provider_checks_fetched_at_idx" ON "fraud"."provider_checks" USING btree ("fetched_at");
--> statement-breakpoint
CREATE INDEX "phone_flags_org_hash_idx" ON "fraud"."phone_flags" USING btree ("org_id","phone_hash");
--> statement-breakpoint
CREATE INDEX "overrides_org_order_idx" ON "fraud"."overrides" USING btree ("org_id","order_id");
