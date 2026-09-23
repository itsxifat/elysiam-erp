-- Take identity back off the analytics role (D-049, architecture §5).
--
-- `globalTableSql` granted `select` to "erp_app", "erp_analytics" on every
-- global table, unconditionally. That was wrong in the same way the M01 guard
-- was wrong: a blanket grant instead of a decision per table. The effect was
-- that `erp_analytics` could read
--
--   iam.accounts     — password hashes
--   iam.two_factors  — TOTP secrets and backup codes
--   iam.sessions     — live session tokens
--   iam.verifications, iam.users
--
-- Verified against the running database before writing this: all five were
-- readable. Nothing in analytics needs any of them, and D-049 already says
-- analytics reads are opt-in per table. A read-only role is still a role that
-- can read, and these are the rows that let someone become another user.
--
-- 0004 is committed and is not edited (invariant 9). The generator now defaults
-- `analyticsReads` to false, and the tenancy guard enumerates analytics SELECT
-- grants the same way it enumerates writes, so this cannot come back silently.
--
-- `org.organizations` and the `ref` schema stay readable: the brand list every
-- consolidated report labels its rows with, and public geography.

revoke select on "iam"."users" from "erp_analytics";
--> statement-breakpoint
revoke select on "iam"."sessions" from "erp_analytics";
--> statement-breakpoint
revoke select on "iam"."accounts" from "erp_analytics";
--> statement-breakpoint
revoke select on "iam"."verifications" from "erp_analytics";
--> statement-breakpoint
revoke select on "iam"."two_factors" from "erp_analytics";
--> statement-breakpoint
revoke select on "iam"."memberships" from "erp_analytics";
--> statement-breakpoint
revoke select on "iam"."membership_branches" from "erp_analytics";
--> statement-breakpoint
-- `usage` on the schema is harmless without a table grant, but leaving it would
-- mean a future `grant select` in that schema silently reaches analytics again.
revoke usage on schema "iam" from "erp_analytics";
