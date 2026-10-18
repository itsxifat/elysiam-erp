ALTER TABLE "telephony"."calls" DROP CONSTRAINT "calls_recording_status";--> statement-breakpoint
ALTER TABLE "telephony"."calls" DROP CONSTRAINT "calls_recording_stored_has_file";--> statement-breakpoint
ALTER TABLE "telephony"."calls" DROP CONSTRAINT "calls_recording_error";--> statement-breakpoint
ALTER TABLE "telephony"."connections" DROP CONSTRAINT "connections_retention";--> statement-breakpoint
ALTER TABLE "telephony"."calls" DROP CONSTRAINT "calls_org_id_recording_file_id_fk";--> statement-breakpoint
DROP INDEX "telephony"."calls_org_recording_idx";--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD COLUMN "pinned_note" text;--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD COLUMN "pinned_note_by_user_id" text;--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD COLUMN "pinned_note_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD COLUMN "wrap_up_result" text;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD COLUMN "wrap_up_note" text;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD COLUMN "wrap_up_call_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD COLUMN "wrapped_up_by_user_id" text;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD COLUMN "wrapped_up_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD CONSTRAINT "customers_pinned_note_by_user_id_users_id_fk" FOREIGN KEY ("pinned_note_by_user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_wrapped_up_by_user_id_users_id_fk" FOREIGN KEY ("wrapped_up_by_user_id") REFERENCES "iam"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "calls_org_wrap_up_idx" ON "telephony"."calls" USING btree ("org_id","user_id","ended_at") WHERE "telephony"."calls"."status" = 'ended' and "telephony"."calls"."wrapped_up_at" is null;--> statement-breakpoint
ALTER TABLE "telephony"."calls" DROP COLUMN "recording_status";--> statement-breakpoint
ALTER TABLE "telephony"."calls" DROP COLUMN "recording_file_id";--> statement-breakpoint
ALTER TABLE "telephony"."calls" DROP COLUMN "recording_bytes";--> statement-breakpoint
ALTER TABLE "telephony"."calls" DROP COLUMN "recording_attempts";--> statement-breakpoint
ALTER TABLE "telephony"."calls" DROP COLUMN "recording_error";--> statement-breakpoint
ALTER TABLE "telephony"."connections" DROP COLUMN "recording_retention_days";--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD CONSTRAINT "customers_pinned_note_whole" CHECK (("sales"."customers"."pinned_note" is null) = ("sales"."customers"."pinned_note_by_user_id" is null)
          and ("sales"."customers"."pinned_note" is null) = ("sales"."customers"."pinned_note_at" is null));--> statement-breakpoint
ALTER TABLE "sales"."customers" ADD CONSTRAINT "customers_pinned_note" CHECK ("sales"."customers"."pinned_note" is null
          or (char_length("sales"."customers"."pinned_note") <= 2000 and char_length(btrim("sales"."customers"."pinned_note")) >= 1));--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_wrap_up_result" CHECK ("telephony"."calls"."wrap_up_result" is null or "telephony"."calls"."wrap_up_result" in ('reached', 'no_answer', 'busy', 'wrong_number', 'call_back'));--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_wrap_up_whole" CHECK (("telephony"."calls"."wrap_up_result" is null) = ("telephony"."calls"."wrapped_up_by_user_id" is null)
          and ("telephony"."calls"."wrap_up_result" is null) = ("telephony"."calls"."wrapped_up_at" is null)
          and ("telephony"."calls"."wrap_up_result" is not null
               or ("telephony"."calls"."wrap_up_note" is null and "telephony"."calls"."wrap_up_call_back_at" is null)));--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_wrap_up_call_back" CHECK (("telephony"."calls"."wrap_up_result" = 'call_back') = ("telephony"."calls"."wrap_up_call_back_at" is not null));--> statement-breakpoint
ALTER TABLE "telephony"."calls" ADD CONSTRAINT "calls_wrap_up_note" CHECK (char_length("telephony"."calls"."wrap_up_note") <= 1000);
