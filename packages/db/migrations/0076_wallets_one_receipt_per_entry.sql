-- One receipt photo backs one cash entry (M08; D-197).
--
-- The ledger audit of the receipt upload found that a cash entry's receipt was
-- checked for purpose, visibility and upload status but never for reuse: one
-- ৳250 slip could stand behind any number of petty-cash entries, each under the
-- approval threshold. The service now refuses a receipt that already backs
-- another entry, or that someone else uploaded; this index is the floor under
-- the first check, so two entries racing for one slip cannot both be written.
CREATE UNIQUE INDEX "cash_entries_org_receipt_key" ON "wallets"."cash_entries" USING btree ("org_id","receipt_file_id") WHERE "wallets"."cash_entries"."receipt_file_id" is not null;