CREATE SCHEMA "http";
--> statement-breakpoint
CREATE TABLE "http"."idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"route" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_fingerprint" text NOT NULL,
	"status_code" integer,
	"response_body" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "idempotency_keys_window_ordered" CHECK ("http"."idempotency_keys"."expires_at" > "http"."idempotency_keys"."created_at"),
	CONSTRAINT "idempotency_keys_completion_consistent" CHECK (("http"."idempotency_keys"."completed_at" is null and "http"."idempotency_keys"."status_code" is null)
        or ("http"."idempotency_keys"."completed_at" is not null and "http"."idempotency_keys"."status_code" is not null))
);
--> statement-breakpoint
ALTER TABLE "http"."idempotency_keys" ADD CONSTRAINT "idempotency_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_keys_org_idx" ON "http"."idempotency_keys" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_keys_scope_idx" ON "http"."idempotency_keys" USING btree ("org_id","user_id","route","idempotency_key");--> statement-breakpoint
CREATE INDEX "idempotency_keys_expiry_idx" ON "http"."idempotency_keys" USING btree ("expires_at");--> statement-breakpoint
-- The idempotency store's isolation policy and grants (invariant 4, §23).
--
-- Emitted by tenantTableSql({schema:'http', table:'idempotency_keys'}) and
-- pasted verbatim, the way every tenant policy in this repo is: a policy that
-- differs by one character fails silently, returning rows rather than throwing,
-- and the wrong rows look like the right ones (D-048).
--
-- Full read/write, unlike the outbox next door. This table is a cache with a
-- 24-hour window, not a record: the sweeper must be able to DELETE expired rows
-- or the table grows by one row per mutation forever, and UPDATE is how a
-- reserved row becomes a completed one once the handler has answered.
alter table "http"."idempotency_keys" enable row level security;--> statement-breakpoint
alter table "http"."idempotency_keys" force row level security;--> statement-breakpoint
drop policy if exists "idempotency_keys_org_isolation" on "http"."idempotency_keys";--> statement-breakpoint
create policy "idempotency_keys_org_isolation" on "http"."idempotency_keys"
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);--> statement-breakpoint
grant usage on schema "http" to "erp_app", "erp_analytics";--> statement-breakpoint
grant select, insert, update, delete on "http"."idempotency_keys" to "erp_app";
