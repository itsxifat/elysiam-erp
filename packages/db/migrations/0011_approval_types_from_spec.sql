-- Three approval types §6 names and 0007 did not carry.
--
-- §6's maker-checker list includes "investor withdrawals and distributions"
-- and "fraud block overrides". Their absence from the enum was not a missing
-- policy but a missing vocabulary: M15 and M10 would each have reached for a
-- type that does not exist and worked around it.
--
-- ADD VALUE rather than recreating the type, which two tables already
-- reference. PostgreSQL 12+ allows this inside a transaction block as long as
-- the value is not *used* in the same transaction, which a migration that only
-- declares it never does.
ALTER TYPE "approvals"."approval_type" ADD VALUE 'investor_withdrawal' BEFORE 'period_reopen';--> statement-breakpoint
ALTER TYPE "approvals"."approval_type" ADD VALUE 'investor_distribution' BEFORE 'period_reopen';--> statement-breakpoint
ALTER TYPE "approvals"."approval_type" ADD VALUE 'fraud_override' BEFORE 'period_reopen';