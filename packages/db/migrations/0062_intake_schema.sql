-- The public order intake: per-site keys and the idempotency record (M11; architecture §23).
--
-- Mirrors `packages/db/src/schema/intake/index.ts` at this milestone's assigned number. The
-- isolation policies and grants are 0063; the order desk's two indexes are 0064.
--
-- Two things worth reading before the DDL.
--
-- **No signing secret is stored, in any form that signs.** A site's secret is derived from
-- `INTAKE_KEY_SECRET` and the key id at request time; `secret_sha256` is only its
-- fingerprint, kept so a change of master key refuses every old key instead of verifying
-- against a secret no site holds. A copy of this table signs nothing.
--
-- **`submissions` is claimed before Turnstile is asked.** Tokens are single-use, so a
-- replay of a request that already succeeded must be recognised before Cloudflare is
-- called, and the call itself cannot sit inside a transaction (invariant 6). The unique
-- index on `(org_id, site_key_id, idempotency_key)` is what makes the claim atomic; the
-- CHECK below is what stops a row claiming completion without the order it completed.

CREATE SCHEMA "intake";
--> statement-breakpoint
CREATE TABLE "intake"."site_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" text NOT NULL,
	"channel" text DEFAULT 'landing_page' NOT NULL,
	"landing_page_id" uuid,
	"key_id" text NOT NULL,
	"secret_sha256" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_by" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_keys_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "site_keys_label_length" CHECK (length("intake"."site_keys"."label") between 1 and 120),
	CONSTRAINT "site_keys_channel" CHECK ("intake"."site_keys"."channel" in ('landing_page', 'website')),
	CONSTRAINT "site_keys_key_id_format" CHECK ("intake"."site_keys"."key_id" ~ '^pk_[0-9a-f]{32}_[a-z2-7]{20}$'),
	CONSTRAINT "site_keys_secret_sha256_format" CHECK ("intake"."site_keys"."secret_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "site_keys_revocation_complete" CHECK (("intake"."site_keys"."revoked_at" is null) = ("intake"."site_keys"."revoked_by" is null))
);
--> statement-breakpoint
CREATE TABLE "intake"."submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"site_key_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_sha256" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"order_id" uuid,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submissions_org_id_id_key" UNIQUE("org_id","id"),
	CONSTRAINT "submissions_idempotency_key_shape" CHECK ("intake"."submissions"."idempotency_key" ~ '^[!-~]{8,255}$'),
	CONSTRAINT "submissions_request_sha256_format" CHECK ("intake"."submissions"."request_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "submissions_status" CHECK ("intake"."submissions"."status" in ('pending', 'completed')),
	CONSTRAINT "submissions_completed_has_order" CHECK (("intake"."submissions"."status" = 'completed') = ("intake"."submissions"."order_id" is not null and "intake"."submissions"."completed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "intake"."site_keys" ADD CONSTRAINT "site_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake"."submissions" ADD CONSTRAINT "submissions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake"."submissions" ADD CONSTRAINT "submissions_org_id_site_key_id_fk" FOREIGN KEY ("org_id","site_key_id") REFERENCES "intake"."site_keys"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "intake"."submissions" ADD CONSTRAINT "submissions_org_id_order_id_fk" FOREIGN KEY ("org_id","order_id") REFERENCES "sales"."orders"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_keys_org_idx" ON "intake"."site_keys" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "site_keys_key_id_idx" ON "intake"."site_keys" USING btree ("key_id");--> statement-breakpoint
CREATE INDEX "submissions_org_idx" ON "intake"."submissions" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_org_site_key_idx" ON "intake"."submissions" USING btree ("org_id","site_key_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "submissions_org_order_idx" ON "intake"."submissions" USING btree ("org_id","order_id");
