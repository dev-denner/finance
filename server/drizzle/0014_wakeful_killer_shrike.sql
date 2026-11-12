PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_purchase_settlements` (
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
	FOREIGN KEY (`transaction_id`) REFERENCES `transactions`(`id`) ON UPDATE cascade ON DELETE set null,
	FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON UPDATE cascade ON DELETE restrict,
	CONSTRAINT "purchase_settlements_amount_check" CHECK("__new_purchase_settlements"."amount_cents" > 0),
	CONSTRAINT "purchase_settlements_type_check" CHECK(("__new_purchase_settlements"."settlement_type" = 'movement' and ("__new_purchase_settlements"."transaction_id" is not null or ("__new_purchase_settlements"."transaction_id" is null and "__new_purchase_settlements"."reversed_at" is not null))) or ("__new_purchase_settlements"."settlement_type" = 'wallet' and "__new_purchase_settlements"."transaction_id" is null))
);
--> statement-breakpoint
INSERT INTO `__new_purchase_settlements`("id", "purchase_id", "transaction_id", "payment_method_id", "amount_cents", "settlement_type", "effective_date", "reversed_at", "created_at") SELECT "id", "purchase_id", "transaction_id", "payment_method_id", "amount_cents", "settlement_type", "effective_date", "reversed_at", "created_at" FROM `purchase_settlements`;--> statement-breakpoint
DROP TABLE `purchase_settlements`;--> statement-breakpoint
ALTER TABLE `__new_purchase_settlements` RENAME TO `purchase_settlements`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_settlements_transaction_active_uq` ON `purchase_settlements` (`transaction_id`) WHERE "purchase_settlements"."transaction_id" is not null and "purchase_settlements"."reversed_at" is null;--> statement-breakpoint
CREATE INDEX `purchase_settlements_purchase_idx` ON `purchase_settlements` (`purchase_id`);--> statement-breakpoint
CREATE INDEX `purchase_settlements_payment_date_idx` ON `purchase_settlements` (`payment_method_id`,`effective_date`);