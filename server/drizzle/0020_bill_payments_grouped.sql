DROP INDEX `bill_payments_transaction_uq`;--> statement-breakpoint
CREATE UNIQUE INDEX `bill_payments_bill_transaction_uq` ON `bill_payments` (`bill_id`,`transaction_id`);--> statement-breakpoint
CREATE INDEX `bill_payments_transaction_idx` ON `bill_payments` (`transaction_id`);