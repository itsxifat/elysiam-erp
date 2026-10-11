-- My account's devices list (M40, D-704): when each session last made a request. Better
-- Auth never writes it; the auth plugin touches it at most once a minute per session.
ALTER TABLE "auth"."sessions" ADD COLUMN "last_active_at" timestamp with time zone DEFAULT now() NOT NULL;
