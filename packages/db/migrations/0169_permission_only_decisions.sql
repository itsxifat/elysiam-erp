ALTER TABLE "sales"."order_advances" DROP CONSTRAINT "order_advances_four_eyes";--> statement-breakpoint
ALTER TABLE "sales"."order_advances" DROP CONSTRAINT "order_advances_voided";--> statement-breakpoint
ALTER TABLE "approvals"."approval_requests" DROP CONSTRAINT "approval_requests_maker_is_not_checker";--> statement-breakpoint
ALTER TABLE "investors"."withdrawals" DROP CONSTRAINT "withdrawals_reviewer_is_not_requester";--> statement-breakpoint
ALTER TABLE "sales"."order_advances" ADD CONSTRAINT "order_advances_decided" CHECK (("sales"."order_advances"."status" = 'pending') = ("sales"."order_advances"."decided_by" is null)
          and ("sales"."order_advances"."decided_by" is null) = ("sales"."order_advances"."decided_at" is null));--> statement-breakpoint
ALTER TABLE "sales"."order_advances" ADD CONSTRAINT "order_advances_voided" CHECK (("sales"."order_advances"."status" = 'voided') = ("sales"."order_advances"."void_journal_id" is not null)
          and ("sales"."order_advances"."void_journal_id" is null) = ("sales"."order_advances"."voided_by" is null)
          and ("sales"."order_advances"."voided_by" is null) = ("sales"."order_advances"."voided_at" is null)
          and ("sales"."order_advances"."voided_by" is null) = ("sales"."order_advances"."void_reason" is null));