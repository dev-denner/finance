ALTER TABLE `purchase_items` ADD `reconciliation_previous_category_id` integer;--> statement-breakpoint
ALTER TABLE `purchases` ADD `transaction_id` integer REFERENCES transactions(id);--> statement-breakpoint
ALTER TABLE `purchases` ADD `reconciled_at` text;--> statement-breakpoint
ALTER TABLE `purchases` ADD `reconciliation_previous_category_id` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `purchases_transaction_id_uq` ON `purchases` (`transaction_id`);