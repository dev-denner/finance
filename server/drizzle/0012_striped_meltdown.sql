CREATE TABLE `payment_balance_adjustments` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`payment_method_id` integer NOT NULL,
	`effective_date` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`reason` text NOT NULL,
	`description` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "payment_balance_adjustments_amount_check" CHECK("payment_balance_adjustments"."amount_cents" > 0),
	CONSTRAINT "payment_balance_adjustments_reason_check" CHECK("payment_balance_adjustments"."reason" in ('opening_balance', 'cashback', 'bonus', 'other'))
);
--> statement-breakpoint
CREATE INDEX `payment_balance_adjustments_account_date_idx` ON `payment_balance_adjustments` (`payment_method_id`,`effective_date`);--> statement-breakpoint
CREATE TABLE `purchase_settlements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`purchase_id` integer NOT NULL,
	`transaction_id` integer,
	`payment_method_id` integer NOT NULL,
	`amount_cents` integer NOT NULL,
	`settlement_type` text NOT NULL,
	`effective_date` text NOT NULL,
	`reversed_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) NOT NULL,
	FOREIGN KEY (`purchase_id`) REFERENCES `purchases`(`id`) ON UPDATE cascade ON DELETE cascade,
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE cascade ON DELETE restrict,
	FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "purchase_settlements_amount_check" CHECK("purchase_settlements"."amount_cents" > 0),
	CONSTRAINT "purchase_settlements_type_check" CHECK(("purchase_settlements"."settlement_type" = 'movement' and "purchase_settlements"."transaction_id" is not null) or ("purchase_settlements"."settlement_type" = 'wallet' and "purchase_settlements"."transaction_id" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_settlements_transaction_active_uq` ON `purchase_settlements` (`transaction_id`) WHERE `transaction_id` IS NOT NULL AND `reversed_at` IS NULL;--> statement-breakpoint
CREATE INDEX `purchase_settlements_purchase_idx` ON `purchase_settlements` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `purchase_settlements_payment_date_idx` ON `purchase_settlements` (`payment_method_id`, `effective_date`);--> statement-breakpoint
ALTER TABLE `payment_methods` ADD COLUMN `balance_type` text NOT NULL DEFAULT 'unclassified' CHECK (`balance_type` in ('credit', 'debit', 'wallet', 'unclassified'));--> statement-breakpoint
UPDATE `payment_methods` SET `balance_type` = 'credit' WHERE upper(trim(`name`)) LIKE 'CC%';--> statement-breakpoint
UPDATE `payment_methods` SET `balance_type` = 'debit' WHERE upper(trim(`name`)) LIKE 'CD%';--> statement-breakpoint
INSERT INTO `purchase_settlements` (`purchase_id`, `transaction_id`, `payment_method_id`, `amount_cents`, `settlement_type`, `effective_date`) SELECT `id`, `transaction_id`, (SELECT `payment_method_id` FROM `transactions` WHERE `transactions`.`id` = `purchases`.`transaction_id`), `total_cents`, 'movement', substr(`issued_at`, 1, 10) FROM `purchases` WHERE `transaction_id` IS NOT NULL;
