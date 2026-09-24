ALTER TABLE "ledger"."journals" ADD CONSTRAINT "journals_reversal_shape" CHECK ("ledger"."journals"."reverses_journal_id" is null or ("ledger"."journals"."source_type" = 'journal'
          and "ledger"."journals"."source_id" = "ledger"."journals"."reverses_journal_id"
          and split_part("ledger"."journals"."idempotency_key", ':', 3) = 'reversed'));